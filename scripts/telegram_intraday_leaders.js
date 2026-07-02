/**
 * 09:30 오늘의 주도주 TOP5 → 텔레그램 자동 게시 (평일 개장 30분 후)
 *   (워크플로: telegram-intraday.yml, 이벤트 tg-intraday)
 *
 *   node scripts/telegram_intraday_leaders.js [--dry-run|--force|--date=YYYYMMDD]
 *
 * 동작: stock-rise 당일 랭킹에서 상승률+거래대금 '종합점수'(대장 알고리즘 동일 공식, 거래대금 하한 없음)
 *       상위 5 + 종목별 테마·이유를 카드로 렌더 → sendPhoto.
 * 시크릿 미설정 시 no-op.
 */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DATE_ARG = ((process.argv.find(function (a) { return a.indexOf('--date=') === 0; }) || '').split('=')[1] || '').trim();
const PUBLIC = path.resolve(__dirname, '..', 'public');
const IMG = path.resolve(__dirname, '..', 'telegram-intraday.png');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-intraday-posted.json');
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

const TOP_N = 5;

// 주도주 TOP5 — pickLeader 와 동일 종합점수(거래대금 70% + 상한상승률 30%). 거래대금 하한 없음.
function topMovers(rankings) {
    var cands = (rankings || []).filter(function (r) { return core.isActive(r, core.RISE_CUTOFF) && core.num(r.trading_value) > 0; });
    if (!cands.length) return [];
    var maxVol = Math.max.apply(null, cands.map(function (r) { return core.num(r.trading_value); }));
    var maxChg = Math.max.apply(null, cands.map(function (r) { return core.capRate(r); }));
    function score(r) {
        var v = maxVol > 0 ? core.num(r.trading_value) / maxVol : 0;
        var c = maxChg > 0 ? core.capRate(r) / maxChg : 0;
        return v * 70 + c * 30;
    }
    return cands.slice().sort(function (a, b) {
        return score(b) - score(a) || core.num(b.trading_value) - core.num(a.trading_value);
    }).slice(0, TOP_N);
}

function toMovers(rows) {
    return rows.map(function (r) {
        return {
            name: r.name, market: r.market, rate: core.num(r.change_rate),
            vol: core.num(r.trading_value), theme: core.themeOf(r), reason: String(r.rise_reason || '').trim(),
        };
    });
}

function buildCaption(ymd, movers, comment) {
    var lines = ['🚀 오늘의 주도주 TOP5 · ' + tg.dateLabel(ymd) + ' ' + tg.hmKst(), ''];
    movers.forEach(function (m, i) {
        lines.push((i + 1) + ' ' + m.name + ' ' + tg.pct(m.rate) + (m.theme ? ' [' + m.theme + ']' : ''));
    });
    lines.push('');
    lines.push(comment);
    return lines.join('\n');
}

// 후킹형 한 줄(첫 줄 재활용) — tg.aiHook 공용 규칙 사용
async function aiHook(ymd, movers) {
    var summary = {
        시각: tg.dateLabel(ymd) + ' ' + tg.hmKst() + ' 장중(개장 30분)',
        주도주: movers.slice(0, 5).map(function (m) { return m.name + ' ' + tg.pct(m.rate) + (m.theme ? '(' + m.theme + ')' : ''); }).join(', '),
    };
    var fallback = movers[0] ? ('개장 30분, ' + (movers[0].theme || movers[0].name) + '이 벌써 판을 흔드네요 🚀') : '오늘 흐름 천천히 지켜보세요 👀';
    return tg.aiHook('오늘의 주도주 TOP5(장중)', summary, ANTHROPIC_KEY, MODEL, fallback);
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = DATE_ARG || tg.ymdKst();
    if (!DATE_ARG) {
        var dates = await core.fetchJson(RAW + '/dates.json');
        var latest = Array.isArray(dates) && dates.length ? dates.slice().sort().slice(-1)[0] : '';
        if (latest !== today) { console.log('오늘(' + today + ') 장중 데이터 없음(최신=' + latest + ') — 스킵'); return; }
    }
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 주도주 게시함 — 스킵'); return; }
    }

    var day = await core.fetchJson(RAW + '/' + today + '.json');
    var movers = toMovers(topMovers(day.rankings || []));
    if (!movers.length) { console.log('오늘 급등(>=' + core.RISE_CUTOFF + '%) 종목 없음 — 스킵'); return; }
    console.log('주도주:', movers.map(function (m) { return m.name + ' ' + tg.pct(m.rate); }).join(' / '));

    var comment = await aiHook(today, movers);
    var caption = buildCaption(today, movers, comment);
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------');

    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        await tg.captureHtml(browser, tg.topMoversCardHtml({ dateRange: tg.dateLabel(today) + ' ' + tg.hmKst(), movers: movers }), { outPath: IMG });
    } finally { await browser.close(); }
    console.log('이미지:', IMG);

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendPhoto(BOT_TOKEN, CHAT_ID, IMG, caption);
    var mid = r.result && r.result.message_id;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
