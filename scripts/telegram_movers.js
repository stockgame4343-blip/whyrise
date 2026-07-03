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
    if (comment) { lines.push(comment); lines.push(''); }   // 특이사항 없으면 멘트 줄 자체를 생략
    // 바로가기 — HTML 텍스트 링크(긴 URL 미노출). 본문은 통째로 이스케이프 후 링크만 붙인다.
    return tg.escHtml(lines.join('\n')) + '\n' +
        tg.htmlLink('👉 섹터·테마 한눈에 보기', tg.orgoLink('/leaders2.html', 'movers'));
}

// 후킹형 한 줄(첫 줄 재활용) — tg.aiHook 공용 규칙 사용
async function aiHook(ymd, G) {
    var summary = {
        시각: tg.dateLabel(ymd) + ' ' + tg.hmKst() + ' 장중(개장 1시간)',
        주도섹터: G.sectors.map(function (s) { return s.key + ' ' + tg.pct(s.avgRate) + '(' + s.count + '종목)'; }).join(', ') || '없음',
        주도테마: G.themes.map(function (t) { return t.key + ' ' + tg.pct(t.avgRate) + '(' + t.count + '종목)'; }).join(', ') || '없음',
    };
    var fallback = (G.themes[0] || G.sectors[0]) ? ('장 초반 ' + (G.themes[0] || G.sectors[0]).key + ' 쪽 상승이 많아요') : '';
    return tg.aiHook('오늘 핫테마(주도 섹터·테마, 장중)', summary, ANTHROPIC_KEY, MODEL, fallback);
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

    var comment = await aiHook(today, G);
    var caption = buildThemeCaption(today, G, comment);
    console.log('\n----- 핫테마 캡션 -----\n' + caption + '\n----------------');

    var imgs = await tg.captureFlowmaps(PUBLIC, [
        { mode: 'theme', view: 'bubble', out: IMG_TB },
        { mode: 'theme', view: 'tree', out: IMG_TT },
    ]);
    console.log('핫테마 이미지:', imgs.join(', ') || '(실패)');
    if (!imgs.length) { console.log('핫테마 이미지 렌더 실패 — 스킵'); return; }

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, imgs, caption, { parse_mode: 'HTML' });
    var mid = Array.isArray(r.result) && r.result[0] ? r.result[0].message_id : null;
    console.log('핫테마 게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
