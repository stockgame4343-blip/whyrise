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
 * 환경변수(=GitHub Secrets): TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 * 시크릿 미설정 시 조용히 no-op.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const core = require('./build_leaders_calendar.js');
const tg = require('./tg_common.js');
const editorial = require('./tg_editorial.js');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const PUBLIC = path.resolve(__dirname, '..', 'public');
const DATA = path.resolve(PUBLIC, 'data');
const IMG = path.resolve(__dirname, '..', 'telegram-weekly.png');
const MARKER = path.resolve(DATA, '_telegram-weekly-posted.json');
const RAW_REPORT = 'https://orgo.kr/data/report-summary.json';

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

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
    return (list || []).slice(0, 3).map(function (it) {
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
        if (d > today || !e) return null;
        if (!e.stock) return { k: WD[i], v: '대장 없음' };
        return { k: WD[i], v: e.stock.name + ' ' + tg.pct(e.stock.rate) };
    }).filter(Boolean);

    var end = today < wk[4] ? today : wk[4];
    var range = tg.mdLabel(wk[0]) + '~' + tg.mdLabel(end);
    var comment = editorial.calendarObservation(cal, wk[0], end) + '\n순위 카드는 최신 기록 기준 최근 7일, 대장 기록은 위 날짜 범위예요.\n다음 주 확인: 같은 대장이 반복되는지, 새로운 이름이 등장하는지.';

    var html = tg.rankCardHtml({
        title: '주간 리포트',
        dateRange: range,
        statLine: '최근 7일 ' + buildStatLine(w),
        sectors: sectors,
        themes: themes,
        extraLabel: '⭐ 이번 주 대장 (일별)',
        extraChips: chips,
    });

    // 바로가기 — HTML 텍스트 링크(긴 URL 미노출). 본문은 통째로 이스케이프 후 링크만 붙인다.
    var head = ['📅 이번 주 시장 리포트 · ' + range, ''];
    if (comment) { head.push(comment); head.push(''); }   // 특이사항 없으면 멘트 줄 자체를 생략
    var caption = tg.escHtml(head.join('\n')) + '\n' +
        tg.htmlLink('👉 주간 흐름 자세히 보기', tg.orgoLink('/report.html', 'weekly'));
    console.log('\n----- 캡션 -----\n' + caption + '\n----------------');
    console.log('섹터:', sectors.map(function (s) { return s.name; }).join(',') || '-');
    console.log('테마:', themes.map(function (s) { return s.name; }).join(',') || '-');
    console.log('일별대장:', chips.map(function (c) { return c.k + ':' + c.v; }).join(' / ') || '-');

    var browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try { await tg.captureHtml(browser, html, { outPath: IMG }); }
    finally { await browser.close(); }
    console.log('이미지:', IMG);

    if (DRY) { console.log('[dry-run] 전송 생략'); return; }
    var r = await tg.sendPhoto(BOT_TOKEN, CHAT_ID, IMG, caption, { parse_mode: 'HTML' });
    var mid = r.result && r.result.message_id;
    console.log('게시 완료 — message_id', mid);
    tg.saveMarker(MARKER, { last: weekId, message_id: mid, at: new Date().toISOString().slice(0, 19) });
}

main().catch(function (e) { console.error(e); process.exit(1); });
