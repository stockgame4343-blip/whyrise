/**
 * 09:30 장중 주도 섹터·테마 → 텔레그램 자동 게시 (평일 개장 30분 후)
 *
 *   node scripts/telegram_intraday_leaders.js            # 실제 게시
 *   node scripts/telegram_intraday_leaders.js --dry-run  # 전송 안 함, 이미지+캡션만 산출(검증)
 *   node scripts/telegram_intraday_leaders.js --force     # 마커 무시 강제
 *
 * 동작: ① stock-rise 당일(장중) 랭킹으로 주도 섹터·테마 TOP3 계산(캘린더 빌드 로직 재사용)
 *       ② 버블맵(bubbles2.html) + 트리맵(treemap.html) 정사각 이미지 2장 렌더(헤드리스 Chromium)
 *       ③ 캡션 마지막 한 줄은 Claude API(선택, 실패 시 템플릿)
 *       ④ Telegram sendMediaGroup 으로 앨범 게시
 *
 * 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ANTHROPIC_API_KEY(선택) / TELEGRAM_MODEL(선택)
 * 시크릿 미설정 시 조용히 no-op(워크플로 실패 대신).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PUBLIC = path.resolve(__dirname, '..', 'public');
const IMG_BUBBLE = path.resolve(__dirname, '..', 'telegram-intraday-bubble.png');
const IMG_TREE = path.resolve(__dirname, '..', 'telegram-intraday-tree.png');
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-intraday-posted.json');
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-haiku-4-5-20251001').trim();

const TOP_N = 3;   // 캡션에 노출할 섹터/테마 개수

// ── 주도 섹터·테마 계산 (사이트 report.js / 캘린더 빌드와 동일 로직) ──
function computeLeadingGroups(rankings) {
    var active = (rankings || []).filter(function (r) { return core.isActive(r, core.RISE_CUTOFF); });
    return {
        active: active.length,
        sectors: core.buildGroups(active, 'sector').slice(0, TOP_N),
        themes: core.buildGroups(active, 'theme').slice(0, TOP_N),
    };
}

function groupLines(groups) {
    return groups.map(function (g, i) {
        return (i + 1) + ' ' + g.key + ' ' + tg.pct(g.avgRate) + ' (' + g.count + '종목)';
    });
}

function buildCaption(ymd, G, comment) {
    var lines = [];
    lines.push('🌅 오늘 장중 주도 · ' + tg.dateLabel(ymd) + ' 09:30');
    lines.push('');
    if (G.sectors.length) {
        lines.push('📈 주도 섹터');
        groupLines(G.sectors).forEach(function (l) { lines.push(l); });
        lines.push('');
    }
    if (G.themes.length) {
        lines.push('🏷️ 주도 테마');
        groupLines(G.themes).forEach(function (l) { lines.push(l); });
        lines.push('');
    }
    if (!G.sectors.length && !G.themes.length) {
        lines.push('아직 뚜렷한 주도 그룹이 형성되기 전이에요. 개장 초반이라 변동이 큽니다.');
        lines.push('');
    }
    lines.push(comment);
    return lines.join('\n');
}

function templateComment(G) {
    var subj = (G.themes[0] && G.themes[0].key) || (G.sectors[0] && G.sectors[0].key);
    if (!subj) return '오늘 흐름 천천히 지켜보세요 👀';
    return '개장부터 ' + subj + ' 쪽이 눈에 띄네요 🚀';
}

async function aiComment(ymd, G) {
    var summary = {
        date: tg.dateLabel(ymd) + ' 09:30 장중',
        주도섹터: G.sectors.map(function (s) { return s.key + ' ' + tg.pct(s.avgRate); }).join(', ') || '없음',
        주도테마: G.themes.map(function (t) { return t.key + ' ' + tg.pct(t.avgRate); }).join(', ') || '없음',
    };
    var prompt = '아래는 한국 주식시장 개장 30분(09:30) "장중 주도 섹터·테마" 요약이야. 텔레그램 채널에 올릴 ' +
        '마지막 한 줄 멘트를 딱 한 문장(최대 40자)으로 써줘. 친근하고 위트있게, 이모지 1개 포함. ' +
        '숫자 반복 금지, 과장/투자권유/목표가 금지, 장중 미확정이라는 뉘앙스 살짝. 따옴표 없이 문장만.\n\n' +
        JSON.stringify(summary, null, 2);
    return tg.aiComment(prompt, ANTHROPIC_KEY, MODEL, templateComment(G));
}

// ── 버블맵 + 트리맵 렌더 (모바일 뷰포트 + 사이트 다운로드 기능 재사용 → 워터마크 포함) ──
async function renderImages() {
    var srv = await tg.servePublic(PUBLIC);
    var port = srv.address().port;
    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        // 모바일 뷰포트 — 사이트가 모바일 레이아웃으로 렌더 → 다운로드도 모바일에서 받은 것과 동일
        var ctx = await browser.newContext({
            viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
            isMobile: true, hasTouch: true, acceptDownloads: true,
        });
        var page = await ctx.newPage();
        await page.addInitScript(function () { try { localStorage.setItem('theme', 'dark'); } catch (e) {} });

        await page.goto('http://127.0.0.1:' + port + '/bubbles2.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await tg.saveViaBridge(page, IMG_BUBBLE);

        await page.goto('http://127.0.0.1:' + port + '/treemap.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await tg.saveViaBridge(page, IMG_TREE);
    } finally {
        await browser.close();
        srv.close();
    }
    return [IMG_BUBBLE, IMG_TREE];
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = tg.ymdKst();
    var dates = await core.fetchJson(RAW + '/dates.json');
    var latest = Array.isArray(dates) && dates.length ? dates.slice().sort().slice(-1)[0] : '';
    if (latest !== today) {
        console.log('오늘(' + today + ') 장중 데이터 없음(최신=' + latest + ') — 게시 스킵');
        return;
    }
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 장중 게시함 — 스킵'); return; }
    }

    var day = await core.fetchJson(RAW + '/' + today + '.json');
    var G = computeLeadingGroups(day.rankings || []);
    console.log('활성(>=' + core.RISE_CUTOFF + '%):', G.active,
        '| 섹터:', G.sectors.map(function (s) { return s.key; }).join(',') || '-',
        '| 테마:', G.themes.map(function (t) { return t.key; }).join(',') || '-');

    var comment = await aiComment(today, G);
    var caption = buildCaption(today, G, comment);
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------\n');

    var images = await renderImages();
    console.log('이미지:', images.join(', '));

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, images, caption);
    var mid = Array.isArray(r.result) && r.result[0] ? r.result[0].message_id : null;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
