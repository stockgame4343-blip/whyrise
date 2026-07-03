/**
 * 월간 리포트 → 텔레그램 자동 게시 (매월 마지막 거래일 장마감 후)
 *
 *   node scripts/telegram_monthly.js            # 실제 게시
 *   node scripts/telegram_monthly.js --dry-run  # 전송 안 함, 카드+캡션만 산출(검증)
 *   node scripts/telegram_monthly.js --force     # 마커 검사 무시 강제
 *
 * 동작: ① report-summary.json 의 m1(최근 1달) 주도 섹터·테마 TOP5
 *       ② frequent_top 으로 '이달 단골 급등주' 6종
 *       ③ ORGO 리포트 카드 + ④ 대장캘린더 모바일 다운로드 이미지 → sendMediaGroup(앨범)
 * 게시 조건: '이번 달 마지막 거래일'인지는 워크플로(scripts/is_last_trading_day.py, kr_holidays 반영)가 판정.
 *           스크립트는 월 단위 마커로 중복 방지만 담당. --force 로 마커 무시.
 *
 * 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ANTHROPIC_API_KEY(선택) / TELEGRAM_MODEL(선택)
 * 시크릿 미설정 시 조용히 no-op.
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
const DATA = path.resolve(PUBLIC, 'data');
const IMG = path.resolve(__dirname, '..', 'telegram-monthly.png');
const IMG_CAL = path.resolve(__dirname, '..', 'telegram-monthly-cal.png');
const MARKER = path.resolve(DATA, '_telegram-monthly-posted.json');
const RAW_REPORT = 'https://orgo.kr/data/report-summary.json';

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-sonnet-5').trim();

async function loadReport() {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, 'report-summary.json'), 'utf8')); }
    catch (e) { return core.fetchJson(RAW_REPORT); }
}

function toRows(list) {
    return (list || []).slice(0, 5).map(function (it) {
        var name = it.sector || it.theme || '';
        var n = it.tickers || it.count || 0;
        return { name: name, sub: n + '종목 · ' + tg.pct(it.avg_rate) };
    });
}
function buildStatLine(m) {
    var parts = [];
    if (m.total_events_15) parts.push('급등 ' + m.total_events_15 + '건');
    if (m.total_limit_count) parts.push('상한가 ' + m.total_limit_count);
    if (m.total_52w_count) parts.push('신고가 ' + m.total_52w_count);
    return parts.join(' · ');
}
function monthLabelOf(ymd) { return ymd.slice(0, 4) + '.' + ymd.slice(4, 6); }   // 해당 월(마지막 거래일 기준)

async function aiComment(topSector, topTheme, monthLabel) {
    var summary = { 기간: monthLabel, 주도섹터: topSector || '없음', 주도테마: topTheme || '없음' };
    var prompt = '아래는 한국 주식시장 최근 한 달 주도 섹터·테마 요약이야. 텔레그램 채널 월간 리포트 구독자에게 ' +
        '지난 한 달 시장 흐름을 담백하게 한 줄로 정리해줘. 한 문장 45자 내외, 이모지 0~1개. ' +
        '사실 서술만 — 호들갑·감탄·드라마화 금지, 평범한 달이면 평범하게. ' +
        '숫자 나열 금지, 과장·투자권유·목표가 금지. 따옴표 없이 문장만.\n\n' +
        JSON.stringify(summary, null, 2);
    var fallback = topTheme ? ('지난 한 달은 ' + topTheme + ' 쪽 상승이 잦았어요 📈') : '지난 한 달도 수고 많으셨어요 📈';
    return tg.aiComment(prompt, ANTHROPIC_KEY, MODEL, fallback);
}

// 대장캘린더(sample2.html #calGrid)를 모바일 뷰포트에서 '이미지 저장'(#calSave) 다운로드로 캡쳐
async function renderCalendar() {
    var srv = await tg.servePublic(PUBLIC);
    var port = srv.address().port;
    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        var ctx = await browser.newContext({
            viewport: { width: 460, height: 1000 }, deviceScaleFactor: 2,
            isMobile: true, hasTouch: true, acceptDownloads: true,
        });
        var page = await ctx.newPage();
        await page.addInitScript(function () { try { localStorage.setItem('theme', 'dark'); } catch (e) {} });
        await page.goto('http://127.0.0.1:' + port + '/sample2.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(function () { var g = document.getElementById('calGrid'); return g && g.children.length > 5; }, null, { timeout: 45000 });
        await page.waitForTimeout(1200);
        await tg.captureDownloadClick(page, '#calSave', IMG_CAL);
    } finally { await browser.close(); srv.close(); }
    return IMG_CAL;
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = tg.ymdKst();
    var monthKey = today.slice(0, 6);
    if (!FORCE && !DRY) {
        var mk = tg.loadMarker(MARKER);
        if (mk && mk.last === monthKey) { console.log('이미 이번 달(' + monthKey + ') 게시함 — 스킵'); return; }
        // '마지막 거래일' 판정은 워크플로(is_last_trading_day.py)가 담당 — 여기선 마커만 확인
    }

    var report = await loadReport();
    var m = (report.periods && report.periods.m1) || {};
    var sectors = toRows(m.sector_top);
    var themes = toRows(m.theme_top);
    var chips = (m.frequent_top || []).slice(0, 6).map(function (f, i) {
        return { k: (i + 1) + '위', v: f.name + ' ' + (f.count || 0) + '회' };
    });

    var monthLabel = monthLabelOf(today);
    var comment = await aiComment(sectors[0] && sectors[0].name, themes[0] && themes[0].name, monthLabel);

    var html = tg.rankCardHtml({
        title: '월간 리포트',
        dateRange: monthLabel,
        statLine: '최근 30일 ' + buildStatLine(m),
        sectors: sectors,
        themes: themes,
        extraLabel: '🔁 이달 단골 급등주 (다빈도)',
        extraChips: chips,
    });

    // 바로가기 — HTML 텍스트 링크(긴 URL 미노출). 본문은 통째로 이스케이프 후 링크만 붙인다.
    var caption = tg.escHtml([
        '🗓️ 월간 시장 리포트 · ' + monthLabel,
        '',
        comment,
        '',
    ].join('\n')) + '\n' + tg.htmlLink('👉 대장주 캘린더 보러가기', tg.orgoLink('/sample2.html', 'monthly'));
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------');
    console.log('섹터:', sectors.map(function (s) { return s.name; }).join(',') || '-');
    console.log('테마:', themes.map(function (s) { return s.name; }).join(',') || '-');
    console.log('단골:', chips.map(function (c) { return c.v; }).join(' / ') || '-');

    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try { await tg.captureHtml(browser, html, { outPath: IMG }); }
    finally { await browser.close(); }
    var images = [IMG];
    try { await renderCalendar(); images.push(IMG_CAL); }
    catch (e) { console.error('대장캘린더 렌더 실패(리포트 카드만 전송):', e.message); }
    console.log('이미지:', images.join(', '));

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendMediaGroup(BOT_TOKEN, CHAT_ID, images, caption, { parse_mode: 'HTML' });
    var mid = Array.isArray(r.result) && r.result[0] ? r.result[0].message_id : null;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: monthKey, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
