/**
 * 월간 리포트 → 텔레그램 자동 게시 (매월 첫 거래일 아침)
 *
 *   node scripts/telegram_monthly.js            # 실제 게시
 *   node scripts/telegram_monthly.js --dry-run  # 전송 안 함, 카드+캡션만 산출(검증)
 *   node scripts/telegram_monthly.js --force     # 첫 거래일/마커 검사 무시 강제
 *
 * 동작: ① report-summary.json 의 m1(최근 1달) 주도 섹터·테마 TOP5
 *       ② frequent_top 으로 '이달 단골 급등주' 6종
 *       ③ ORGO 리포트 카드 1장 렌더(자체 HTML) → sendPhoto
 * 게시 조건: 오늘이 이번 달 '첫 거래일'일 때만(백업 크론 대비 월 단위 마커). --force 로 무시.
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
const MARKER = path.resolve(DATA, '_telegram-monthly-posted.json');
const RAW = core.RAW;
const RAW_REPORT = 'https://orgo.kr/data/report-summary.json';

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-haiku-4-5-20251001').trim();

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
function prevMonthLabel(ymd) {
    var y = +ymd.slice(0, 4), m = +ymd.slice(4, 6);
    m -= 1; if (m < 1) { m = 12; y -= 1; }
    return y + '.' + ('0' + m).slice(-2);
}

async function aiComment(topSector, topTheme, monthLabel) {
    var summary = { 기간: monthLabel, 주도섹터: topSector || '없음', 주도테마: topTheme || '없음' };
    var prompt = '아래는 한국 주식시장 최근 한 달 주도 섹터·테마 요약이야. 텔레그램 채널 월간 리포트에 올릴 ' +
        '한 줄 멘트를 딱 한 문장(최대 40자)으로 써줘. 친근하고 위트있게, 이모지 1개 포함. ' +
        '숫자 반복 금지, 과장/투자권유/목표가 금지. 따옴표 없이 문장만.\n\n' + JSON.stringify(summary, null, 2);
    var fallback = topTheme ? ('지난 한 달은 ' + topTheme + ' 흐름이 굵직했네요 📈') : '지난 한 달도 수고 많으셨어요 📈';
    return tg.aiComment(prompt, ANTHROPIC_KEY, MODEL, fallback);
}

// 오늘이 이번 달 첫 거래일인가 (dates.json 기준)
async function isFirstTradingDay(today) {
    try {
        var dates = await core.fetchJson(RAW + '/dates.json');
        if (!Array.isArray(dates)) return false;
        var ym = today.slice(0, 6);
        var inMonth = dates.filter(function (d) { return d.slice(0, 6) === ym; }).sort();
        return inMonth.length > 0 && inMonth[0] === today;
    } catch (e) { return false; }
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
        if (!(await isFirstTradingDay(today))) { console.log('오늘(' + today + ')은 이번 달 첫 거래일 아님 — 스킵'); return; }
    }

    var report = await loadReport();
    var m = (report.periods && report.periods.m1) || {};
    var sectors = toRows(m.sector_top);
    var themes = toRows(m.theme_top);
    var chips = (m.frequent_top || []).slice(0, 6).map(function (f, i) {
        return { k: (i + 1) + '위', v: f.name + ' ' + (f.count || 0) + '회' };
    });

    var monthLabel = prevMonthLabel(today);
    var comment = await aiComment(sectors[0] && sectors[0].name, themes[0] && themes[0].name, monthLabel);

    var html = tg.rankCardHtml({
        title: '월간 리포트',
        dateRange: monthLabel,
        statLine: '최근 30일 ' + buildStatLine(m),
        sectors: sectors,
        themes: themes,
        extraLabel: '🔁 이달 단골 급등주 (다빈도)',
        extraChips: chips,
        footnote: '사실 데이터 · 투자판단은 본인 책임',
    });

    var caption = [
        '🗓️ 월간 시장 리포트 · ' + monthLabel,
        '',
        comment,
        '',
        '더 많은 데이터 → orgo.kr',
    ].join('\n');
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------');
    console.log('섹터:', sectors.map(function (s) { return s.name; }).join(',') || '-');
    console.log('테마:', themes.map(function (s) { return s.name; }).join(',') || '-');
    console.log('단골:', chips.map(function (c) { return c.v; }).join(' / ') || '-');

    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try { await tg.captureHtml(browser, html, { outPath: IMG }); }
    finally { await browser.close(); }
    console.log('이미지:', IMG);

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendPhoto(BOT_TOKEN, CHAT_ID, IMG, caption);
    var mid = r.result && r.result.message_id;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: monthKey, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
