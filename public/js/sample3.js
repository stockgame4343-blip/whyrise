/**
 * 샘플3 — 대장 캘린더 (개선판)
 * - 월간 캘린더(평일 5열) + 선택 날짜 상세(데스크톱 우측 패널 / 모바일 바텀시트)
 * - 상세는 대장주·대장섹터·대장테마(이유·거래대금 포함)를 한 번에
 * - 반복 대장: 색 dot + ×N 배지로 범례 없이도 의미가 읽힘
 * - 셀 클릭 = 날짜 선택(상세 열기), 상세의 대장주는 종목 상세로 링크
 * 데이터는 sample2와 동일: /data/leaders-calendar.json
 */
(function () {
    'use strict';

    var DATA_URL = '/data/leaders-calendar.json?v=20260616k';
    var DOW_W = ['월', '화', '수', '목', '금'];          // 평일만 (주말 제외)
    var DOW_FULL = ['일', '월', '화', '수', '목', '금', '토'];
    var TYPE_LABEL = { stock: '대장주', sector: '대장 섹터', theme: '대장 테마' };

    var state = { days: {}, type: 'stock', year: 0, month: 0, min: null, max: null,
        colorMap: {}, counts: {}, selected: null, filter: {} };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var PALETTE = ['#5485e0', '#e8685a', '#36b394', '#b275d4', '#e8a544', '#45b4d0', '#e06f9e', '#74c95c', '#7e6ee0', '#e88848'];
    function colorOf(name) { return (state.colorMap && state.colorMap[name]) || ''; }

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

    function fmtDateLabel(key) {
        var y = +key.slice(0, 4), m = +key.slice(4, 6), d = +key.slice(6, 8);
        return m + '월 ' + d + '일 (' + DOW_FULL[new Date(y, m - 1, d).getDay()] + ')';
    }
    function fmtDot(key) { return key.slice(0, 4) + '.' + key.slice(4, 6) + '.' + key.slice(6, 8); }

    function monthHasData(y, m) {
        var prefix = String(y) + ('0' + (m + 1)).slice(-2);
        return Object.keys(state.days).some(function (k) { return k.indexOf(prefix) === 0; });
    }

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

    // ── 캘린더 셀 ──────────────────────────────────────────────
    function cellInner(key, lead, count, color) {
        var d = +key.slice(6, 8);
        var dot = color ? '<span class="c3-dot" style="background:' + color + '"></span>' : '';
        var badge = count >= 2
            ? '<span class="c3-badge"' + (color ? ' style="color:' + color + ';border-color:' + color + '66"' : '') + '>×' + count + '</span>'
            : '';
        var rate = state.type === 'stock'
            ? '+' + Number(lead.rate).toFixed(1) + '%'
            : '평균 +' + Number(lead.avgRate).toFixed(1) + '%';
        return '<div class="c3-cell__top"><span class="c3-cell__date">' + d + '</span>' + badge + '</div>' +
            '<div class="c3-cell__name">' + dot + '<span>' + esc(lead.name) + '</span></div>' +
            '<div class="c3-cell__rate">' + rate + '</div>';
    }

    function cellHtml(y, m, d) {
        var key = ymd(y, m, d);
        var day = state.days[key];
        var dow = new Date(y, m, d).getDay();
        var dateTop = '<div class="c3-cell__top"><span class="c3-cell__date">' + d + '</span></div>';

        if (!day) {
            var cls = 'c3-cell c3-cell--empty';
            var center = '';
            if (dow === 0 || dow === 6) {
                cls += ' c3-cell--weekend';   // 숨김 처리 (5열)
            } else if (key >= state.min && key <= state.max) {
                cls += ' c3-cell--holiday';
                center = '<span class="c3-cell__off">휴장</span>';
            } else if (key > state.max) {
                cls += ' c3-cell--future';     // 아직 데이터 없는 미래 평일
            }
            return '<div class="' + cls + '">' + dateTop + '<div class="c3-cell__center">' + center + '</div></div>';
        }

        var lead = day[state.type];
        if (!lead) {
            return '<div class="c3-cell c3-cell--data c3-cell--noleader" data-date="' + key + '">' + dateTop +
                '<div class="c3-cell__center"><span class="c3-cell__none">대장 없음</span></div></div>';
        }

        var cnt = state.counts[lead.name] || 0;
        var color = cnt >= 2 ? colorOf(lead.name) : '';
        var sel = state.selected === key ? ' c3-cell--selected' : '';
        return '<div class="c3-cell c3-cell--data' + sel + '" data-date="' + key + '" data-leader="' + esc(lead.name) + '">' +
            cellInner(key, lead, cnt, color) + '</div>';
    }

    // ── 상세 (대장주·섹터·테마 한 번에) ─────────────────────────
    function sectionHtml(label, e, isStock) {
        if (!e) return '<section class="c3-det__sec"><div class="c3-det__label">' + label + '</div><div class="c3-det__empty">기록 없음</div></section>';
        var body;
        if (isStock) {
            var tag = e.theme || e.sector || '대장';
            var reason = e.reason || [e.sector, e.theme].filter(Boolean).join(' · ') || '거래대금 상위';
            body = '<div class="c3-det__name">' + esc(e.name) + '<span class="c3-chev">›</span></div>' +
                '<div class="c3-det__metric"><b>+' + Number(e.rate).toFixed(1) + '%</b>' + (e.vol ? ' · 거래 ' + fmtAmount(e.vol) : '') + '</div>' +
                '<div class="c3-det__reason">[' + esc(tag) + '] ' + esc(reason) + '</div>';
            if (e.ticker) {
                return '<section class="c3-det__sec"><div class="c3-det__label">' + label + '</div>' +
                    '<a class="c3-det__lead c3-det__lead--link" href="/stock/' + esc(e.ticker) + '">' + body + '</a></section>';
            }
            return '<section class="c3-det__sec"><div class="c3-det__label">' + label + '</div><div class="c3-det__lead">' + body + '</div></section>';
        }
        body = '<div class="c3-det__name">' + esc(e.name) + '</div>' +
            '<div class="c3-det__metric">' + e.count + '종목 · 평균 +' + Number(e.avgRate).toFixed(1) + '%' + (e.vol ? ' · 거래 ' + fmtAmount(e.vol) : '') + '</div>' +
            (e.top ? '<div class="c3-det__reason">대장 ' + esc(e.top) + '</div>' : '');
        return '<section class="c3-det__sec"><div class="c3-det__label">' + label + '</div><div class="c3-det__lead">' + body + '</div></section>';
    }

    function detailHtml(key) {
        var day = state.days[key];
        if (!day) return '';
        return '<div class="c3-det__date">' + fmtDateLabel(key) + '</div>' +
            '<div class="c3-det__secs">' +
            sectionHtml('대장주', day.stock, true) +
            sectionHtml('대장 섹터', day.sector, false) +
            sectionHtml('대장 테마', day.theme, false) +
            '</div>';
    }

    function renderDetail() {
        var panel = document.getElementById('c3Detail');
        var sheetBody = document.getElementById('c3SheetBody');
        var key = state.selected;
        if (!key || !state.days[key]) {
            var ph = '<div class="c3-det__placeholder">날짜를 누르면 그날의 대장주·대장 섹터·대장 테마를 한눈에 볼 수 있어요.</div>';
            if (panel) panel.innerHTML = ph;
            return;
        }
        var html = detailHtml(key);
        if (panel) panel.innerHTML = html;
        if (sheetBody) sheetBody.innerHTML = html;
    }

    // ── 바텀시트 (모바일) ──────────────────────────────────────
    function isMobile() { return window.matchMedia('(max-width: 860px)').matches; }
    function openSheet() { var s = document.getElementById('c3Sheet'); if (s) { s.classList.add('c3-sheet--open'); s.setAttribute('aria-hidden', 'false'); document.body.classList.add('c3-noscroll'); } }
    function closeSheet() { var s = document.getElementById('c3Sheet'); if (s) { s.classList.remove('c3-sheet--open'); s.setAttribute('aria-hidden', 'true'); document.body.classList.remove('c3-noscroll'); } }

    function selectDate(key, fromClick) {
        if (!state.days[key]) return;
        state.selected = key;
        var cells = document.querySelectorAll('#c3Grid .c3-cell--data');
        Array.prototype.forEach.call(cells, function (c) {
            c.classList.toggle('c3-cell--selected', c.getAttribute('data-date') === key);
        });
        renderDetail();
        if (fromClick && isMobile()) openSheet();
    }

    // ── 범례 (클릭 시 해당 대장 칸 강조 / 나머지 흐리게) ─────────
    function applyFilter() {
        var keys = Object.keys(state.filter);
        var any = keys.length > 0;
        var cells = document.querySelectorAll('#c3Grid .c3-cell--data[data-leader]');
        Array.prototype.forEach.call(cells, function (c) {
            var name = c.getAttribute('data-leader');
            var on = !!state.filter[name];
            c.classList.toggle('c3-cell--lit', on);
            c.classList.toggle('c3-cell--dim', any && !on);
            if (on) c.style.setProperty('--lit', state.filter[name]); else c.style.removeProperty('--lit');
        });
    }

    function syncLegendActive() {
        var items = document.querySelectorAll('#c3Legend .c3-legend__item');
        Array.prototype.forEach.call(items, function (it) {
            var c = state.filter[it.getAttribute('data-leader')];
            it.classList.toggle('c3-legend__item--active', !!c);
            it.style.background = c ? (c + '1f') : '';
            it.style.borderColor = c ? c : '';
        });
    }

    function toggleFilter(name) {
        var c = colorOf(name);
        if (!c) return;
        if (state.filter[name]) delete state.filter[name];
        else state.filter[name] = c;
        applyFilter();
        syncLegendActive();
    }

    function renderLegend() {
        var $legend = document.getElementById('c3Legend');
        var repeated = Object.keys(state.counts).filter(function (n) { return state.counts[n] >= 2; })
            .sort(function (a, b) { return state.counts[b] - state.counts[a]; });
        if (!repeated.length) { $legend.style.display = 'none'; return; }
        var html = '<div class="c3-legend__head">이 달 여러 번 ' + TYPE_LABEL[state.type] +
            ' <span class="c3-legend__hint">— 누르면 해당 칸만 강조</span></div><div class="c3-legend__items">';
        repeated.forEach(function (n) {
            var c = colorOf(n);
            html += '<button type="button" class="c3-legend__item" data-leader="' + esc(n) + '">' +
                '<span class="c3-legend__dot" style="background:' + c + '"></span>' +
                esc(n) + ' <span class="c3-legend__count">×' + state.counts[n] + '</span></button>';
        });
        html += '</div>';
        $legend.innerHTML = html;
        $legend.style.display = 'block';
    }

    // ── 렌더 ───────────────────────────────────────────────────
    function render() {
        var y = state.year, m = state.month;
        document.getElementById('c3Label').textContent = y + '. ' + ('0' + (m + 1)).slice(-2) + '.';
        var prev = new Date(y, m - 1, 1), next = new Date(y, m + 1, 1);
        document.getElementById('c3Prev').disabled = !monthHasData(prev.getFullYear(), prev.getMonth());
        document.getElementById('c3Next').disabled = !monthHasData(next.getFullYear(), next.getMonth());

        state.counts = monthCounts();
        state.colorMap = {};
        Object.keys(state.counts).filter(function (n) { return state.counts[n] >= 2; })
            .sort(function (a, b) { return state.counts[b] - state.counts[a]; })
            .forEach(function (n, i) { state.colorMap[n] = PALETTE[i % PALETTE.length]; });
        state.filter = {};   // 월/타입 전환 시 강조 초기화

        var first = new Date(y, m, 1).getDay();
        var daysInMonth = new Date(y, m + 1, 0).getDate();
        var html = '';
        DOW_W.forEach(function (dn) { html += '<div class="c3-dow">' + dn + '</div>'; });
        // 선두 빈칸: 일(0)·토(6)는 5열에서 숨김. 평일 빈칸만 자리 차지.
        for (var b = 0; b < first; b++) {
            if (b === 0 || b === 6) continue;           // 일요일 선두칸 스킵
            html += '<div class="c3-cell c3-cell--blank"></div>';
        }
        for (var d = 1; d <= daysInMonth; d++) html += cellHtml(y, m, d);
        document.getElementById('c3Grid').innerHTML = html;
        renderLegend();

        // 선택 날짜 유지(현재 달에 있으면) — 없으면 이 달 마지막 데이터일로
        if (!state.selected || state.selected.indexOf(String(y) + ('0' + (m + 1)).slice(-2)) !== 0) {
            var prefix = String(y) + ('0' + (m + 1)).slice(-2);
            var inMonth = Object.keys(state.days).filter(function (k) { return k.indexOf(prefix) === 0; }).sort();
            state.selected = inMonth.length ? inMonth[inMonth.length - 1] : null;
        }
        selectDate(state.selected, false);
        applyFilter();
    }

    function setType(type) {
        state.type = type;
        document.querySelectorAll('#c3Toggle .seg__btn').forEach(function (b) {
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

    function bind() {
        document.getElementById('c3Prev').addEventListener('click', function () { shiftMonth(-1); });
        document.getElementById('c3Next').addEventListener('click', function () { shiftMonth(1); });
        document.getElementById('c3Toggle').addEventListener('click', function (e) {
            var btn = e.target.closest('.seg__btn');
            if (btn) setType(btn.getAttribute('data-type'));
        });
        // 셀 클릭 → 날짜 선택(상세 열기). 종목 상세 이동은 상세 패널의 대장주 링크로.
        document.getElementById('c3Grid').addEventListener('click', function (e) {
            var cell = e.target.closest('.c3-cell--data[data-date]');
            if (cell) selectDate(cell.getAttribute('data-date'), true);
        });
        // 범례 클릭 → 해당 대장 강조
        document.getElementById('c3Legend').addEventListener('click', function (e) {
            var btn = e.target.closest('.c3-legend__item');
            if (btn) toggleFilter(btn.getAttribute('data-leader'));
        });
        // 바텀시트 닫기
        document.getElementById('c3SheetClose').addEventListener('click', closeSheet);
        document.getElementById('c3SheetBackdrop').addEventListener('click', closeSheet);
        window.addEventListener('resize', function () { if (!isMobile()) closeSheet(); });

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
        var $loading = document.getElementById('c3Loading');
        var $msg = document.getElementById('c3Message');
        var $layout = document.getElementById('c3Layout');
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
                document.getElementById('c3Sub').innerHTML =
                    '거래일(평일) 기준 · 반복 대장은 <b>같은 색</b> · 최신 <b>' + fmtDot(state.max) + '</b> · 날짜를 누르면 그날 상세';
                $layout.style.display = 'grid';
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
