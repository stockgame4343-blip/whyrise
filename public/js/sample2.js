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
            ' <span class="cal-legend__hint">— 누르면 달력에서 강조</span></div><div class="cal-legend__items">';
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

    function bind() {
        document.getElementById('calPrev').addEventListener('click', function () { shiftMonth(-1); });
        document.getElementById('calNext').addEventListener('click', function () { shiftMonth(1); });
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
