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
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

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

// 종목 한 줄 꼬리 — 구체적 이유(LLM 정제 우선)만 '— 이유'로, 애매하면 '[테마]' 폴백
// (제네릭 "OO 관련 뉴스"류를 쓰느니 생략 — 2026-07-20 사용자 요청)
var REASON_CLIP = 30;   // 캡션 이유 표시 상한(자) — LLM 정제 사유 상한과 동일
function reasonTail(m, refined) {
    var r = tg.specificReason((refined && refined[m.ticker]) || m.reason);
    if (r) return ' — ' + tg.clip(r, REASON_CLIP);
    return m.theme ? ' [' + tg.clip(m.theme, 12) + ']' : '';
}

// 캡션 — 종목마다 '이름(딥링크) +% — 이유' 한 줄. 채널 안에서 이유까지 읽히고,
// 이력·차트가 궁금하면 이름 탭 → 종목 상세(utm 측정)로 넘어가는 구조.
function buildCaption(ymd, movers, comment, refined) {
    var parts = [tg.escHtml('🚀 오늘의 주도주 TOP5 · ' + tg.dateLabel(ymd) + ' ' + tg.hmKst()), ''];
    movers.forEach(function (m, i) {
        parts.push(tg.escHtml((i + 1) + ' ') +
            tg.htmlLink(m.name, tg.orgoLink('/stock/' + m.ticker, 'intraday')) +
            tg.escHtml(' ' + tg.pct(m.rate) + reasonTail(m, refined)));
    });
    if (comment) { parts.push(''); parts.push(tg.escHtml(comment)); }   // 특이사항 없으면 멘트 줄 자체를 생략
    parts.push('');
    parts.push(tg.htmlLink('👉 오늘 오른 종목 전부 보기', tg.orgoLink('/rise.html', 'intraday')));
    var html = parts.join('\n');
    // sendPhoto 캡션 상한 방어 — HTML 원문이 상한을 넘으면 태그가 중간에 잘려 API 400 이 나므로
    // 종목 딥링크 없는 짧은 포맷으로 폴백(하단 링크 1개만 유지).
    if (html.length > tg.TG_CAPTION_MAX) {
        var plain = ['🚀 오늘의 주도주 TOP5 · ' + tg.dateLabel(ymd) + ' ' + tg.hmKst(), ''];
        movers.forEach(function (m, i) { plain.push((i + 1) + ' ' + m.name + ' ' + tg.pct(m.rate) + reasonTail(m, refined)); });
        if (comment) { plain.push(''); plain.push(comment); }
        html = tg.escHtml(plain.join('\n')) + '\n\n' + tg.htmlLink('👉 오늘 오른 종목 전부 보기', tg.orgoLink('/rise.html', 'intraday'));
    }
    return html;
}

// 후킹형 한 줄(첫 줄 재활용) — tg.aiHook 공용 규칙 사용
async function aiHook(ymd, movers) {
    var summary = {
        시각: tg.dateLabel(ymd) + ' ' + tg.hmKst() + ' 장중(개장 30분)',
        주도주: movers.slice(0, 5).map(function (m) { return m.name + ' ' + tg.pct(m.rate) + (m.theme ? '(' + m.theme + ')' : ''); }).join(', '),
    };
    var fallback = movers[0] ? ('개장 30분 기준 ' + (movers[0].theme || movers[0].name) + ' 쪽 강세예요') : '';
    return tg.aiHook('오늘의 주도주 TOP5(장중)', summary, ANTHROPIC_KEY, MODEL, fallback);
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = DATE_ARG || tg.ymdKst();
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

    var refined = await tg.fetchRefinedReasons(today);   // LLM 정제 사유 우선(없으면 raw 폴백)
    var comment = await aiHook(today, movers);
    var caption = buildCaption(today, movers, comment, refined);
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
