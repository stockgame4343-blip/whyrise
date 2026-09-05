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
const editorial = require('./tg_editorial.js');
const market = require('./tg_market.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DATE_ARG = ((process.argv.find(function (a) { return a.indexOf('--date=') === 0; }) || '').split('=')[1] || '').trim();
const PUBLIC = path.resolve(__dirname, '..', 'public');
const IMG = path.resolve(__dirname, '..', 'telegram-intraday.png');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-intraday-posted.json');
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

const TOP_N = 5;

// 주도주 TOP5 — 대장주와 동일 '상승 에너지'(거래대금×상한상승률) 순. 거래대금 하한 없음.
function topMovers(rankings) {
    var cands = (rankings || []).filter(function (r) { return core.isActive(r, core.RISE_CUTOFF) && core.num(r.trading_value) > 0; });
    return cands.slice().sort(function (a, b) {
        return core.leaderEnergy(b) - core.leaderEnergy(a) || core.num(b.trading_value) - core.num(a.trading_value);
    }).slice(0, TOP_N);
}

function toMovers(rows) {
    return rows.map(function (r) {
        return {
            ticker: r.ticker,
            name: r.name, market: r.market, rate: core.num(r.change_rate),
            vol: core.num(r.trading_value), theme: core.themeOf(r), reason: String(r.rise_reason || '').trim(),
        };
    });
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = DATE_ARG || tg.ymdKst();
    if (!DRY && !DATE_ARG && !FORCE && (tg.hmKst() < '09:30' || tg.hmKst() >= '11:00')) {
        console.log('장중 주도 게시 시간 밖 — 스킵'); return;
    }
    if (!DATE_ARG && !FORCE) {
        // 휴장일 2중 가드 — 캘린더(공휴일) + 네이버 실측(임시휴장). 휴장일에 상류가
        // 전 거래일 복제 파일을 만들어도(2026-07-17 사고) 여기서 막힌다.
        if (!tg.isKrTradingDay(today)) { console.log('휴장일(' + today + ', 캘린더) — 스킵'); return; }
        var traded = await market.isKrTradedToday(today);
        if (!traded.ok) { console.log('휴장일(실측 거래일=' + traded.tradedYmd + ') — 스킵'); return; }
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

    var refined = await tg.fetchRefinedReasons(today);   // 날짜·근거 검증 사유만 사용
    movers.forEach(function (m) { m.reason = tg.specificReason(refined[m.ticker]); });
    var caption = editorial.intraday(today, movers, refined);
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------');

    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        await tg.captureHtml(browser, tg.topMoversCardHtml({ dateRange: tg.dateLabel(today) + ' ' + tg.hmKst(), movers: movers }), { outPath: IMG });
    } finally { await browser.close(); }
    console.log('이미지:', IMG);

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendPhoto(BOT_TOKEN, CHAT_ID, IMG, caption, { parse_mode: 'HTML' });
    var mid = r.result && r.result.message_id;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
