/**
 * 장중 시장 워치 → 텔레그램 (평일 장중 15분 주기, 텍스트 전용)
 *
 *   node scripts/telegram_market_watch.js               # 실제(시각/밴드 판단 후 필요 시 게시)
 *   node scripts/telegram_market_watch.js --dry-run     # 전송 안 함, 판단 로그 + 캡션 산출
 *   node scripts/telegram_market_watch.js --demo=lunch  # 점심 점검 캡션 강제 산출(검증)
 *   node scripts/telegram_market_watch.js --demo=alert  # 급변 알림 캡션 강제 산출(검증)
 *
 * 두 가지를 한 워크플로에서 처리(15분 주기 실행):
 *   ① 점심 점검  — KST 12:25~12:45 창의 첫 실행에서 1회. 오전장 시장 요약.
 *   ② 시장 급변  — 코스피/코스닥 절대 등락이 임계 밴드를 "상향 돌파"할 때만. 하루 상한.
 * 시장 관련만 다룬다(개별 급등 종목 포착은 범위 밖 — 사용자 지시).
 *
 * 중복/스팸 방지: public/data/_telegram-market.json 마커
 *   { date, lunchPosted, alertBand, alertCount }  — 날짜 바뀌면 리셋.
 * 필요한 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ANTHROPIC_API_KEY(선택)
 */
'use strict';
const path = require('path');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');
const market = require('./tg_market.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DEMO = ((process.argv.find(function (a) { return a.indexOf('--demo=') === 0; }) || '').split('=')[1] || '').trim();
const PUBLIC = path.resolve(__dirname, '..', 'public');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-market.json');

// ── 튜닝 상수 ──
const LUNCH_START_MIN = 12 * 60 + 25;   // 12:25 KST
const LUNCH_END_MIN = 12 * 60 + 45;     // 12:45 KST — 이 창의 첫 실행이 점심 점검 게시
const ALERT_BANDS = [2, 3, 5, 7];       // 절대 등락(%) 밴드 — 상향 돌파 시에만 알림
const ALERT_MAX_PER_DAY = 5;            // 하루 급변 알림 상한(스팸 방지)

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

function idxNum(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fxNum(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function kstMinutes() { var hm = tg.hmKst(); return (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5)); }

// 절대 등락 → 밴드(넘어선 최고 임계). 2% 미만이면 0.
function bandOf(absPct) {
    var b = 0;
    for (var i = 0; i < ALERT_BANDS.length; i++) if (absPct >= ALERT_BANDS[i]) b = ALERT_BANDS[i];
    return b;
}

// stock-rise raw 에서 오늘 오전 급등 폭(시장 브레드스) — 개별 종목명은 싣지 않는다.
async function fetchTodayBreadth(today) {
    try {
        var dates = await core.fetchJson(core.RAW + '/dates.json');
        var last = Array.isArray(dates) && dates.length ? dates.slice().sort().slice(-1)[0] : '';
        if (last !== today) return null;   // 아직 오늘 장중 파일 없음 → 생략
        var day = await core.fetchJson(core.RAW + '/' + today + '.json');
        var active = (day.rankings || []).filter(function (r) { return core.isActive(r, core.RISE_CUTOFF); });
        var themes = core.buildGroups(active, 'theme');
        return { riseCount: active.length, topTheme: themes[0] || null };
    } catch (e) { console.error('오늘 브레드스 실패(생략):', e.message); return null; }
}

// ── 점심 점검 캡션 ──
function lunchCaption(today, M, breadth, comment) {
    var lines = [];
    lines.push('🕐 점심 점검 (' + tg.dateLabel(today) + ' 12:30)');
    lines.push('');
    lines.push('📊 코스피 ' + idxNum(M.kospi.price) + ' (' + tg.pct(M.kospi.changePct) + ') · 코스닥 ' + idxNum(M.kosdaq.price) + ' (' + tg.pct(M.kosdaq.changePct) + ')');
    lines.push('상승 ' + M.upCount.toLocaleString('ko-KR') + ' · 하락 ' + M.downCount.toLocaleString('ko-KR') + ' · 거래대금 ' + tg.fmtAmount(M.tradingValueWon));
    if (breadth) {
        lines.push('급등(+' + core.RISE_CUTOFF + '%↑) ' + breadth.riseCount + '종목' +
            (breadth.topTheme ? ' · 주도테마 ' + breadth.topTheme.key + ' 평균 ' + tg.pct(breadth.topTheme.avgRate) : ''));
    }
    lines.push('');
    if (comment) { lines.push(comment); lines.push(''); }
    return tg.escHtml(lines.join('\n')) + tg.htmlLink('👉 지금 오르는 종목 보러가기', tg.orgoLink('/rise.html', 'lunch'));
}

// ── 급변 알림 캡션 ──
function alertCaption(today, M, band, comment) {
    var worst = Math.abs(M.kospi.changePct) >= Math.abs(M.kosdaq.changePct) ? M.kospi : M.kosdaq;
    var dir = worst.changePct < 0 ? '📉 급락' : '📈 급등';
    var lines = [];
    lines.push('⚠️ 시장 급변 · ' + dir + ' (' + tg.hmKst() + ' KST)');
    lines.push('');
    lines.push('코스피 ' + idxNum(M.kospi.price) + ' (' + tg.pct(M.kospi.changePct) + ')');
    lines.push('코스닥 ' + idxNum(M.kosdaq.price) + ' (' + tg.pct(M.kosdaq.changePct) + ')');
    lines.push('상승 ' + M.upCount.toLocaleString('ko-KR') + ' · 하락 ' + M.downCount.toLocaleString('ko-KR'));
    lines.push('');
    if (comment) { lines.push(comment); lines.push(''); }
    return tg.escHtml(lines.join('\n')) + tg.htmlLink('👉 지금 시장 보러가기', tg.orgoLink('/', 'alert'));
}

async function sendText(caption) {
    if (DRY || DEMO) { console.log('\n----- 캡션 -----\n' + caption + '\n----------------\n'); return null; }
    var r = await tg.sendMessage(BOT_TOKEN, CHAT_ID, caption, { parse_mode: 'HTML' });
    console.log('게시 완료 — message_id', r.result && r.result.message_id);
    return r;
}

async function main() {
    if (!DRY && !DEMO && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }
    var today = tg.ymdKst();
    var dow = new Date(Date.now() + 9 * 3600000).getUTCDay();
    if (!DEMO && !FORCE && (dow === 0 || dow === 6)) { console.log('주말 — 스킵'); return; }

    // 시장 시세 — 실패 시 이번 실행은 아무것도 안 함(다음 15분에 재시도)
    var M;
    try { M = await market.fetchKrMarketSummary(); }
    catch (e) { console.error('시장 시세 실패 — 이번 실행 스킵:', e.message); return; }

    // 휴장·시세 지연 방어: 시세 거래일이 오늘이 아니면 판단 안 함(휴일 오전 stale 방지)
    if (!DEMO && M.tradedYmd !== today) {
        console.log('시세 거래일(' + M.tradedYmd + ') ≠ 오늘(' + today + ') — 휴장/지연 추정, 스킵');
        return;
    }

    var mk = tg.loadMarker(MARKER);
    if (mk.date !== today) mk = { date: today, lunchPosted: false, alertBand: 0, alertCount: 0 };  // 날짜 리셋

    // ── DEMO: 강제 캡션 산출(마커·시각 무시) ──
    if (DEMO === 'lunch') {
        var bd = await fetchTodayBreadth(today);
        var c = await tg.aiHook('점심 점검(오전장 시장 요약)', { 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct), 상승: M.upCount, 하락: M.downCount }, ANTHROPIC_KEY, MODEL, '');
        await sendText(lunchCaption(today, M, bd, c));
        return;
    }
    if (DEMO === 'alert') {
        var band = bandOf(Math.max(Math.abs(M.kospi.changePct), Math.abs(M.kosdaq.changePct))) || ALERT_BANDS[0];
        var ca = await tg.aiHook('시장 급변 알림(지수 급변동)', { 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct), 밴드: band + '%' }, ANTHROPIC_KEY, MODEL, '');
        await sendText(alertCaption(today, M, band, ca));
        return;
    }

    var nowMin = kstMinutes();
    var changed = false;

    // ① 점심 점검 — 창 안 첫 실행 1회
    if (!mk.lunchPosted && nowMin >= LUNCH_START_MIN && nowMin <= LUNCH_END_MIN) {
        var breadth = await fetchTodayBreadth(today);
        var comment = await tg.aiHook('점심 점검(오전장 시장 요약)',
            { 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct), 상승: M.upCount, 하락: M.downCount },
            ANTHROPIC_KEY, MODEL, '');
        await sendText(lunchCaption(today, M, breadth, comment));
        mk.lunchPosted = true;
        changed = true;
    }

    // ② 시장 급변 — 밴드 상향 돌파 시에만, 하루 상한 내
    var curBand = bandOf(Math.max(Math.abs(M.kospi.changePct), Math.abs(M.kosdaq.changePct)));
    if (curBand > mk.alertBand && mk.alertCount < ALERT_MAX_PER_DAY) {
        var acomment = await tg.aiHook('시장 급변 알림(지수 급변동)',
            { 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct), 밴드: curBand + '%' },
            ANTHROPIC_KEY, MODEL, '');
        await sendText(alertCaption(today, M, curBand, acomment));
        mk.alertCount += 1;
        changed = true;
    }
    // 밴드는 완화돼도 내리지 않는다(같은 급락에서 등락 반복 시 재알림 방지). 상향만 갱신.
    if (curBand > mk.alertBand) mk.alertBand = curBand;

    // 게시가 없으면 마커도 안 건드린다(빈 실행마다 커밋 churn 방지). changed 일 때만 저장.
    if (changed) { if (!DRY) tg.saveMarker(MARKER, mk); }
    else { console.log('게시 조건 미충족(코스피 ' + tg.pct(M.kospi.changePct) + ' 코스닥 ' + tg.pct(M.kosdaq.changePct) + ', 밴드 ' + curBand + ', 점심게시 ' + mk.lunchPosted + ') — no-op'); }
}

main().catch(function (e) { console.error(e); process.exit(1); });
