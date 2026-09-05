/**
 * 오늘의 대장 → 텔레그램 자동 게시 (매일 마감후)
 *
 *   node scripts/telegram_daily_leader.js            # 실제 게시
 *   node scripts/telegram_daily_leader.js --dry-run  # 전송 안 함, 이미지+캡션만 산출(검증용)
 *
 * 동작: ① ORGO 확정 랭킹 + 날짜별 대장 캘린더
 *       ② 정사각 이미지 렌더(홈 리포트 카드 캡쳐 방식, headless Chromium)
 *       ③ 전일 대비 변화와 다음 장 확인점을 데이터로 구성(API 비용 없음)
 *       ④ Telegram Bot API sendPhoto 로 채널 게시
 *
 * 필요한 환경변수(=GitHub Secrets):
 *   TELEGRAM_BOT_TOKEN   BotFather 봇 토큰
 *   TELEGRAM_CHAT_ID     채널 chat_id (또는 @publicchannel)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');
const editorial = require('./tg_editorial.js');
const market = require('./tg_market.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DATE_ARG = ((process.argv.find(function (a) { return a.indexOf('--date=') === 0; }) || '').split('=')[1] || '').trim();  // 샘플용 과거 날짜
const PUBLIC = path.resolve(__dirname, '..', 'public');
const OUT_IMG = path.resolve(__dirname, '..', 'telegram-daily.png');            // 1번: 대장 카드
const IMG_TB = path.resolve(__dirname, '..', 'telegram-daily-theme-bubble.png'); // 2번: 장마감 핫테마 버블
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-posted.json');  // 중복 게시 방지(크론 이중 발동)

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

function pct(v) { var n = num(v); return (n >= 0 ? '+' : '') + (Math.round(n * 10) / 10).toFixed(1) + '%'; }
function ymdKst() {
    var k = new Date(Date.now() + 9 * 3600000);
    return k.getUTCFullYear() + ('0' + (k.getUTCMonth() + 1)).slice(-2) + ('0' + k.getUTCDate()).slice(-2);
}
function dateLabel(ymd) {
    var y = ymd.slice(0, 4), m = ymd.slice(4, 6), d = ymd.slice(6, 8);
    var dow = WEEKDAY[new Date(+y, +m - 1, +d).getDay()];
    return y + '.' + m + '.' + d + ' ' + dow;
}

function detailTag(leader) {
    return core.themeOf(leader) || String(leader.sector || '').trim() || '대장';
}

// ── 정사각 이미지 렌더 (홈 리포트 카드 캡쳐 방식) ──
async function renderImage(ymd, L, refined) {
    function grp(g) { return g ? { name: g.key, count: g.count, avgRate: g.avgRate, top: g.top, topRate: g.topRate, vol: g.totalVolume } : null; }
    function ld(x) { return x ? { name: x.name, market: x.market, rate: x.change_rate, vol: x.trading_value, tag: detailTag(x), reason: tg.specificReason(refined && refined[x.ticker]) } : null; }
    var html = tg.leaderCardHtml({
        dateRange: dateLabel(ymd),
        leader: ld(L.leader),
        sector: grp(L.sector),
        theme: grp(L.theme),
    });
    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try { await tg.captureHtml(browser, html, { outPath: OUT_IMG }); }
    finally { await browser.close(); }
    return OUT_IMG;
}

// ── Telegram sendPhoto (multipart) ──
async function sendPhoto(imgPath, caption) {
    return tg.sendPhoto(BOT_TOKEN, CHAT_ID, imgPath, caption, { parse_mode: 'HTML' });
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;   // 시크릿 없으면 워크플로 실패(빨간 X) 대신 조용히 no-op
    }

    var today = DATE_ARG || ymdKst();
    if (!DATE_ARG && !FORCE) {   // 샘플(--date)·강제(--force) 가 아니면 거래일+데이터 가드
        // 휴장일 2중 가드 — 캘린더(공휴일) + 네이버 실측(임시휴장). 휴장일에 상류가
        // 전 거래일 복제 파일을 만들어도(2026-07-17 사고) 여기서 막힌다.
        if (!tg.isKrTradingDay(today)) { console.log('휴장일(' + today + ', 캘린더) — 게시 스킵'); return; }
        var traded = await market.isKrTradedToday(today);
        if (!traded.ok) { console.log('휴장일(실측 거래일=' + traded.tradedYmd + ') — 게시 스킵'); return; }
    }
    // 장 마감(종가 확정) 전 트리거 차단 — 마감 전엔 대장이 장중값으로 나가 마커를 선점(→진짜 15:45 종가 대장 스킵)하는 사고 방지.
    // 실발송에만 적용: --dry-run(검증)/--force/--date(샘플) 는 예외.
    if (!DRY && !DATE_ARG && !FORCE) {
        var hm = tg.hmKst();                      // "HH:MM" (KST)
        var nowMin = (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5));
        var CLOSE_GATE_MIN = 15 * 60 + 40;        // 15:40 KST — 종가 수집 여유 후에만 대장 확정 발송
        if (nowMin < CLOSE_GATE_MIN) {
            console.log('장 마감 전(' + hm + ' KST) — 종가 대장 확정 전이라 게시 스킵(15:40 이후 발송)');
            return;
        }
    }
    if (!DRY && !FORCE) {
        try {
            var mk = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
            if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 게시함 — 스킵'); return; }
        } catch (e) { /* 마커 없음 → 첫 게시 */ }
    }

    var day = editorial.finalSnapshot(PUBLIC, today);
    var L = editorial.calendarLeaders(PUBLIC, today, day);
    console.log('대장주:', L.leader ? (L.leader.name + ' ' + pct(L.leader.change_rate)) : '없음',
        '| 섹터:', L.sector && L.sector.key, '| 테마:', L.theme && L.theme.key);

    // 시장 요약(지수·상승하락·거래대금) — 시세 거래일이 캡션 날짜와 일치할 때만 싣는다.
    // (--date 과거 샘플이나 휴장일엔 오늘 시세가 붙는 사고 방지. 실패 시 블록 생략, 게시는 계속.)
    var M = null;
    try {
        var summary = await market.fetchKrMarketSummary();
        if (summary.tradedYmd === today) M = summary;
        else console.log('시장 요약 거래일(' + summary.tradedYmd + ') ≠ 캡션 날짜(' + today + ') — 블록 생략');
    } catch (e) { console.error('시장 요약 실패(블록 생략):', e.message); }

    var refined = await tg.fetchRefinedReasons(today);   // 날짜·근거 검증 사유만 사용
    if (L.leader && !day.rankings.some(function (r) { return r.ticker === L.leader.ticker && r.name === L.leader.name; })) delete refined[L.leader.ticker];
    var previous = editorial.previousSnapshot(PUBLIC, day);
    var caption = editorial.daily(today, L, M, refined, day, previous);
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------\n');

    await renderImage(today, L, refined);
    console.log('대장 카드:', OUT_IMG);

    // 장마감 핫테마(종가) 버블 — 대장 카드 뒤에 붙여 "장마감 핫테마 정리" 앨범 구성
    var themeImgs = await tg.captureFlowmaps(PUBLIC, [
        { mode: 'theme', view: 'bubble', out: IMG_TB },
    ], { date: today, day: day });
    console.log('핫테마 이미지:', themeImgs.join(', ') || '(실패 → 대장 카드만 발송)');

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var album = [OUT_IMG].concat(themeImgs);   // 대장카드 + 버블 (실패 시 대장카드만)
    var r = album.length > 1
        ? await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, album, caption, { parse_mode: 'HTML' })
        : await sendPhoto(OUT_IMG, caption);
    var mid = Array.isArray(r.result) ? (r.result[0] && r.result[0].message_id) : (r.result && r.result.message_id);
    console.log('게시 완료 — message_id', mid);
    // 중복 방지 마커 기록(워크플로가 커밋) — 같은 날 재실행 시 스킵됨
    fs.writeFileSync(MARKER, JSON.stringify({ last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) }) + '\n', 'utf8');
}

main().catch(function (e) { console.error(e); process.exit(1); });
