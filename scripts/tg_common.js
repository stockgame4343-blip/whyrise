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
            && document.querySelectorAll('#tmapSvg g, #tmapSvg rect').length >= 3;
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

async function sendPhoto(botToken, chatId, imgPath, caption) {
    var mp = _multipart({ __seq: ++_seq, chat_id: chatId, caption: clip(caption, TG_CAPTION_MAX) },
        [{ name: 'photo', filename: 'orgo.png', path: imgPath }]);
    return _tgPost(botToken, 'sendPhoto', mp.buf, { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary });
}

/**
 * 앨범(미디어 그룹) 전송 — 2~10장을 하나의 게시물로. 캡션은 첫 장에만.
 *   images: [ '/abs/a.png', '/abs/b.png' ]
 */
async function sendMediaGroup(botToken, chatId, images, caption) {
    var media = images.map(function (_, i) {
        var m = { type: 'photo', media: 'attach://p' + i };
        if (i === 0 && caption) m.caption = clip(caption, TG_CAPTION_MAX);
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
            body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: promptText }] }),
        });
        if (!res.ok) throw new Error('anthropic HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
        var j = await res.json();
        var text = (j.content || []).map(function (b) { return b.text || ''; }).join('').trim();
        text = text.replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0].trim();
        return text || fallback;
    } catch (e) {
        console.error('AI 멘트 실패 → 폴백:', e.message);
        return fallback;
    }
}

module.exports = {
    TG_CAPTION_MAX, TG_TEXT_MAX, WEEKDAY,
    num, pct, fmtAmount, ymdKst, hmKst, dateLabel, mdLabel, marketLabel, clip,
    loadMarker, saveMarker,
    servePublic, captureFramed, saveViaBridge, captureHtml, rankCardHtml,
    sendMessage, sendPhoto, sendMediaGroup, aiComment,
};
