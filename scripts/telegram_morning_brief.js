/**
 * 장전 브리핑 → 텔레그램 자동 게시 (평일 아침, 텍스트 전용 — 이미지 없음)
 *
 *   node scripts/telegram_morning_brief.js            # 실제 게시
 *   node scripts/telegram_morning_brief.js --dry-run  # 전송 안 함, 캡션만 산출(검증용)
 *
 * 구성: ① 간밤 미국 마감(S&P·나스닥·다우·SOX·VIX) + 원/달러 — Yahoo chart API
 *       ② 전 거래일 국내 복기 — stock-rise raw(급등 종목수·상한가·대장주·핫테마, 캘린더 로직 재사용)
 *       ③ AI 한 줄(담백 규칙, 실패/특이사항 없음 시 생략)
 *
 * 필요한 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ANTHROPIC_API_KEY(선택)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');
const market = require('./tg_market.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PUBLIC = path.resolve(__dirname, '..', 'public');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-morning.json');   // 중복 게시 방지(크론 이중 발동)
const LIMIT_UP_CUTOFF = 29.5;   // 상한가 간주 기준(%) — report-core 와 동일 관행

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

// 소수 지수 표기 — 지수는 소수 2자리, 환율은 1자리
function idx(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fx(n) { return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function arrow(p) { return p > 0 ? '🔺' : p < 0 ? '🔻' : '⏸'; }

// ── 전 거래일 국내 복기 (stock-rise raw) ──
async function fetchYesterdayRecap() {
    var dates = await core.fetchJson(core.RAW + '/dates.json');
    if (!Array.isArray(dates) || !dates.length) return null;
    var last = dates.slice().sort().slice(-1)[0];
    var day = await core.fetchJson(core.RAW + '/' + last + '.json');
    var rows = day.rankings || [];
    var active = rows.filter(function (r) { return core.isActive(r, core.RISE_CUTOFF); });
    var limitUps = active.filter(function (r) { return core.num(r.change_rate) >= LIMIT_UP_CUTOFF; });
    var leader = core.pickLeader(rows);
    var themes = core.buildGroups(active, 'theme');
    return {
        ymd: last,
        riseCount: active.length,
        limitUpCount: limitUps.length,
        leader: leader,
        topTheme: themes[0] || null,
    };
}

// ── 캡션 ──
function buildCaption(todayYmd, quotes, fxQuote, recap, comment) {
    var lines = [];
    lines.push('🌅 장전 브리핑 (' + tg.dateLabel(todayYmd) + ')');
    lines.push('');
    if (quotes.length) {
        lines.push('🇺🇸 간밤 미국 마감');
        quotes.forEach(function (q) {
            lines.push(arrow(q.changePct) + ' ' + q.label + ' ' + idx(q.price) + ' (' + tg.pct(q.changePct) + ')');
        });
        lines.push('');
    }
    if (fxQuote) {
        lines.push('💱 ' + fxQuote.label + ' ' + fx(fxQuote.price) + '원 (' + tg.pct(fxQuote.changePct) + ')');
        lines.push('');
    }
    if (recap) {
        lines.push('📌 전 거래일 국내 (' + tg.mdLabel(recap.ymd) + ')');
        lines.push('급등(+' + core.RISE_CUTOFF + '%↑) ' + recap.riseCount + '종목 · 상한가 ' + recap.limitUpCount + '종목');
        if (recap.leader) {
            var t = core.themeOf(recap.leader) || String(recap.leader.sector || '').trim();
            lines.push('대장주 ' + recap.leader.name + ' ' + tg.pct(recap.leader.change_rate) + (t ? ' [' + t + ']' : ''));
        }
        if (recap.topTheme) {
            lines.push('핫테마 ' + recap.topTheme.key + ' 평균 ' + tg.pct(recap.topTheme.avgRate));
        }
        lines.push('');
    }
    if (comment) { lines.push(comment); lines.push(''); }
    var links = [
        tg.htmlLink('👉 오늘 시장 브리핑 보러가기', tg.orgoLink('/', 'morning')),
        tg.htmlLink('👉 어제 오른 종목 전부 보기', tg.orgoLink('/rise.html', 'morning')),
    ];
    return tg.escHtml(lines.join('\n')) + links.join('\n');
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }
    var today = tg.ymdKst();
    var dow = new Date(Date.now() + 9 * 3600000).getUTCDay();
    if (!DRY && !FORCE && (dow === 0 || dow === 6)) {
        console.log('주말(' + today + ') — 게시 스킵');
        return;
    }
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk.last === today) { console.log('이미 오늘(' + today + ') 게시함 — 스킵'); return; }
    }

    // ① 해외 시세 — 부분 실패는 성공분만, 전부 실패면 게시 자체를 중단(빈 브리핑 방지)
    var quotes = await market.fetchGlobalQuotes(market.GLOBAL_SYMBOLS);
    var fxQuote = null;
    try { fxQuote = await market.fetchGlobalQuote(market.FX_SYMBOL); }
    catch (e) { console.error('환율 실패:', e.message); }
    if (!quotes.length && !fxQuote) throw new Error('해외 시세 전체 실패 — 게시 중단');

    // ② 전 거래일 복기 — 실패해도 브리핑은 발송(블록 생략)
    var recap = null;
    try { recap = await fetchYesterdayRecap(); }
    catch (e) { console.error('국내 복기 실패(블록 생략):', e.message); }

    // ③ AI 한 줄 — 특이사항 없으면 생략
    var summary = {
        미국: quotes.map(function (q) { return q.label + ' ' + tg.pct(q.changePct); }).join(', '),
        환율: fxQuote ? (fx(fxQuote.price) + '원 ' + tg.pct(fxQuote.changePct)) : '',
        전거래일: recap ? ('급등 ' + recap.riseCount + '종목' + (recap.leader ? ', 대장주 ' + recap.leader.name : '')) : '',
    };
    var comment = await tg.aiHook('장전 브리핑(개장 전, 간밤 해외 마감 + 전 거래일 복기)', summary, ANTHROPIC_KEY, MODEL, '');

    var caption = buildCaption(today, quotes, fxQuote, recap, comment);
    console.log('----- 캡션 -----\n' + caption + '\n----------------');

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMessage(BOT_TOKEN, CHAT_ID, caption, { parse_mode: 'HTML' });
    console.log('게시 완료 — message_id', r.result && r.result.message_id);
    tg.saveMarker(MARKER, { last: today, message_id: r.result && r.result.message_id, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
