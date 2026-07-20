/**
 * 장중 시장 워치 → 텔레그램 (평일 장중 15분 주기, 텍스트 전용)
 *
 *   node scripts/telegram_market_watch.js                 # 실제(시각/속보/지수 판단 후 필요 시 게시)
 *   node scripts/telegram_market_watch.js --dry-run       # 전송 안 함, 판단 로그 + 캡션 산출
 *   node scripts/telegram_market_watch.js --demo=lunch    # 점심 점검 캡션 강제 산출(검증)
 *   node scripts/telegram_market_watch.js --demo=alert    # 서킷브레이커 캡션 강제 산출(검증)
 *   node scripts/telegram_market_watch.js --demo=sidecar  # 사이드카 캡션(최신 실제 속보 기반, 신선도 무시)
 *
 * 세 가지를 한 워크플로에서 처리(15분 주기 실행):
 *   ① 점심 점검     — KST 12:25~12:45 창의 첫 실행에서 1회. 오전장 시장 요약.
 *   ② 서킷브레이커  — 코스피/코스닥 현물 지수가 전일比 -8/-15/-20% 기준 도달 시. 하락만, 단계 심화 시에만.
 *   ③ 사이드카      — KRX 발동 속보를 Google 뉴스 RSS 로 감지(선물 시세 역산 대신 "실제 발동" 사실).
 *                     시장(코스피/코스닥) 단위로 하루 1회. 신선도 창(SIDECAR_FRESH_MIN) 내 속보만.
 * 시장 관련만 다룬다(개별 급등 종목 포착은 범위 밖 — 사용자 지시). VIX/환율은 공적 기준 없어 제외.
 *
 * 중복/스팸 방지: public/data/_telegram-market.json 마커
 *   { date, lunchPosted, cbStage, sidecarKeys:[] }  — 날짜 바뀌면 리셋.
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
// 서킷브레이커 발동 기준(한국거래소): 코스피/코스닥 현물 지수 전일比 하락. 하락만.
const CB_LEVELS = [8, 15, 20];          // -8%(1단계)/-15%(2단계)/-20%(3단계)
const CB_STAGE = { 8: '1단계', 15: '2단계', 20: '3단계' };
// 사이드카 속보 신선도 창(분) — 이 안에 발행된 발동 속보만 유효. GH Actions 지연 여유 포함.
const SIDECAR_FRESH_MIN = 60;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

function idxNum(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fxNum(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function kstMinutes() { var hm = tg.hmKst(); return (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5)); }

// 하락폭(양수 %) → 도달한 최고 서킷브레이커 단계 기준(%). -8% 미만 하락이면 0.
function cbLevelOf(dropPct) {
    var b = 0;
    for (var i = 0; i < CB_LEVELS.length; i++) if (dropPct >= CB_LEVELS[i]) b = CB_LEVELS[i];
    return b;
}
// 두 지수 중 가장 큰 하락폭(양수). 둘 다 상승이면 0.
function worstDrop(M) { return Math.max(0, -M.kospi.changePct, -M.kosdaq.changePct); }

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

// ── 서킷브레이커 알림 캡션 ──
function alertCaption(today, M, level, comment) {
    var lines = [];
    lines.push('🚨 서킷브레이커 ' + CB_STAGE[level] + ' 기준 도달 (-' + level + '%, ' + tg.hmKst() + ' KST)');
    lines.push('');
    lines.push('코스피 ' + idxNum(M.kospi.price) + ' (' + tg.pct(M.kospi.changePct) + ')');
    lines.push('코스닥 ' + idxNum(M.kosdaq.price) + ' (' + tg.pct(M.kosdaq.changePct) + ')');
    lines.push('상승 ' + M.upCount.toLocaleString('ko-KR') + ' · 하락 ' + M.downCount.toLocaleString('ko-KR'));
    lines.push('');
    if (comment) { lines.push(comment); lines.push(''); }
    return tg.escHtml(lines.join('\n')) + tg.htmlLink('👉 지금 시장 보러가기', tg.orgoLink('/', 'alert'));
}

// ── 사이드카 알림 캡션 ── (ev = fetchSidecarEvents 항목)
function sidecarCaption(today, M, ev, comment) {
    var dir = ev.direction ? ev.direction + ' ' : '';
    var lines = [];
    lines.push('🚨 ' + ev.market + ' ' + dir + '사이드카 발동 (' + tg.hmKst() + ' KST)');
    lines.push('');
    lines.push('코스피 ' + idxNum(M.kospi.price) + ' (' + tg.pct(M.kospi.changePct) + ')');
    lines.push('코스닥 ' + idxNum(M.kosdaq.price) + ' (' + tg.pct(M.kosdaq.changePct) + ')');
    lines.push('상승 ' + M.upCount.toLocaleString('ko-KR') + ' · 하락 ' + M.downCount.toLocaleString('ko-KR'));
    lines.push('');
    if (comment) { lines.push(comment); lines.push(''); }
    return tg.escHtml(lines.join('\n')) + tg.htmlLink('👉 지금 시장 보러가기', tg.orgoLink('/', 'sidecar'));
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
    // 주말+공휴일 캘린더 가드 (임시휴장은 아래 tradedYmd 실측 가드가 잡는다)
    if (!DEMO && !FORCE && !tg.isKrTradingDay(today)) { console.log('휴장일(' + today + ') — 스킵'); return; }

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
    if (mk.date !== today) mk = { date: today, lunchPosted: false, cbStage: 0, sidecarKeys: [] };  // 날짜 리셋
    if (!Array.isArray(mk.sidecarKeys)) mk.sidecarKeys = [];   // 구 마커 호환

    // ── DEMO: 강제 캡션 산출(마커·시각 무시) ──
    if (DEMO === 'lunch') {
        var bd = await fetchTodayBreadth(today);
        var c = await tg.aiHook('점심 점검(오전장 시장 요약)', { 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct), 상승: M.upCount, 하락: M.downCount }, ANTHROPIC_KEY, MODEL, '');
        await sendText(lunchCaption(today, M, bd, c));
        return;
    }
    if (DEMO === 'alert') {
        // 실제 -8% 발동일이 아닌 날의 포맷 미리보기 — 합성 -8.x% 수치로 자기일관성 있게 렌더.
        var demoM = { kospi: { price: M.kospi.price, changePct: -8.3 }, kosdaq: { price: M.kosdaq.price, changePct: -9.1 }, upCount: 210, downCount: 3600 };
        var ca = await tg.aiHook('서킷브레이커 발동 기준 도달(지수 -8% 급락)', { 코스피: tg.pct(demoM.kospi.changePct), 코스닥: tg.pct(demoM.kosdaq.changePct), 단계: '1단계(-8%)' }, ANTHROPIC_KEY, MODEL, '');
        await sendText(alertCaption(today, demoM, CB_LEVELS[0], ca));
        return;
    }
    if (DEMO === 'sidecar') {
        // 신선도 무시하고 최신 실제 사이드카 속보로 포맷 미리보기(없으면 합성).
        var evs = await market.fetchSidecarEvents(Infinity);
        var ev = evs[0] || { market: '코스피', direction: '매도', title: '(샘플) 매도 사이드카 발동' };
        console.log('감지 속보:', ev.title);
        var sc = await tg.aiHook('사이드카 발동(' + ev.market + ' ' + ev.direction + ')', { 시장: ev.market, 방향: ev.direction, 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct) }, ANTHROPIC_KEY, MODEL, '');
        await sendText(sidecarCaption(today, M, ev, sc));
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

    // ② 서킷브레이커 — 코스피/코스닥 현물 -8/-15/-20% 기준 도달 시, 단계 심화 때만(1→2→3)
    var curStage = cbLevelOf(worstDrop(M));
    if (curStage > mk.cbStage) {
        var acomment = await tg.aiHook('서킷브레이커 발동 기준 도달(지수 -' + curStage + '% 급락)',
            { 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct), 단계: CB_STAGE[curStage] + '(-' + curStage + '%)' },
            ANTHROPIC_KEY, MODEL, '');
        await sendText(alertCaption(today, M, curStage, acomment));
        mk.cbStage = curStage;   // 단계는 심화 때만 오른다(반등해도 안 내림 → 같은 급락 재알림 방지)
        changed = true;
    }

    // ③ 사이드카 — KRX 발동 속보(Google 뉴스) 감지. 시장 단위로 하루 1회.
    //    뉴스 fetch 실패는 이번 실행만 사이드카 스킵(CB·점심은 이미 위에서 처리됨).
    try {
        var events = await market.fetchSidecarEvents(SIDECAR_FRESH_MIN);
        for (var e = 0; e < events.length; e++) {
            var ev = events[e];
            if (mk.sidecarKeys.indexOf(ev.signature) >= 0) continue;   // 이미 알린 시장 → 스킵
            var scomment = await tg.aiHook('사이드카 발동(' + ev.market + ' ' + ev.direction + ')',
                { 시장: ev.market, 방향: ev.direction, 코스피: tg.pct(M.kospi.changePct), 코스닥: tg.pct(M.kosdaq.changePct) },
                ANTHROPIC_KEY, MODEL, '');
            await sendText(sidecarCaption(today, M, ev, scomment));
            mk.sidecarKeys.push(ev.signature);
            changed = true;
        }
    } catch (e2) { console.error('사이드카 감지 실패(이번 실행 스킵):', e2.message); }

    // 게시가 없으면 마커도 안 건드린다(빈 실행마다 커밋 churn 방지). changed 일 때만 저장.
    if (changed) { if (!DRY) tg.saveMarker(MARKER, mk); }
    else { console.log('게시 조건 미충족(코스피 ' + tg.pct(M.kospi.changePct) + ' 코스닥 ' + tg.pct(M.kosdaq.changePct) + ', 최대하락 ' + worstDrop(M).toFixed(1) + '%, CB단계 ' + (curStage || '없음') + ', 점심게시 ' + mk.lunchPosted + ') — no-op'); }
}

main().catch(function (e) { console.error(e); process.exit(1); });
