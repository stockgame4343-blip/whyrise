/**
 * 10:00 오늘의 주도주 TOP5 → 텔레그램 자동 게시 (평일 개장 1시간 후)
 *
 *   node scripts/telegram_movers.js            # 실제 게시
 *   node scripts/telegram_movers.js --dry-run  # 전송 안 함, 카드+캡션만 산출(검증)
 *   node scripts/telegram_movers.js --force     # 마커 무시 강제
 *   node scripts/telegram_movers.js --date=YYYYMMDD  # 샘플용 과거 날짜
 *
 * 동작: ① stock-rise 당일(장중) 랭킹에서 상승률+거래대금 '종합점수' 상위 5 (대장 알고리즘과 동일 공식,
 *          단 거래대금 3,000억 하한 없음 — 개장 초반엔 미달일 수 있으므로)
 *       ② 종목별 테마·상승이유 함께 카드로 렌더(자체 HTML)
 *       ③ 캡션 마지막 한 줄은 Claude(소넷5) → sendPhoto
 *
 * 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ANTHROPIC_API_KEY(선택) / TELEGRAM_MODEL(선택)
 * 시크릿 미설정 시 조용히 no-op.
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
const IMG = path.resolve(__dirname, '..', 'telegram-movers.png');
const IMG_TB = path.resolve(__dirname, '..', 'telegram-movers-theme-bubble.png');   // 핫테마 버블
const IMG_TT = path.resolve(__dirname, '..', 'telegram-movers-theme-tree.png');     // 핫테마 트리
const MARKER = path.resolve(PUBLIC, 'data', '_telegram-movers-posted.json');
const RAW = core.RAW;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

const TOP_N = 5;

// 주도주 TOP5 — pickLeader 와 동일한 종합점수(거래대금 70% + 상한상승률 30%). 단 거래대금 하한 없음.
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
    var lines = [];
    lines.push('🚀 오늘의 주도주 TOP5 · ' + tg.dateLabel(ymd) + ' ' + tg.hmKst());
    lines.push('');
    movers.forEach(function (m, i) {
        lines.push((i + 1) + ' ' + m.name + ' ' + tg.pct(m.rate) + (m.theme ? ' [' + m.theme + ']' : ''));
    });
    lines.push('');
    lines.push(comment);
    return lines.join('\n');
}

async function aiComment(ymd, movers) {
    var summary = {
        date: tg.dateLabel(ymd) + ' ' + tg.hmKst() + ' 장중',
        주도주: movers.slice(0, 5).map(function (m) { return m.name + ' ' + tg.pct(m.rate) + (m.theme ? '(' + m.theme + ')' : ''); }).join(', '),
    };
    var prompt = '아래는 한국 주식시장 개장 후(오전 10시경) "오늘의 주도주 TOP5" 요약이야. 텔레그램 채널 구독자에게 ' +
        '지금 시장에서 뭐가 주도하는지 위트있게 한 줄로 정리해줘. 한 문장 45자 내외, 이모지 1개. ' +
        '센스있고 친근하게, 흐름이 드러나게. 숫자 나열 금지, 과장·투자권유·목표가 금지, 장중 미확정 뉘앙스 살짝. 따옴표 없이 문장만.\n\n' +
        JSON.stringify(summary, null, 2);
    var fallback = movers[0] ? ('개장부터 ' + (movers[0].theme || movers[0].name) + ' 쪽에 눈길이 가네요 🚀') : '오늘 흐름 천천히 지켜보세요 👀';
    return tg.aiComment(prompt, ANTHROPIC_KEY, MODEL, fallback);
}

// ── 핫테마 버블·트리 앨범용: 섹터·테마 순위 캡션 ──
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
    var prompt = '아래는 한국 주식시장 오전 "장중 주도 섹터·테마" 요약이야. 텔레그램 채널 구독자에게 ' +
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
        if (mk && mk.last === today) { console.log('이미 오늘(' + today + ') 주도주 게시함 — 스킵'); return; }
    }

    var day = await core.fetchJson(RAW + '/' + today + '.json');
    var movers = toMovers(topMovers(day.rankings || []));
    if (!movers.length) { console.log('오늘 급등(>=' + core.RISE_CUTOFF + '%) 종목 없음 — 스킵'); return; }
    console.log('주도주:', movers.map(function (m) { return m.name + ' ' + tg.pct(m.rate); }).join(' / '));

    var comment = await aiComment(today, movers);
    var caption = buildCaption(today, movers, comment);
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------');

    // ① 주도주 TOP5 카드
    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        await tg.captureHtml(browser, tg.topMoversCardHtml({ dateRange: tg.dateLabel(today) + ' ' + tg.hmKst(), movers: movers }), { outPath: IMG });
    } finally { await browser.close(); }
    console.log('주도주 이미지:', IMG);

    // ② 핫테마 버블·트리 앨범 (별개 메시지) — 섹터·테마 순위 캡션
    var G = leadingGroups(day.rankings || []);
    var themeComment = await aiThemeComment(today, G);
    var themeCaption = buildThemeCaption(today, G, themeComment);
    console.log('\n----- 핫테마 캡션 -----\n' + themeCaption + '\n----------------');
    var themeImgs = await tg.captureFlowmaps(PUBLIC, [
        { mode: 'theme', view: 'bubble', out: IMG_TB },
        { mode: 'theme', view: 'tree', out: IMG_TT },
    ]);
    console.log('핫테마 이미지:', themeImgs.join(', ') || '(실패)');

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }

    // 1) 주도주 TOP5 (별개 메시지)
    var r = await tg.sendPhoto(BOT_TOKEN, CHAT_ID, IMG, caption);
    console.log('주도주 게시 완료 — message_id', r.result && r.result.message_id);
    // 2) 핫테마 버블·트리 (별개 메시지, 앨범)
    if (themeImgs.length) {
        var r2 = await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, themeImgs, themeCaption);
        console.log('핫테마 게시 완료 — message_id', Array.isArray(r2.result) && r2.result[0] ? r2.result[0].message_id : null);
    }
    tg.saveMarker(MARKER, { last: today, message_id: (r.result && r.result.message_id) || null, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
