/**
 * 텔레그램 자동 게시 공용 모듈 (whyorgo 채널)
 *
 * 기존 telegram_daily_leader.js(오늘의 대장, 15:45)는 그대로 두고,
 * 신규 게시물(09:30 장중 주도 버블·트리 / 주간 / 월간)이 공통으로 쓰는 함수만 모은다.
 *   - Telegram Bot API: sendMessage / sendPhoto / sendMediaGroup (표준 라이브러리·fetch 만)
 *   - 헤드리스 렌더: servePublic + captureFramed(선택자 → ORGO 정사각 프레임 PNG)
 *   - AI 한줄 멘트: aiComment(Claude, 실패 시 폴백)
 *   - 포맷 헬퍼: num/pct/fmtAmount/ymdKst/dateLabel/marketLabel
 *   - 중복 방지 마커: loadMarker/saveMarker
 *
 * 시크릿 미설정 시 상위 스크립트가 no-op 하도록, 여기선 값 유효성만 검사하고 던진다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const TG_API = 'https://api.telegram.org/bot';
const TG_CAPTION_MAX = 1024;   // sendPhoto/sendMediaGroup 캡션 상한(텍스트 메시지는 4096)
const TG_TEXT_MAX = 4096;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

// ── 포맷 헬퍼 (report.js / telegram_daily_leader.js 와 동일 톤) ──
function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function pct(v) { var n = num(v); return (n >= 0 ? '+' : '') + (Math.round(n * 10) / 10).toFixed(1) + '%'; }
function fmtAmount(won) {
    won = num(won);
    if (won >= 1e12) return (Math.round(won / 1e11) / 10).toLocaleString('ko-KR') + '조';
    if (won >= 1e8) return Math.round(won / 1e8).toLocaleString('ko-KR') + '억';
    if (won > 0) return Math.round(won / 1e4).toLocaleString('ko-KR') + '만';
    return '-';
}
function ymdKst() {
    var k = new Date(Date.now() + 9 * 3600000);
    return k.getUTCFullYear() + ('0' + (k.getUTCMonth() + 1)).slice(-2) + ('0' + k.getUTCDate()).slice(-2);
}
function hmKst() {
    var k = new Date(Date.now() + 9 * 3600000);
    return ('0' + k.getUTCHours()).slice(-2) + ':' + ('0' + k.getUTCMinutes()).slice(-2);
}
function dateLabel(ymd) {
    var y = ymd.slice(0, 4), m = ymd.slice(4, 6), d = ymd.slice(6, 8);
    var dow = WEEKDAY[new Date(+y, +m - 1, +d).getDay()];
    return y + '.' + m + '.' + d + ' ' + dow;
}
function mdLabel(ymd) { return (+ymd.slice(4, 6)) + '.' + (+ymd.slice(6, 8)); }
function marketLabel(m) {
    m = String(m || '').toUpperCase();
    if (m.indexOf('KOSDAQ') >= 0) return 'KOSDAQ';
    if (m.indexOf('KOSPI') >= 0 || m.indexOf('KRX') >= 0) return 'KOSPI';
    return m || '';
}
function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// utm 딥링크 — 캠페인별 유입을 admin 유입경로 패널에서 구분(visitor.js 가 utm 을 ref 로 승격)
function orgoLink(path, campaign) {
    return 'https://orgo.kr' + path +
        (path.indexOf('?') >= 0 ? '&' : '?') +
        'utm_source=telegram&utm_campaign=' + encodeURIComponent(campaign || 'post');
}

// Telegram HTML parse_mode 이스케이프 — HTML 캡션에선 태그 밖 모든 동적 텍스트에 필수
// (미이스케이프 & < > 는 Bot API 가 "can't parse entities" 400 으로 거부)
function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 텍스트 링크 — 긴 URL 노출 없이 문구만 파란 링크로. parse_mode:'HTML' 과 함께 사용.
function htmlLink(text, url) {
    return '<a href="' + escHtml(url) + '">' + escHtml(text) + '</a>';
}

// ── 중복 방지 마커 ──
function loadMarker(markerPath) {
    try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')) || {}; } catch (e) { return {}; }
}
function saveMarker(markerPath, obj) {
    fs.writeFileSync(markerPath, JSON.stringify(obj) + '\n', 'utf8');
}

// ── 로컬 정적 서버 (public/ 서빙 — /api/* 는 없으니 페이지가 /data/*.json 폴백) ──
function servePublic(publicDir) {
    return new Promise(function (resolve) {
        var srv = http.createServer(function (req, res) {
            var p = decodeURIComponent(req.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            var fp = path.join(publicDir, p);
            if (!fp.startsWith(publicDir) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
                res.statusCode = 404; return res.end('nf');
            }
            var ext = path.extname(fp).toLowerCase();
            var ct = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css'
                : ext === '.json' ? 'application/json' : ext === '.html' ? 'text/html'
                : ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream';
            res.setHeader('Content-Type', ct);
            fs.createReadStream(fp).pipe(res);
        });
        srv.listen(0, '127.0.0.1', function () { resolve(srv); });
    });
}

/**
 * 페이지의 특정 요소(selector)를 ORGO 브랜드 정사각 프레임에 담아 PNG 로 캡쳐.
 * telegram_daily_leader.js 의 프레임 방식을 일반화. d3 SVG 차트(#tmapStage)에 최적.
 *
 *   page      : playwright Page (이미 goto + waitForSelector 완료 상태)
 *   opts.selector : 캡쳐할 요소 (기본 '#tmapStage')
 *   opts.title    : 좌측 상단 큰 제목 (예: '장중 주도 · 버블맵')
 *   opts.subtitle : 우측 상단 작은 라벨 (예: '2026.07.02 목 09:30')
 *   opts.outPath  : 저장 경로
 *   opts.size     : 정사각 한 변 px (기본 1080)
 */
async function captureFramed(page, opts) {
    var selector = opts.selector || '#tmapStage';
    var SIZE = opts.size || 1080;
    var title = String(opts.title || '');
    var subtitle = String(opts.subtitle || '');
    await page.waitForSelector(selector, { timeout: 45000 });
    await page.waitForTimeout(900);   // 차트 트랜지션 안정

    await page.evaluate(function (arg) {
        var SIZE = arg.SIZE, selector = arg.selector, title = arg.title, subtitle = arg.subtitle;
        var pageBg = getComputedStyle(document.body).backgroundColor || '#191919';
        var src = document.querySelector(selector);
        if (!src) return;
        var frame = document.createElement('div');
        frame.id = '__cap_frame';
        frame.style.cssText = ['position:fixed', 'left:0', 'top:0', 'z-index:2147483647',
            'width:' + SIZE + 'px', 'height:' + SIZE + 'px', 'box-sizing:border-box',
            'padding:34px 30px 28px', 'background:' + pageBg,
            'display:flex', 'flex-direction:column', 'gap:18px', 'overflow:hidden'].join(';');
        // 헤더
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;width:100%;padding:0 4px;flex:0 0 auto';
        head.innerHTML =
            '<div style="display:flex;align-items:baseline;gap:12px">' +
            '<span style="font-size:34px;font-weight:800;letter-spacing:.3px;color:var(--text-primary,#fff)">ORGO</span>' +
            '<span style="font-size:22px;font-weight:700;color:var(--text-muted,#8a8a8a)">' + title + '</span></div>' +
            '<span style="font-size:20px;font-weight:600;color:var(--text-muted,#8a8a8a)">' + subtitle + '</span>';
        frame.appendChild(head);
        // 본문 — 차트 클론(SVG viewBox 라 폭 채우면 자동 스케일)
        var body = document.createElement('div');
        body.style.cssText = 'flex:1;display:flex;align-items:stretch;justify-content:center;width:100%;min-height:0';
        var clone = src.cloneNode(true);
        clone.style.cssText = 'width:100%;height:100%;min-height:0';
        var svg = clone.tagName && clone.tagName.toLowerCase() === 'svg' ? clone : clone.querySelector('svg');
        if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); }
        body.appendChild(clone);
        frame.appendChild(body);
        // 푸터
        var foot = document.createElement('div');
        foot.style.cssText = 'flex:0 0 auto;text-align:right;padding:0 6px;font-size:19px;font-weight:600;color:var(--text-muted,#8a8a8a)';
        foot.textContent = '더 많은 데이터 → orgo.kr';
        frame.appendChild(foot);
        document.body.appendChild(frame);
    }, { SIZE: SIZE, selector: selector, title: title, subtitle: subtitle });

    await page.waitForTimeout(250);
    var el = await page.$('#__cap_frame');
    await el.screenshot({ path: opts.outPath });
    // 다음 캡쳐를 위해 프레임 제거
    await page.evaluate(function () { var f = document.getElementById('__cap_frame'); if (f) f.remove(); });
    return opts.outPath;
}

/**
 * 시각화 페이지(bubbles2/treemap)의 '이미지 저장' 기능을 그대로 실행해 다운로드 PNG 를 가로챈다.
 * → 사용자가 모바일에서 직접 다운로드한 것과 동일한 산출물(ORGO 워터마크 헤더 포함).
 * page 는 mobile viewport 로 열려 있어야 모바일 레이아웃으로 저장된다.
 */
async function saveViaBridge(page, outPath, opts) {
    opts = opts || {};
    await page.waitForFunction(function () {
        return window.WhyRiseTmapBridge && typeof window.WhyRiseTmapBridge.save === 'function'
            && document.querySelectorAll('#tmapSvg g, #tmapSvg rect, #tmapSvg circle').length >= 2;
    }, null, { timeout: opts.timeout || 45000 });
    await page.waitForTimeout(opts.settle || 1400);   // 차트 트랜지션/폰트 안정
    var res = await Promise.all([
        page.waitForEvent('download', { timeout: 25000 }),
        page.evaluate(function () { window.WhyRiseTmapBridge.save(); }),
    ]);
    await res[0].saveAs(outPath);
    return outPath;
}

/**
 * flowmap.html(급등주 흐름맵)을 모바일 뷰포트에서 mode×view 별로 '이미지 저장' 다운로드 캡쳐.
 *   configs: [{ mode: 'theme'|'rise'|'sector', view: 'bubble'|'tree', out: '/abs.png' }]
 * flowmap 브릿지(WhyRiseTmapBridge.setMode/setView/save) 사용. 반환: 성공한 out 경로 배열.
 */
async function captureFlowmaps(publicDir, configs) {
    var srv = await servePublic(publicDir);
    var port = srv.address().port;
    var browser = await require('playwright').chromium.launch({ headless: true, args: ['--no-sandbox'] });
    var done = [];
    try {
        var ctx = await browser.newContext({
            viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
            isMobile: true, hasTouch: true, acceptDownloads: true,
        });
        var page = await ctx.newPage();
        await page.addInitScript(function () { try { localStorage.setItem('theme', 'dark'); } catch (e) {} });
        for (var i = 0; i < configs.length; i++) {
            var c = configs[i];
            try {
                await page.goto('http://127.0.0.1:' + port + '/flowmap.html?view=' + c.view, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForFunction(function () {
                    return window.WhyRiseTmapBridge && typeof window.WhyRiseTmapBridge.setMode === 'function'
                        && document.querySelectorAll('#tmapSvg g, #tmapSvg rect, #tmapSvg circle').length >= 2;
                }, null, { timeout: 45000 });
                await page.evaluate(function (a) { window.WhyRiseTmapBridge.setView(a.v); window.WhyRiseTmapBridge.setMode(a.m); }, { v: c.view, m: c.mode });
                await page.waitForTimeout(1800);   // 모드 전환 렌더/트랜지션 안정
                await saveViaBridge(page, c.out, { settle: 600 });
                done.push(c.out);
            } catch (e) {
                console.error('flowmap 캡쳐 실패(' + c.mode + '/' + c.view + '):', e.message);
            }
        }
    } finally { await browser.close(); srv.close(); }
    return done;
}

/**
 * 자체 HTML 문자열을 PNG 로 캡쳐(주간/월간 리포트 카드용). #card 요소 크기 그대로 저장(세로형).
 * 사이트와 동일 웹폰트(Pretendard/Noto Sans KR)를 로드해 CI(ubuntu)에서도 한글 정상 렌더.
 */
async function captureHtml(browser, html, opts) {
    var W = (opts && (opts.width || opts.size)) || 1080;
    var H = (opts && (opts.height || opts.size)) || 1700;
    var ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    var page = await ctx.newPage();
    try {
        await page.setContent(html, { waitUntil: 'networkidle', timeout: 30000 });
        try { await page.evaluate(function () { return document.fonts && document.fonts.ready; }); } catch (e) {}
        await page.waitForTimeout(700);
        var el = await page.$((opts && opts.selector) || '#card');
        await el.screenshot({ path: opts.outPath });
    } finally {
        await ctx.close();
    }
    return opts.outPath;
}

// ORGO 리포트 카드 HTML (주간/월간 공용). 모바일 세로형·콘텐츠맞춤 높이.
//   워터마크: 좌상단 ORGO + orgo.kr(다운로드 산출물과 동일 톤). 면책·유도 문구 없음.
//   좌측 컬러 바 없이 균일 테두리 + 배경 틴트로 강조.
//   opts: { title, dateRange, statLine, sectors[], themes[], extraLabel, extraChips[] }
//   sectors/themes 항목: { name, sub }   extraChips 항목: { k, v }
function rankCardHtml(opts) {
    var UP = '#ff5666';   // 국내 관행 상승=빨강
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]; }); }
    function rows(list) {
        return (list || []).slice(0, 5).map(function (it, i) {
            return '<div class="row">' +
                '<span class="rk">' + (i + 1) + '</span>' +
                '<span class="nm">' + esc(it.name) + '</span>' +
                '<span class="sub">' + esc(it.sub) + '</span>' +
                '</div>';
        }).join('') || '<div class="row empty">데이터 집계 중</div>';
    }
    function chips(list) {
        return (list || []).slice(0, 6).map(function (c) {
            return '<span class="chip"><b>' + esc(c.k) + '</b> ' + esc(c.v) + '</span>';
        }).join('') || '<span class="chip empty">—</span>';
    }
    var extra = opts.extraChips && opts.extraChips.length ? (
        '<div class="xlabel">' + esc(opts.extraLabel || '') + '</div>' +
        '<div class="chips">' + chips(opts.extraChips) + '</div>') : '';
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
        '<link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">' +
        '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
        '<style>' +
        '*{margin:0;padding:0;box-sizing:border-box;font-family:Pretendard,"Noto Sans KR",sans-serif}' +
        'body{background:#0d0f14}' +
        '#card{width:1080px;background:#101218;color:#f5f7fa;padding:60px 52px 56px;display:flex;flex-direction:column;gap:34px}' +
        '.hd{display:flex;align-items:baseline;justify-content:space-between;gap:16px}' +
        '.hd .lt{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}' +
        '.hd .logo{font-size:44px;font-weight:800;letter-spacing:.3px}' +
        '.hd .wm{font-size:21px;font-weight:600;color:#8a93a6}' +
        '.hd .title{font-size:27px;font-weight:700;color:#c3cad8}' +
        '.hd .range{font-size:24px;font-weight:700;color:#8a93a6;white-space:nowrap}' +
        '.stat{font-size:22px;font-weight:600;color:#9aa3b5;margin-top:-14px}' +
        '.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}' +
        '.col{display:flex;flex-direction:column;gap:16px}' +
        '.col h3{font-size:26px;font-weight:800;color:#e9edf5}' +
        '.row{display:flex;align-items:center;gap:14px;padding:20px 22px;border-radius:18px;' +
        'background:rgba(255,86,102,.07);border:1px solid rgba(255,86,102,.22)}' +
        '.row.empty{justify-content:center;color:#8a93a6;background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.08)}' +
        '.rk{flex:0 0 auto;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.08);' +
        'color:#cfd6e4;font-size:20px;font-weight:800;display:flex;align-items:center;justify-content:center}' +
        '.nm{flex:1;font-size:27px;font-weight:700;color:#f5f7fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.sub{flex:0 0 auto;font-size:22px;font-weight:700;color:' + UP + '}' +
        '.xlabel{font-size:24px;font-weight:800;color:#e9edf5;margin-top:6px}' +
        '.chips{display:flex;flex-wrap:wrap;gap:13px;margin-top:-12px}' +
        '.chip{font-size:22px;font-weight:600;color:#e3e8f1;background:rgba(255,255,255,.06);' +
        'border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:11px 20px}' +
        '.chip b{color:#8a93a6;font-weight:700;margin-right:4px}' +
        '</style></head><body><div id="card">' +
        '<div class="hd"><div class="lt"><span class="logo">ORGO</span><span class="wm">orgo.kr</span>' +
        '<span class="title">· ' + esc(opts.title) + '</span></div>' +
        '<span class="range">' + esc(opts.dateRange) + '</span></div>' +
        (opts.statLine ? '<div class="stat">' + esc(opts.statLine) + '</div>' : '') +
        '<div class="cols">' +
        '<div class="col"><h3>📈 주도 섹터</h3>' + rows(opts.sectors) + '</div>' +
        '<div class="col"><h3>🏷️ 주도 테마</h3>' + rows(opts.themes) + '</div>' +
        '</div>' + extra +
        '</div></body></html>';
}

// 버튼 클릭으로 페이지 자체 다운로드(a[download])를 유발하고 그 파일을 가로챈다(대장캘린더 #calSave 등).
async function captureDownloadClick(page, selector, outPath, opts) {
    opts = opts || {};
    await page.waitForSelector(selector, { state: 'attached', timeout: 45000 });
    await page.waitForTimeout(opts.settle || 1200);
    var res = await Promise.all([
        page.waitForEvent('download', { timeout: 25000 }),
        page.evaluate(function (sel) { var el = document.querySelector(sel); if (el) el.click(); }, selector),
    ]);
    await res[0].saveAs(outPath);
    return outPath;
}

// '오늘의 대장' 3종 카드(자체 HTML). 대장주 없으면 fallback(오늘의 주도주=거래대금 1위)로 대체.
//   opts: { dateRange, leader|null, fallback|null, sector|null, theme|null }
//   leader/fallback: { name, market, rate, vol, tag?, reason? }   sector/theme: { name, count, avgRate, top, topRate, vol }
function leaderCardHtml(opts) {
    var UP = '#ff5666';
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]; }); }
    function mk(m) { m = String(m || '').toUpperCase(); return m.indexOf('KOSDAQ') >= 0 ? 'KOSDAQ' : (m ? 'KOSPI' : ''); }
    function tile(icon, label, nameHtml, metricHtml, subHtml) {
        return '<div class="tile">' +
            '<div class="tl"><span class="ic">' + icon + '</span><span class="lb">' + esc(label) + '</span></div>' +
            '<div class="nm">' + nameHtml + '</div>' +
            (metricHtml ? '<div class="mt">' + metricHtml + '</div>' : '') +
            (subHtml ? '<div class="sb">' + subHtml + '</div>' : '') +
            '</div>';
    }
    // 대장주(또는 주도주) 타일
    var s1;
    var lead = opts.leader || opts.fallback;
    if (lead) {
        var isFb = !opts.leader;
        var mm = mk(lead.market);
        s1 = tile('🥇', isFb ? '오늘의 주도주' : '대장주',
            esc(lead.name) + (mm ? '<span class="mk">' + mm + '</span>' : ''),
            '<b class="up">' + pct(lead.rate) + '</b> · 거래 ' + fmtAmount(lead.vol),
            (lead.tag ? '<span class="tag">' + esc(lead.tag) + '</span> ' : '') +
            esc(lead.reason || (isFb ? '거래대금 1위 (대장 기준 거래대금 3,000억 미달)' : '')));
    } else {
        s1 = tile('🥇', '대장주', '<span class="none">해당 없음</span>',
            '', '오늘은 대장주 조건(거래대금·상승률)에 맞는 종목이 없었어요');
    }
    function grp(icon, label, g) {
        if (!g) return tile(icon, label, '<span class="none">집계 중</span>', '', '');
        return tile(icon, label, esc(g.name) + '<span class="cnt">' + g.count + '종목</span>',
            '평균 <b class="up">' + pct(g.avgRate) + '</b> · 거래 ' + fmtAmount(g.vol),
            g.top ? ('1위 ' + esc(g.top) + (g.topRate != null ? ' <b class="up">' + pct(g.topRate) + '</b>' : '')) : '');
    }
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
        '<link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">' +
        '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
        '<style>' +
        '*{margin:0;padding:0;box-sizing:border-box;font-family:Pretendard,"Noto Sans KR",sans-serif}' +
        'body{background:#0d0f14}' +
        '#card{width:1080px;background:#101218;color:#f5f7fa;padding:58px 50px 52px;display:flex;flex-direction:column;gap:26px}' +
        '.hd{display:flex;align-items:baseline;justify-content:space-between;gap:16px}' +
        '.hd .lt{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}' +
        '.hd .logo{font-size:44px;font-weight:800;letter-spacing:.3px}' +
        '.hd .wm{font-size:21px;font-weight:600;color:#8a93a6}' +
        '.hd .title{font-size:27px;font-weight:700;color:#c3cad8}' +
        '.hd .range{font-size:24px;font-weight:700;color:#8a93a6;white-space:nowrap}' +
        '.tile{padding:26px 30px;border-radius:20px;background:rgba(255,86,102,.07);border:1px solid rgba(255,86,102,.22);display:flex;flex-direction:column;gap:8px}' +
        '.tile .tl{display:flex;align-items:center;gap:10px}' +
        '.tile .ic{font-size:26px}.tile .lb{font-size:23px;font-weight:800;color:#e9edf5}' +
        '.tile .nm{font-size:34px;font-weight:800;color:#fff;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}' +
        '.tile .nm .mk{font-size:20px;font-weight:700;color:#8a93a6}' +
        '.tile .nm .cnt{font-size:22px;font-weight:700;color:#9aa3b5}' +
        '.tile .nm .none{font-size:27px;font-weight:700;color:#c3cad8}' +
        '.tile .mt{font-size:24px;font-weight:700;color:#cfd6e4}.tile .mt .up{color:' + UP + '}' +
        '.tile .sb{font-size:22px;font-weight:500;color:#aab2c2}.tile .sb .up{color:' + UP + '}' +
        '.tile .sb .tag{color:#8a93a6;font-weight:700}' +
        '</style></head><body><div id="card">' +
        '<div class="hd"><div class="lt"><span class="logo">ORGO</span><span class="wm">orgo.kr</span>' +
        '<span class="title">· 오늘의 대장</span></div><span class="range">' + esc(opts.dateRange) + '</span></div>' +
        s1 + grp('🏢', '대장 섹터', opts.sector) + grp('🏷️', '대장 테마', opts.theme) +
        '</div></body></html>';
}

// 오늘의 주도주 TOP5 카드(자체 HTML). movers: [{ name, market, rate, vol, theme, reason }]
function topMoversCardHtml(opts) {
    var UP = '#ff5666';
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]; }); }
    function mk(m) { m = String(m || '').toUpperCase(); return m.indexOf('KOSDAQ') >= 0 ? 'KOSDAQ' : (m ? 'KOSPI' : ''); }
    var rows = (opts.movers || []).slice(0, 5).map(function (it, i) {
        var mm = mk(it.market);
        var sub = (it.theme ? '<span class="tag">' + esc(it.theme) + '</span> ' : '') + esc(it.reason || '');
        return '<div class="row">' +
            '<span class="rk">' + (i + 1) + '</span>' +
            '<div class="col">' +
            '<div class="nm">' + esc(it.name) + (mm ? '<span class="mk">' + mm + '</span>' : '') +
            '<b class="up">' + pct(it.rate) + '</b><span class="vol">거래 ' + fmtAmount(it.vol) + '</span></div>' +
            (sub.trim() ? '<div class="sb">' + sub + '</div>' : '') +
            '</div></div>';
    }).join('') || '<div class="row"><span class="none">집계 중</span></div>';
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
        '<link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">' +
        '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
        '<style>' +
        '*{margin:0;padding:0;box-sizing:border-box;font-family:Pretendard,"Noto Sans KR",sans-serif}' +
        'body{background:#0d0f14}' +
        '#card{width:1080px;background:#101218;color:#f5f7fa;padding:58px 50px 52px;display:flex;flex-direction:column;gap:22px}' +
        '.hd{display:flex;align-items:baseline;justify-content:space-between;gap:16px}' +
        '.hd .lt{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}' +
        '.hd .logo{font-size:44px;font-weight:800;letter-spacing:.3px}' +
        '.hd .wm{font-size:21px;font-weight:600;color:#8a93a6}' +
        '.hd .title{font-size:27px;font-weight:700;color:#c3cad8}' +
        '.hd .range{font-size:23px;font-weight:700;color:#8a93a6;white-space:nowrap}' +
        '.row{display:flex;align-items:flex-start;gap:16px;padding:22px 24px;border-radius:18px;' +
        'background:rgba(255,86,102,.07);border:1px solid rgba(255,86,102,.22)}' +
        '.rk{flex:0 0 auto;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.08);' +
        'color:#cfd6e4;font-size:22px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:2px}' +
        '.col{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}' +
        '.nm{font-size:30px;font-weight:800;color:#fff;display:flex;align-items:baseline;gap:11px;flex-wrap:wrap}' +
        '.nm .mk{font-size:19px;font-weight:700;color:#8a93a6}' +
        '.nm .up{color:' + UP + ';font-size:27px}' +
        '.nm .vol{font-size:20px;font-weight:600;color:#9aa3b5}' +
        '.sb{font-size:21px;font-weight:500;color:#aab2c2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.sb .tag{color:#8a93a6;font-weight:700}' +
        '.none{color:#8a93a6;font-size:24px}' +
        '</style></head><body><div id="card">' +
        '<div class="hd"><div class="lt"><span class="logo">ORGO</span><span class="wm">orgo.kr</span>' +
        '<span class="title">· 오늘의 주도주</span></div><span class="range">' + esc(opts.dateRange) + '</span></div>' +
        rows +
        '</div></body></html>';
}

// ── Telegram Bot API ──
async function _tgPost(botToken, method, bodyBuf, headers) {
    var res = await fetch(TG_API + botToken + '/' + method, { method: 'POST', headers: headers, body: bodyBuf });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok || !j.ok) throw new Error('telegram ' + method + ' HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 300));
    return j;
}

function _multipart(fields, files) {
    var boundary = '----wr' + process.pid + '.' + fields.__seq;
    var parts = [];
    Object.keys(fields).forEach(function (name) {
        if (name === '__seq') return;
        parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + fields[name] + '\r\n'));
    });
    (files || []).forEach(function (f) {
        parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + f.name + '"; filename="' + f.filename + '"\r\nContent-Type: image/png\r\n\r\n'));
        parts.push(fs.readFileSync(f.path));
        parts.push(Buffer.from('\r\n'));
    });
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    return { buf: Buffer.concat(parts), boundary: boundary };
}

var _seq = 0;
async function sendMessage(botToken, chatId, text, opts) {
    opts = opts || {};
    var payload = { chat_id: chatId, text: clip(text, TG_TEXT_MAX), disable_web_page_preview: true };
    if (opts.parse_mode) payload.parse_mode = opts.parse_mode;
    return _tgPost(botToken, 'sendMessage', JSON.stringify(payload), { 'Content-Type': 'application/json' });
}

async function sendPhoto(botToken, chatId, imgPath, caption, opts) {
    opts = opts || {};
    var fields = { __seq: ++_seq, chat_id: chatId, caption: clip(caption, TG_CAPTION_MAX) };
    if (opts.parse_mode) fields.parse_mode = opts.parse_mode;
    var mp = _multipart(fields,
        [{ name: 'photo', filename: 'orgo.png', path: imgPath }]);
    return _tgPost(botToken, 'sendPhoto', mp.buf, { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary });
}

/**
 * 앨범(미디어 그룹) 전송 — 2~10장을 하나의 게시물로. 캡션은 첫 장에만.
 *   images: [ '/abs/a.png', '/abs/b.png' ]
 */
async function sendMediaGroup(botToken, chatId, images, caption, opts) {
    opts = opts || {};
    var media = images.map(function (_, i) {
        var m = { type: 'photo', media: 'attach://p' + i };
        if (i === 0 && caption) {
            m.caption = clip(caption, TG_CAPTION_MAX);
            if (opts.parse_mode) m.parse_mode = opts.parse_mode;   // 앨범은 media 객체 안에 지정
        }
        return m;
    });
    var files = images.map(function (p, i) { return { name: 'p' + i, filename: 'orgo' + i + '.png', path: p }; });
    var mp = _multipart({ __seq: ++_seq, chat_id: chatId, media: JSON.stringify(media) }, files);
    return _tgPost(botToken, 'sendMediaGroup', mp.buf, { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary });
}

// ── AI 한줄 멘트 (Claude, 실패/미설정 시 fallback 문자열) ──
async function aiComment(promptText, apiKey, model, fallback) {
    if (!apiKey) return fallback;
    try {
        var res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            // thinking 비활성 — 한 줄 멘트에 사고 불필요(소넷5 등은 미지정 시 적응형 사고가 켜져 max_tokens 잠식→문장 잘림). max_tokens 여유.
            body: JSON.stringify({ model: model || 'claude-sonnet-5', max_tokens: 200, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: promptText }] }),
        });
        if (!res.ok) throw new Error('anthropic HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
        var j = await res.json();
        var text = (j.content || []).map(function (b) { return b.text || ''; }).join('').trim();
        text = text.replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0].trim();
        if (text === '(생략)') return '';   // 특이사항 없음 — 의도적 생략(빈 응답=오류→폴백과 구분)
        return text || fallback;
    } catch (e) {
        console.error('AI 멘트 실패 → 폴백:', e.message);
        return fallback;
    }
}

// ── 시황 한 줄(담백 요약) ───────────────────────────────────────────────
// 과장·호들갑 금지 — 평범한 날을 대단한 일처럼 포장하지 않는다(2026-07-03 사용자 지시,
// 이전 "후킹형" 규칙 폐기). 할 말 없으면 드라이하게 정보만. 텔레그램·소셜 공용.
const HOOK_RULE = [
    '너는 한국 주식 시황 채널 에디터야. 아래 데이터를 담백하게 요약하는 한 줄을 만들어.',
    '규칙:',
    '- 사실 서술만. "벌써/무려/판을 흔든다/벌어진 일" 같은 호들갑·감탄·드라마화 금지.',
    '- 평범한 날이면 평범하게 써라. 대단한 일처럼 포장하지 마. 구체 숫자는 하나 정도만.',
    '- 뚜렷한 쏠림·이슈가 없어서 딱히 할 말이 없으면 문장 대신 정확히 (생략) 만 출력.',
    '- 한 문장 45자 내외, 이모지 0~1개.',
    '- 과장·투자권유·목표가·"잡아라/사라"류 금지. 장중이면 미확정 뉘앙스.',
    '- 따옴표·해시태그·링크 없이 문장만 출력.',
].join('\n');

// subject: 게시물 성격(예: '오늘의 주도주 TOP5(장중)'), summary: 데이터 요약(문자열 또는 객체)
async function aiHook(subject, summary, apiKey, model, fallback) {
    var body = (typeof summary === 'string') ? summary : JSON.stringify(summary, null, 2);
    return aiComment(HOOK_RULE + '\n\n[' + subject + ']\n' + body, apiKey, model, fallback);
}

// ── 소셜(Threads 등) 전용 캡션: 후킹 첫 줄 + 압축 본문 + 링크·면책 없음 + 최소 태그 ──
// Threads 는 외부 링크 달린 글의 도달을 깎으므로 링크는 넣지 않는다(프로필/바이오로).
function _socialTags(arr) { return arr.filter(Boolean).map(function (t) { return '#' + t; }).join(' '); }

function socialMoversCaption(opts) {
    var ymd = opts.ymd, movers = opts.movers || [], hook = (opts.hook || '').trim();
    var lines = [];
    if (hook) { lines.push(hook); lines.push(''); }
    lines.push('📊 오늘의 주도주 · ' + mdLabel(ymd));
    movers.slice(0, 5).forEach(function (m, i) {
        lines.push((i + 1) + ' ' + m.name + ' ' + pct(m.rate) + (m.theme ? ' · ' + clip(m.theme, 12) : ''));
    });
    lines.push('');
    lines.push(_socialTags(['주식', '급등주', '주도주']));
    return lines.join('\n');
}

function socialThemesCaption(opts) {
    var ymd = opts.ymd, G = opts.groups || { sectors: [], themes: [] }, hook = (opts.hook || '').trim();
    var lines = [];
    if (hook) { lines.push(hook); lines.push(''); }
    lines.push('🔥 오늘 핫테마 · ' + mdLabel(ymd));
    if ((G.sectors || []).length) {
        lines.push('📈 섹터  ' + G.sectors.slice(0, 3).map(function (s) { return clip(s.key, 10) + ' ' + pct(s.avgRate); }).join(' · '));
    }
    if ((G.themes || []).length) {
        lines.push('🏷️ 테마  ' + G.themes.slice(0, 3).map(function (t) { return clip(t.key, 12) + ' ' + pct(t.avgRate); }).join(' · '));
    }
    lines.push('');
    lines.push(_socialTags(['주식', '테마주', '섹터']));
    return lines.join('\n');
}

module.exports = {
    TG_CAPTION_MAX, TG_TEXT_MAX, WEEKDAY, HOOK_RULE,
    num, pct, fmtAmount, ymdKst, hmKst, dateLabel, mdLabel, marketLabel, clip, orgoLink, escHtml, htmlLink,
    loadMarker, saveMarker,
    servePublic, captureFramed, saveViaBridge, captureDownloadClick, captureFlowmaps, captureHtml, rankCardHtml, leaderCardHtml, topMoversCardHtml,
    sendMessage, sendPhoto, sendMediaGroup, aiComment, aiHook,
    socialMoversCaption, socialThemesCaption,
};
