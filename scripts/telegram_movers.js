/**
 * 10:00 오늘 핫테마 버블·트리 앨범 → 텔레그램 자동 게시 (평일 개장 1시간 후)
 *   (워크플로: telegram-movers.yml, 이벤트 tg-movers)
 *
 *   node scripts/telegram_movers.js [--dry-run|--force|--date=YYYYMMDD]
 *
 * 동작: flowmap mode=theme 의 버블·트리 2장(사이트 다운로드 워터마크 재사용)을 앨범으로,
 *       캡션은 상류 랭킹 buildGroups 기반 주도 섹터·테마 데이터 관찰 + 다음 확인점.
 * 시크릿 미설정 시 no-op.
 */
'use strict';
const path = require('path');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');
const editorial = require('./tg_editorial.js');
const market = require('./tg_market.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DATE_ARG = ((process.argv.find(function (a) { return a.indexOf('--date=') === 0; }) || '').split('=')[1] || '').trim();
const PUBLIC = path.resolve(__dirname, '..', 'public');
const IMG_TB = path.resolve(__dirname, '..', 'telegram-movers-theme-bubble.png');   // 핫테마 버블
const IMG_TT = path.resolve(__dirname, '..', 'telegram-movers-theme-tree.png');     // 핫테마 트리
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-movers-posted.json');
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

// 주도 섹터·테마 순위(상류 랭킹 buildGroups)
function leadingGroups(rankings) {
    var active = (rankings || []).filter(function (r) { return core.isActive(r, core.RISE_CUTOFF); });
    return { sectors: core.buildGroups(active, 'sector').slice(0, 3), themes: core.buildGroups(active, 'theme').slice(0, 3) };
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = DATE_ARG || tg.ymdKst();
    if (!DATE_ARG && !FORCE) {
        // 휴장일 2중 가드 — 캘린더(공휴일) + 네이버 실측(임시휴장, 2026-07-17 사고 방어)
        if (!tg.isKrTradingDay(today)) { console.log('휴장일(' + today + ', 캘린더) — 스킵'); return; }
        var traded = await market.isKrTradedToday(today);
        if (!traded.ok) { console.log('휴장일(실측 거래일=' + traded.tradedYmd + ') — 스킵'); return; }
        var dates = await core.fetchJson(RAW + '/dates.json');
        var latest = Array.isArray(dates) && dates.length ? dates.slice().sort().slice(-1)[0] : '';
        if (latest !== today) { console.log('오늘(' + today + ') 장중 데이터 없음(최신=' + latest + ') — 스킵'); return; }
    }
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 핫테마 게시함 — 스킵'); return; }
    }

    var day = await core.fetchJson(RAW + '/' + today + '.json');
    var G = leadingGroups(day.rankings || []);
    if (!G.sectors.length && !G.themes.length) { console.log('오늘 주도 섹터·테마 없음 — 스킵'); return; }
    console.log('주도섹터:', G.sectors.map(function (s) { return s.key + ' ' + tg.pct(s.avgRate); }).join(' / ') || '(없음)');
    console.log('주도테마:', G.themes.map(function (t) { return t.key + ' ' + tg.pct(t.avgRate); }).join(' / ') || '(없음)');

    var caption = editorial.themes(today, G);
    console.log('\n----- 핫테마 캡션 -----\n' + caption + '\n----------------');

    var imgs = await tg.captureFlowmaps(PUBLIC, [
        { mode: 'theme', view: 'bubble', out: IMG_TB },
        { mode: 'theme', view: 'tree', out: IMG_TT },
    ], { date: today, day: day });
    console.log('핫테마 이미지:', imgs.join(', ') || '(실패)');
    if (!imgs.length) { console.log('핫테마 이미지 렌더 실패 — 스킵'); return; }

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, imgs, caption, { parse_mode: 'HTML' });
    var mid = Array.isArray(r.result) && r.result[0] ? r.result[0].message_id : null;
    console.log('핫테마 게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
