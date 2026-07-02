/**
 * 10:00 오늘 핫테마 버블·트리 앨범 → 텔레그램 자동 게시 (평일 개장 1시간 후)
 *   (워크플로: telegram-movers.yml, 이벤트 tg-movers)
 *
 *   node scripts/telegram_movers.js [--dry-run|--force|--date=YYYYMMDD]
 *
 * 동작: flowmap mode=theme 의 버블·트리 2장(사이트 다운로드 워터마크 재사용)을 앨범으로,
 *       캡션은 상류 랭킹 buildGroups 기반 주도 섹터·테마 순위 + AI(소넷5) 한 줄.
 * 시크릿 미설정 시 no-op.
 */
'use strict';
const path = require('path');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');

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
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

// 주도 섹터·테마 순위(상류 랭킹 buildGroups)
function leadingGroups(rankings) {
    var active = (rankings || []).filter(function (r) { return core.isActive(r, core.RISE_CUTOFF); });
    return { sectors: core.buildGroups(active, 'sector').slice(0, 3), themes: core.buildGroups(active, 'theme').slice(0, 3) };
}

function buildThemeCaption(ymd, G, comment) {
    var lines = ['🔥 오늘 핫테마 · ' + tg.dateLabel(ymd) + ' ' + tg.hmKst(), ''];
    if (G.sectors.length) {
        lines.push('📈 주도 섹터');
        G.sectors.forEach(function (g, i) { lines.push((i + 1) + ' ' + g.key + ' ' + tg.pct(g.avgRate) + ' (' + g.count + '종목)'); });
        lines.push('');
    }
    if (G.themes.length) {
        lines.push('🏷️ 주도 테마');
        G.themes.forEach(function (g, i) { lines.push((i + 1) + ' ' + g.key + ' ' + tg.pct(g.avgRate) + ' (' + g.count + '종목)'); });
        lines.push('');
    }
    lines.push(comment);
    return lines.join('\n');
}

async function aiThemeComment(ymd, G) {
    var summary = {
        date: tg.dateLabel(ymd) + ' ' + tg.hmKst() + ' 장중',
        주도섹터: G.sectors.map(function (s) { return s.key + ' ' + tg.pct(s.avgRate); }).join(', ') || '없음',
        주도테마: G.themes.map(function (t) { return t.key + ' ' + tg.pct(t.avgRate); }).join(', ') || '없음',
    };
    var prompt = '아래는 한국 주식시장 오전(10시경) "장중 핫테마(주도 섹터·테마)" 요약이야. 텔레그램 채널 구독자에게 ' +
        '지금 어떤 테마·섹터가 시장을 달구는지 위트있게 한 줄로 정리해줘. 한 문장 45자 내외, 이모지 1개. ' +
        '센스있고 친근하게, 흐름이 드러나게. 숫자 나열 금지, 과장·투자권유·목표가 금지, 장중 미확정 뉘앙스 살짝. 따옴표 없이 문장만.\n\n' +
        JSON.stringify(summary, null, 2);
    var fallback = (G.themes[0] || G.sectors[0]) ? ('지금은 ' + (G.themes[0] || G.sectors[0]).key + ' 쪽이 달아오르네요 🔥') : '테마 흐름 지켜보는 중이에요 👀';
    return tg.aiComment(prompt, ANTHROPIC_KEY, MODEL, fallback);
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
        if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 핫테마 게시함 — 스킵'); return; }
    }

    var day = await core.fetchJson(RAW + '/' + today + '.json');
    var G = leadingGroups(day.rankings || []);
    if (!G.sectors.length && !G.themes.length) { console.log('오늘 주도 섹터·테마 없음 — 스킵'); return; }
    console.log('주도섹터:', G.sectors.map(function (s) { return s.key + ' ' + tg.pct(s.avgRate); }).join(' / ') || '(없음)');
    console.log('주도테마:', G.themes.map(function (t) { return t.key + ' ' + tg.pct(t.avgRate); }).join(' / ') || '(없음)');

    var comment = await aiThemeComment(today, G);
    var caption = buildThemeCaption(today, G, comment);
    console.log('\n----- 핫테마 캡션 -----\n' + caption + '\n----------------');

    var imgs = await tg.captureFlowmaps(PUBLIC, [
        { mode: 'theme', view: 'bubble', out: IMG_TB },
        { mode: 'theme', view: 'tree', out: IMG_TT },
    ]);
    console.log('핫테마 이미지:', imgs.join(', ') || '(실패)');
    if (!imgs.length) { console.log('핫테마 이미지 렌더 실패 — 스킵'); return; }

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, imgs, caption);
    var mid = Array.isArray(r.result) && r.result[0] ? r.result[0].message_id : null;
    console.log('핫테마 게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
