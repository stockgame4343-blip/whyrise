/**
 * 샘플2 — 오늘의 대장 캘린더
 * public/data/leaders-calendar.json (일자별 대장주/섹터/테마) 를 월 캘린더로 렌더.
 * 한 달에 여러 번 대장인(반복) 항목만 같은 색 dot 으로 표시해 흐름을 인지하게 한다.
 */
(function () {
    'use strict';

    var DATA_URL = '/data/leaders-calendar.json?v=20260616h';
    var DOW = ['일', '월', '화', '수', '목', '금', '토'];
    var TYPE_LABEL = { stock: '대장주', sector: '대장 섹터', theme: '대장 테마' };

    // 이미지 다운로드 — 워터마크/캡처 레이아웃 상수 (매직넘버 금지)
    var CAP = {
        SCALE: 2,          // 2배 해상도
        HEAD_H: 52,        // 상단 워터마크 헤더 높이
        PAD: 18,           // 캡처 외곽 여백
        HEAD_BASELINE: 31, // 헤더 텍스트 baseline y
        LOGO_SIZE: 16, DOMAIN_SIZE: 13, CTX_SIZE: 12.5,
        FONT: '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Noto Sans KR", sans-serif',
    };

    var state = { days: {}, type: 'stock', year: 0, month: 0, min: null, max: null, colorMap: {}, counts: {}, activeColors: {} };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 반복 대장 구분용 팔레트 — 중채도(톤다운하되 살짝 또렷하게). render 에서 등장순 배정.
    var PALETTE = ['#5485e0', '#e8685a', '#36b394', '#b275d4', '#e8a544', '#45b4d0', '#e06f9e', '#74c95c', '#7e6ee0', '#e88848'];
    function colorOf(name) { return (state.colorMap && state.colorMap[name]) || ''; }

    // 거래대금 표기 — 리포트(fmtAmount)와 동일
    function fmtAmount(n) {
        n = Number(n || 0);
        if (!n) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8).toLocaleString('ko-KR') + '억';
        if (n >= 1e4) return Math.round(n / 1e4).toLocaleString('ko-KR') + '만';
        return n.toLocaleString('ko-KR');
    }

    function ymd(y, m, d) { return String(y) + ('0' + (m + 1)).slice(-2) + ('0' + d).slice(-2); }
    function leaderName(day, type) { var e = day && day[type]; return e ? e.name : ''; }

    function todayYmd() {
        var k = new Date(Date.now() + 9 * 3600000); // KST
        return k.getUTCFullYear() + ('0' + (k.getUTCMonth() + 1)).slice(-2) + ('0' + k.getUTCDate()).slice(-2);
    }

    function setType(type) {
        state.type = type;
        document.querySelectorAll('#calToggle .seg__btn').forEach(function (b) {
            b.classList.toggle('seg__btn--active', b.getAttribute('data-type') === type);
        });
        render();
    }

    function shiftMonth(delta) {
        var m = state.month + delta, y = state.year;
        if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
        state.year = y; state.month = m;
        render();
    }

    function monthHasData(y, m) {
        var prefix = String(y) + ('0' + (m + 1)).slice(-2);
        return Object.keys(state.days).some(function (k) { return k.indexOf(prefix) === 0; });
    }

    // 이 달 선택 타입의 대장 등장 횟수 — 반복(>=2) 판정 + 범례 공용
    function monthCounts() {
        var prefix = String(state.year) + ('0' + (state.month + 1)).slice(-2);
        var counts = {};
        Object.keys(state.days).forEach(function (k) {
            if (k.indexOf(prefix) !== 0) return;
            var nm = leaderName(state.days[k], state.type);
            if (nm) counts[nm] = (counts[nm] || 0) + 1;
        });
        return counts;
    }

    // 칸 본문 — 리포트 '오늘의 대장' 포맷과 동일하게 자기 정보로 채움
    // 대장주: 상승률 · 거래대금  /  [태그] 상승이유
    // 섹터·테마: N종목 · 평균 +X% · 거래대금  /  그중 대장 OO
    function leaderBody(e, type) {
        if (type === 'stock') {
            var tag = e.theme || e.sector || '대장';
            var reason = e.reason || [e.sector, e.theme].filter(Boolean).join(' · ') || '거래대금 상위';
            return '<div class="cal-cell__metric"><b class="cal-cell__rate">+' + Number(e.rate).toFixed(1) + '%</b>' +
                (e.vol ? '<span class="cal-cell__vol"> · 거래 ' + fmtAmount(e.vol) + '</span>' : '') + '</div>' +
                '<div class="cal-cell__reason">[' + esc(tag) + '] ' + esc(reason) + '</div>';
        }
        return '<div class="cal-cell__metric">' + e.count + '종목' +
            '<span class="cal-cell__vol"> · 평균 +' + Number(e.avgRate).toFixed(1) + '%' +
            (e.vol ? ' · 거래 ' + fmtAmount(e.vol) : '') + '</span></div>' +
            (e.top ? '<div class="cal-cell__reason">대장 ' + esc(e.top) + '</div>' : '');
    }

    function cellHtml(y, m, d) {
        var key = ymd(y, m, d);
        var day = state.days[key];
        var dow = new Date(y, m, d).getDay();
        var topRow = '<div class="cal-cell__top"><span class="cal-cell__date">' + d + '</span></div>';

        if (!day) {
            var cls = 'cal-cell cal-cell--empty';
            var center = '';
            if (dow === 0 || dow === 6) {
                cls += ' cal-cell--weekend';
            } else if (key === todayYmd()) {
                // 오늘(평일) — 장중/집계 전. 마감 후 데이터가 누적됨을 안내
                cls += ' cal-cell--today';
                center = '<div class="cal-cell__center"><span class="cal-cell__pending">장 마감 후<br>추가됩니다</span></div>';
            } else if (key >= state.min && key <= state.max) {
                // 데이터 기간 안의 평일인데 기록 없음 = 공휴일(휴장)
                cls += ' cal-cell--holiday';
                center = '<div class="cal-cell__center"><span class="cal-cell__off">휴장</span></div>';
            }
            return '<div class="' + cls + '">' + topRow + center + '</div>';
        }

        var lead = day[state.type];
        if (!lead) {
            return '<div class="cal-cell cal-cell--data">' + topRow +
                '<div class="cal-cell__center"><span class="cal-cell__none">대장 없음</span></div></div>';
        }

        // 반복(2회+) 대장은 우상단 ×N 배지로 표시(dot 없음). 색은 범례 클릭 시 칸 배경에 입힘.
        var cnt = (state.counts && state.counts[lead.name]) || 0;
        var color = cnt >= 2 ? colorOf(lead.name) : '';
        var badge = cnt >= 2
            ? '<span class="cal-cell__badge"' + (color ? ' style="color:' + color + ';border-color:' + color + '66"' : '') + '>×' + cnt + '</span>'
            : '';
        var topRowB = '<div class="cal-cell__top"><span class="cal-cell__date">' + d + '</span>' + badge + '</div>';
        var leaderAttr = ' data-leader="' + esc(lead.name) + '"';
        var inner = topRowB + '<div class="cal-cell__name">' + esc(lead.name) + '</div>' + leaderBody(lead, state.type);

        // 대장주 → 종목 상세 / 섹터·테마 → 해당 필터 적용된 스크리닝 페이지
        if (state.type === 'stock' && day.stock && day.stock.ticker) {
            return '<a class="cal-cell cal-cell--data"' + leaderAttr + ' href="/stock/' + esc(day.stock.ticker) + '">' + inner + '</a>';
        }
        var qkey = state.type === 'sector' ? 'sector' : 'theme';
        return '<a class="cal-cell cal-cell--data"' + leaderAttr + ' href="/screening.html?' + qkey + '=' + encodeURIComponent(lead.name) + '">' + inner + '</a>';
    }

    function renderLegend(counts) {
        var $legend = document.getElementById('calLegend');
        var repeated = Object.keys(counts).filter(function (n) { return counts[n] >= 2; })
            .sort(function (a, b) { return counts[b] - counts[a]; });
        if (!repeated.length) { $legend.style.display = 'none'; return; }
        var html = '<div class="cal-legend__head">이 달 여러 번 대장인 ' + TYPE_LABEL[state.type] +
            ' <span class="cal-legend__hint">— 누르면 캘린더에서 강조</span></div><div class="cal-legend__items">';
        repeated.forEach(function (n) {
            var c = colorOf(n);
            var active = state.activeColors[n] ? ' cal-legend__item--active' : '';
            html += '<button type="button" class="cal-legend__item' + active + '" data-leader="' + esc(n) + '" style="--lc:' + c + '">' +
                '<span class="cal-legend__dot" style="background:' + c + '"></span>' +
                esc(n) + ' <span class="cal-legend__count">×' + counts[n] + '</span></button>';
        });
        html += '</div>';
        $legend.innerHTML = html;
        $legend.style.display = 'block';
    }

    // 활성화된 대장만 칸에 색 입힘 (미리 안 깔고, 클릭으로 켤 때만)
    function applyHighlights() {
        var cells = document.querySelectorAll('#calGrid .cal-cell--data[data-leader]');
        Array.prototype.forEach.call(cells, function (cell) {
            var c = state.activeColors[cell.getAttribute('data-leader')];
            if (c) { cell.style.background = c + '1f'; cell.style.borderColor = c + '4d'; }
            else { cell.style.background = ''; cell.style.borderColor = ''; }
        });
    }

    function syncLegendActive() {
        var items = document.querySelectorAll('#calLegend .cal-legend__item');
        Array.prototype.forEach.call(items, function (it) {
            var c = state.activeColors[it.getAttribute('data-leader')];
            it.classList.toggle('cal-legend__item--active', !!c);
            it.style.background = c ? (c + '1f') : '';
            it.style.borderColor = c ? c : '';
        });
    }

    // 색 배정된(반복) 대장만 토글 — 클릭 시 해당 색 활성/해제
    function toggleLeader(name) {
        var c = colorOf(name);
        if (!c) return;
        if (state.activeColors[name]) delete state.activeColors[name];
        else state.activeColors[name] = c;
        applyHighlights();
        syncLegendActive();
    }

    function render() {
        var y = state.year, m = state.month;
        document.getElementById('calLabel').textContent = y + '. ' + ('0' + (m + 1)).slice(-2) + '.';
        var _pp = document.getElementById('calPicker');
        if (_pp && _pp.classList.contains('open')) { _pickerYear = y; renderPicker(); }
        var prev = new Date(y, m - 1, 1), next = new Date(y, m + 1, 1);
        document.getElementById('calPrev').disabled = !monthHasData(prev.getFullYear(), prev.getMonth());
        document.getElementById('calNext').disabled = !monthHasData(next.getFullYear(), next.getMonth());

        var counts = monthCounts();
        state.counts = counts;     // 칸 우상단 ×N 배지용
        // 반복(2회+) 대장에게 팔레트 색 배정 — 등장 많은 순. 같은 달 안에서 항목별로 뚜렷이 구분.
        state.colorMap = {};
        Object.keys(counts).filter(function (n) { return counts[n] >= 2; })
            .sort(function (a, b) { return counts[b] - counts[a]; })
            .forEach(function (n, i) { state.colorMap[n] = PALETTE[i % PALETTE.length]; });
        state.activeColors = {};   // 월/타입 바뀌면 강조 초기화 (기본은 색 없음)

        var first = new Date(y, m, 1).getDay();
        var daysInMonth = new Date(y, m + 1, 0).getDate();
        var html = '';
        DOW.forEach(function (dn, i) {
            var c = i === 0 ? ' cal-dow--sun' : (i === 6 ? ' cal-dow--sat' : '');
            html += '<div class="cal-dow' + c + '">' + dn + '</div>';
        });
        // 선두 빈칸 — 모바일(주말 숨김) 정렬 위해 일요일(b===0) 빈칸도 weekend 로 태깅
        for (var b = 0; b < first; b++) html += '<div class="cal-cell cal-cell--blank' + (b === 0 ? ' cal-cell--weekend' : '') + '"></div>';
        for (var d = 1; d <= daysInMonth; d++) html += cellHtml(y, m, d);
        document.getElementById('calGrid').innerHTML = html;
        renderLegend(counts);
        applyHighlights();
    }

    // ── 이미지 다운로드 ───────────────────────────────────────────────
    // 캘린더 그리드(#calGrid)만 캡처. DOM 박스/텍스트를 실측 좌표로 canvas 에
    // 다시 그리고(로드된 폰트 그대로 사용 → 한글 안전, 외부 라이브러리 불필요),
    // 상단에 워터마크 헤더(좌: 로고+도메인 / 우: 날짜·모드)를 합성한다.
    function savePNG() {
        var grid = document.getElementById('calGrid');
        if (!grid || !grid.children.length) return;
        var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
        ready.then(function () { renderPNG(grid); }, function () { renderPNG(grid); });
    }

    function renderPNG(grid) {
        var gridRect = grid.getBoundingClientRect();
        var W = Math.round(gridRect.width), GH = Math.round(gridRect.height);
        if (W < 80 || GH < 80) return;

        var PAD = CAP.PAD, HEAD_H = CAP.HEAD_H, S = CAP.SCALE;
        var totalW = W + PAD * 2, totalH = HEAD_H + PAD + GH + PAD;
        var ox = PAD - gridRect.left, oy = HEAD_H + PAD - gridRect.top; // 뷰포트→캔버스 보정

        var rootCs = getComputedStyle(document.documentElement);
        var bodyCs = getComputedStyle(document.body);
        var isLight = document.documentElement.getAttribute('data-theme') === 'light';
        var bgColor = bodyCs.backgroundColor || (isLight ? '#F2F4F6' : '#191919');
        var primary = (rootCs.getPropertyValue('--text-primary') || '').trim() || bodyCs.color;
        var dim = isLight ? 'rgba(25,25,25,0.5)' : 'rgba(255,255,255,0.55)';
        var dividerColor = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)';

        var canvas = document.createElement('canvas');
        canvas.width = Math.round(totalW * S);
        canvas.height = Math.round(totalH * S);
        var ctx = canvas.getContext('2d');
        ctx.scale(S, S);
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, totalW, totalH);

        // 헤더 워터마크 — 좌: ORGO + orgo.kr / 우: 날짜 · 모드
        var hy = CAP.HEAD_BASELINE;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.font = '800 ' + CAP.LOGO_SIZE + 'px ' + CAP.FONT;
        ctx.fillStyle = primary;
        ctx.fillText('ORGO', PAD, hy);
        var logoW = ctx.measureText('ORGO').width;
        ctx.font = '600 ' + CAP.DOMAIN_SIZE + 'px ' + CAP.FONT;
        ctx.fillStyle = dim;
        ctx.fillText('orgo.kr', PAD + logoW + 9, hy);
        var ctxStr = state.year + '.' + ('0' + (state.month + 1)).slice(-2) + ' · ' + (TYPE_LABEL[state.type] || '');
        ctx.font = '600 ' + CAP.CTX_SIZE + 'px ' + CAP.FONT;
        ctx.fillStyle = primary;
        ctx.textAlign = 'right';
        ctx.fillText(ctxStr, totalW - PAD, hy);
        ctx.textAlign = 'left';
        ctx.strokeStyle = dividerColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, HEAD_H - 0.5);
        ctx.lineTo(totalW, HEAD_H - 0.5);
        ctx.stroke();

        function isPaint(c) { return !!c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)'; }
        function relRect(el) { var r = el.getBoundingClientRect(); return { x: r.left + ox, y: r.top + oy, w: r.width, h: r.height }; }
        function roundPath(x, y, w, h, r) {
            r = Math.max(0, Math.min(r, w / 2, h / 2));
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }
        function drawBox(el, cs) {
            var bg = cs.backgroundColor, bw = parseFloat(cs.borderTopWidth) || 0, bc = cs.borderTopColor;
            var hasBg = isPaint(bg), hasB = bw > 0 && isPaint(bc);
            if (!hasBg && !hasB) return;
            var r = relRect(el);
            roundPath(r.x, r.y, r.w, r.h, parseFloat(cs.borderTopLeftRadius) || 0);
            if (hasBg) { ctx.fillStyle = bg; ctx.fill(); }
            if (hasB) { ctx.lineWidth = bw; ctx.strokeStyle = bc; ctx.stroke(); }
        }
        // 텍스트 노드를 라인(getClientRects)별로 잘라 그림 → wrap/line-clamp/혼합색 자동 반영
        function drawTextNode(node, cs) {
            var text = node.nodeValue;
            if (!text || !/\S/.test(text)) return;
            var range = document.createRange();
            range.selectNodeContents(node);
            var rects = range.getClientRects();
            if (!rects.length) return;
            ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + CAP.FONT;
            ctx.fillStyle = cs.color;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            // 단일 라인은 통째로 그림 — measure 누적 오차로 끝 글자가 잘리는 것 방지
            if (rects.length === 1) {
                var r0 = rects[0];
                ctx.fillText(text, r0.left + ox, r0.top + oy + r0.height / 2);
                return;
            }
            // 멀티라인 — 글자마다 실제 렌더된 라인(top 일치)에 배분해 브라우저 줄바꿈 그대로 재현
            var lines = [];
            for (var li = 0; li < rects.length; li++) lines.push('');
            var ch = document.createRange();
            for (var j = 0; j < text.length; j++) {
                ch.setStart(node, j);
                ch.setEnd(node, j + 1);
                var cr = ch.getBoundingClientRect();
                var best = 0, bestD = Infinity;
                for (var m = 0; m < rects.length; m++) {
                    var d = Math.abs(rects[m].top - cr.top);
                    if (d < bestD) { bestD = d; best = m; }
                }
                lines[best] += text[j];
            }
            for (var k = 0; k < rects.length; k++) {
                var rc = rects[k];
                if (rc.width < 0.5) continue;
                ctx.fillText(lines[k], rc.left + ox, rc.top + oy + rc.height / 2);
            }
        }
        function paintInner(el) {
            var kids = el.childNodes;
            for (var i = 0; i < kids.length; i++) {
                var nd = kids[i];
                if (nd.nodeType === 3) { drawTextNode(nd, getComputedStyle(el)); }
                else if (nd.nodeType === 1) {
                    var ccs = getComputedStyle(nd);
                    if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
                    drawBox(nd, ccs);
                    paintInner(nd);
                }
            }
        }

        var children = grid.children;
        for (var c = 0; c < children.length; c++) {
            var el = children[c], cs = getComputedStyle(el);
            if (cs.display === 'none') continue;
            drawBox(el, cs);
            var r = relRect(el);
            ctx.save();
            roundPath(r.x, r.y, r.w, r.h, parseFloat(cs.borderTopLeftRadius) || 0);
            ctx.clip();
            paintInner(el);
            ctx.restore();
        }

        canvas.toBlob(function (b) {
            if (!b) return;
            var url = URL.createObjectURL(b);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'orgo-calendar-' + state.year + ('0' + (state.month + 1)).slice(-2) + '-' + state.type + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 'image/png');
    }

    // ── 연·월 빠른 선택 팝오버 (중앙 라벨 클릭) ───────────────────────────
    var _pickerYear = 0;

    function availableYears() {
        if (!state.min || !state.max) return [state.year];
        var y0 = parseInt(state.min.slice(0, 4), 10), y1 = parseInt(state.max.slice(0, 4), 10);
        var out = []; for (var y = y1; y >= y0; y--) out.push(y); return out;
    }

    function ensurePicker() {
        var pop = document.getElementById('calPicker');
        if (pop) return pop;
        var bar = document.querySelector('.cal-controls .report-date-bar');
        if (!bar) return null;
        bar.style.position = 'relative';
        pop = document.createElement('div');
        pop.id = 'calPicker';
        pop.className = 'cal-picker';
        pop.addEventListener('click', function (e) {
            e.stopPropagation();
            var nav = e.target.closest('[data-act]');
            if (nav) {
                var years = availableYears();
                var yi = years.indexOf(_pickerYear);
                if (nav.getAttribute('data-act') === 'py' && yi < years.length - 1) _pickerYear = years[yi + 1];
                if (nav.getAttribute('data-act') === 'ny' && yi > 0) _pickerYear = years[yi - 1];
                renderPicker();
                return;
            }
            var mb = e.target.closest('[data-m]');
            if (mb && !mb.disabled) {
                state.year = _pickerYear;
                state.month = parseInt(mb.getAttribute('data-m'), 10);
                closeMonthPicker();
                render();
            }
        });
        bar.appendChild(pop);
        return pop;
    }

    function renderPicker() {
        var pop = document.getElementById('calPicker');
        if (!pop) return;
        var years = availableYears();
        var yi = years.indexOf(_pickerYear);
        var h = '<div class="cal-picker__yr">' +
            '<button class="cal-picker__yrnav" data-act="py" type="button"' + (yi < years.length - 1 ? '' : ' disabled') + '>‹</button>' +
            '<span class="cal-picker__yrlabel">' + _pickerYear + '년</span>' +
            '<button class="cal-picker__yrnav" data-act="ny" type="button"' + (yi > 0 ? '' : ' disabled') + '>›</button>' +
            '</div><div class="cal-picker__months">';
        for (var m = 0; m < 12; m++) {
            var has = monthHasData(_pickerYear, m);
            var cur = (_pickerYear === state.year && m === state.month);
            h += '<button type="button" class="cal-picker__m' + (cur ? ' cal-picker__m--cur' : '') +
                '" data-m="' + m + '"' + (has ? '' : ' disabled') + '>' + (m + 1) + '월</button>';
        }
        h += '</div>';
        pop.innerHTML = h;
    }

    function toggleMonthPicker() {
        var pop = document.getElementById('calPicker');
        if (pop && pop.classList.contains('open')) { closeMonthPicker(); return; }
        pop = ensurePicker();
        if (!pop) return;
        _pickerYear = state.year;
        renderPicker();
        pop.classList.add('open');
        setTimeout(function () { document.addEventListener('click', outsidePicker, true); }, 0);
    }

    function closeMonthPicker() {
        var pop = document.getElementById('calPicker');
        if (pop) pop.classList.remove('open');
        document.removeEventListener('click', outsidePicker, true);
    }

    function outsidePicker(e) {
        var pop = document.getElementById('calPicker');
        if (pop && !pop.contains(e.target) && e.target.id !== 'calLabel') closeMonthPicker();
    }

    function bind() {
        document.getElementById('calPrev').addEventListener('click', function () { shiftMonth(-1); });
        document.getElementById('calNext').addEventListener('click', function () { shiftMonth(1); });
        var $lbl = document.getElementById('calLabel');
        if ($lbl) $lbl.addEventListener('click', function (e) { e.stopPropagation(); toggleMonthPicker(); });
        var $save = document.getElementById('calSave');
        if ($save) $save.addEventListener('click', savePNG);
        document.getElementById('calToggle').addEventListener('click', function (e) {
            var btn = e.target.closest('.seg__btn');
            if (btn) setType(btn.getAttribute('data-type'));
        });
        // 범례 칩 클릭 → 해당 대장 색 활성/해제 (칸은 모두 링크라 별도 토글 없음)
        document.getElementById('calLegend').addEventListener('click', function (e) {
            var btn = e.target.closest('.cal-legend__item');
            if (btn) toggleLeader(btn.getAttribute('data-leader'));
        });
        var $t = document.getElementById('themeToggle');
        if ($t) $t.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var nx = cur === 'light' ? 'dark' : 'light';
            if (nx === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('theme', nx);
        });
    }

    function init() {
        bind();
        var $loading = document.getElementById('calLoading');
        var $msg = document.getElementById('calMessage');
        $loading.style.display = 'block';
        fetch(DATA_URL, { cache: 'no-cache' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                $loading.style.display = 'none';
                state.days = (data && data.days) || {};
                var keys = Object.keys(state.days).sort();
                if (!keys.length) { $msg.textContent = '데이터가 없습니다.'; $msg.style.display = 'block'; return; }
                state.min = keys[0]; state.max = keys[keys.length - 1];
                state.year = parseInt(state.max.slice(0, 4), 10);
                state.month = parseInt(state.max.slice(4, 6), 10) - 1;
                render();
            })
            .catch(function (err) {
                $loading.style.display = 'none';
                $msg.textContent = '로딩 실패: ' + err.message;
                $msg.style.display = 'block';
            });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
