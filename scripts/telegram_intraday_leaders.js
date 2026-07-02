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
const IMG = path.resolve(__dirname, '..', 'telegram-intraday-rise.png');   // 상승률 트리(flowmap rise/tree)
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-intraday-posted.json');
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

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

// 09:30 상승률 트리용 짧은 캡션 (섹터·테마 순위는 10:00 핫테마 앨범으로 이동)
function buildCaption(ymd, comment) {
    return ['🌅 오늘 장중 상승 흐름 · ' + tg.dateLabel(ymd) + ' ' + tg.hmKst(), '', comment].join('\n');
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
    var prompt = '아래는 한국 주식시장 개장 30분(09:30) "장중 주도 섹터·테마" 요약이야. 텔레그램 채널 구독자에게 ' +
        '오늘 개장 분위기를 위트있게 한 줄로 정리해줘. 한 문장 45자 내외, 이모지 1개. ' +
        '센스있고 친근하게, 어떤 흐름인지 자연스럽게 드러나게. 숫자 나열 금지, 과장·투자권유·목표가 금지, ' +
        '장중 미확정 뉘앙스 살짝. 따옴표 없이 문장만.\n\n' +
        JSON.stringify(summary, null, 2);
    return tg.aiComment(prompt, ANTHROPIC_KEY, MODEL, templateComment(G));
}

// ── 상승률 트리 렌더 (flowmap rise/tree — 급등주 기반, 모바일 다운로드 워터마크 방식) ──
async function renderImage() {
    var done = await tg.captureFlowmaps(PUBLIC, [{ mode: 'rise', view: 'tree', out: IMG }]);
    return done[0] || null;
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
    var caption = buildCaption(today, comment);
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------\n');

    var img = await renderImage();
    console.log('이미지:', img);

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendPhoto(BOT_TOKEN, CHAT_ID, img, caption);
    var mid = r.result && r.result.message_id;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: today, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
