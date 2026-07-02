/**
 * 주간 리포트 → 텔레그램 자동 게시 (금요일 마감후)
 *
 *   node scripts/telegram_weekly.js            # 실제 게시
 *   node scripts/telegram_weekly.js --dry-run  # 전송 안 함, 카드+캡션만 산출(검증)
 *   node scripts/telegram_weekly.js --force     # 마커 무시 강제
 *
 * 동작: ① report-summary.json 의 w1(최근 1주) 주도 섹터·테마 TOP5
 *       ② leaders-calendar.json 에서 이번 주(월~금) 일별 대장주
 *       ③ ORGO 리포트 카드 1장 렌더(자체 HTML, 헤드리스 Chromium)
 *       ④ Telegram sendPhoto 게시
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
const IMG = path.resolve(__dirname, '..', 'telegram-weekly.png');
const MARKER = path.resolve(DATA, '_telegram-weekly-posted.json');
const RAW_REPORT = 'https://orgo.kr/data/report-summary.json';

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.TELEGRAM_MODEL || 'claude-haiku-4-5-20251001').trim();

// 로컬 우선(빌드 직후 최신), 실패 시 라이브 fetch
async function loadReport() {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, 'report-summary.json'), 'utf8')); }
    catch (e) { return core.fetchJson(RAW_REPORT); }
}
function loadCalendar() {
    try { return (JSON.parse(fs.readFileSync(path.join(DATA, 'leaders-calendar.json'), 'utf8')) || {}).days || {}; }
    catch (e) { return {}; }
}

// 이번 주 월~금 날짜(YYYYMMDD)
function weekDates(ymd) {
    var y = +ymd.slice(0, 4), m = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
    var dt = new Date(Date.UTC(y, m, d));
    var dow = dt.getUTCDay();                 // 0=일 .. 6=토
    var monOff = (dow === 0 ? -6 : 1 - dow);  // 이번 주 월요일까지 offset
    var out = [];
    for (var i = 0; i < 5; i++) {
        var x = new Date(dt); x.setUTCDate(dt.getUTCDate() + monOff + i);
        out.push(x.getUTCFullYear() + ('0' + (x.getUTCMonth() + 1)).slice(-2) + ('0' + x.getUTCDate()).slice(-2));
    }
    return out;
}

function toRows(list) {
    return (list || []).slice(0, 5).map(function (it) {
        var name = it.sector || it.theme || '';
        var n = it.tickers || it.count || 0;
        return { name: name, sub: n + '종목 · ' + tg.pct(it.avg_rate) };
    });
}

function buildStatLine(w) {
    var parts = [];
    if (w.total_events_15) parts.push('급등 ' + w.total_events_15 + '건');
    if (w.total_limit_count) parts.push('상한가 ' + w.total_limit_count);
    if (w.total_52w_count) parts.push('신고가 ' + w.total_52w_count);
    return parts.join(' · ');
}

async function aiComment(topSector, topTheme) {
    var summary = { 주도섹터: topSector || '없음', 주도테마: topTheme || '없음' };
    var prompt = '아래는 한국 주식시장 이번 주 주도 섹터·테마 요약이야. 텔레그램 채널 주간 리포트에 올릴 ' +
        '한 줄 멘트를 딱 한 문장(최대 40자)으로 써줘. 친근하고 위트있게, 이모지 1개 포함. ' +
        '숫자 반복 금지, 과장/투자권유/목표가 금지, 주말 인사 톤 살짝. 따옴표 없이 문장만.\n\n' +
        JSON.stringify(summary, null, 2);
    var fallback = topTheme ? ('이번 주는 ' + topTheme + ' 쪽이 뜨거웠네요. 좋은 주말 보내세요 🙌')
        : '한 주 수고하셨어요. 좋은 주말 보내세요 🙌';
    return tg.aiComment(prompt, ANTHROPIC_KEY, MODEL, fallback);
}

async function main() {
    if (!DRY && (!BOT_TOKEN || !CHAT_ID)) {
        console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 게시 스킵(시크릿 등록 후 자동 동작).');
        return;
    }

    var today = tg.ymdKst();
    var wk = weekDates(today);
    var weekId = wk[0];   // 이번 주 월요일 = 주 식별자
    if (!DRY && !FORCE) {
        var mk = tg.loadMarker(MARKER);
        if (mk && mk.last === weekId) { console.log('이미 이번 주(' + weekId + ') 게시함 — 스킵'); return; }
    }

    var report = await loadReport();
    var w = (report.periods && report.periods.w1) || {};
    var sectors = toRows(w.sector_top);
    var themes = toRows(w.theme_top);

    // 이번 주 일별 대장주 (있는 날만)
    var cal = loadCalendar();
    var WD = ['월', '화', '수', '목', '금'];
    var chips = wk.map(function (d, i) {
        var e = cal[d];
        if (!e || !e.stock) return null;
        return { k: WD[i], v: e.stock.name + ' ' + tg.pct(e.stock.rate) };
    }).filter(Boolean);

    var range = tg.mdLabel(wk[0]) + '~' + tg.mdLabel(wk[4]);
    var comment = await aiComment(sectors[0] && sectors[0].name, themes[0] && themes[0].name);

    var html = tg.rankCardHtml({
        title: '주간 리포트',
        dateRange: range,
        statLine: '이번 주 ' + buildStatLine(w),
        sectors: sectors,
        themes: themes,
        extraLabel: '⭐ 이번 주 대장 (일별)',
        extraChips: chips,
        footnote: '사실 데이터 · 투자판단은 본인 책임',
    });

    var caption = [
        '📅 이번 주 시장 리포트 · ' + range,
        '',
        comment,
        '',
        '더 많은 데이터 → orgo.kr',
    ].join('\n');
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------');
    console.log('섹터:', sectors.map(function (s) { return s.name; }).join(',') || '-');
    console.log('테마:', themes.map(function (s) { return s.name; }).join(',') || '-');
    console.log('일별대장:', chips.map(function (c) { return c.k + ':' + c.v; }).join(' / ') || '-');

    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try { await tg.captureHtml(browser, html, { outPath: IMG }); }
    finally { await browser.close(); }
    console.log('이미지:', IMG);

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendPhoto(BOT_TOKEN, CHAT_ID, IMG, caption);
    var mid = r.result && r.result.message_id;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: weekId, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
