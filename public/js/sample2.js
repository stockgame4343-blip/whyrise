/**
 * 샘플2 — 오늘의 대장 캘린더
 * public/data/leaders-calendar.json (일자별 대장주/섹터/테마) 를 월 캘린더로 렌더.
 * 같은 대장 = 같은 색(이름 해시→hue, 옅은 tint) 으로 한 달 흐름을 시각화.
 */
(function () {
    'use strict';

    var DATA_URL = '/data/leaders-calendar.json';
    var DOW = ['일', '월', '화', '수', '목', '금', '토'];
    var TYPE_LABEL = { stock: '대장주', sector: '대장 섹터', theme: '대장 테마' };

    var state = { days: {}, type: 'stock', year: 0, month: 0, min: null, max: null };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 이름 → 안정적인 hue(0~359). 같은 이름 = 같은 색.
    function hueOf(name) {
        var s = String(name || ''), h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
        return h;
    }
    function tintOf(name) { return name ? 'hsla(' + hueOf(name) + ', 72%, 55%, 0.26)' : 'transparent'; }
    function dotOf(name) { return 'hsl(' + hueOf(name) + ', 60%, 58%)'; }

    function ymd(y, m, d) {
        return String(y) + ('0' + (m + 1)).slice(-2) + ('0' + d).slice(-2);
    }
    function leaderName(day, type) {
        var e = day && day[type];
        return e ? e.name : '';
    }

    function todayYmd() {
        var k = new Date(Date.now() + 9 * 3600000); // KST
        return k.getUTCFullYear() + ('0' + (k.getUTCMonth() + 1)).slice(-2) + ('0' + k.getUTCDate()).slice(-2);
    }

    function setType(type) {
        state.type = type;
        document.querySelectorAll('.cal-toggle__btn').forEach(function (b) {
            b.classList.toggle('cal-toggle__btn--active', b.getAttribute('data-type') === type);
        });
        render();
    }

    function shiftMonth(delta) {
        var m = state.month + delta, y = state.year;
        if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
        state.year = y; state.month = m;
        render();
    }

    // 해당 월에 데이터가 한 건이라도 있는지 (네비 활성화 판단)
    function monthHasData(y, m) {
        var prefix = String(y) + ('0' + (m + 1)).slice(-2);
        return Object.keys(state.days).some(function (k) { return k.indexOf(prefix) === 0; });
    }

    function subItems(day, type) {
        var order = { stock: ['sector', 'theme'], sector: ['stock', 'theme'], theme: ['stock', 'sector'] };
        return (order[type] || []).map(function (t) {
            var e = day[t];
            if (!e) return '';
            var tag = t === 'stock' ? '주' : (t === 'sector' ? '섹' : '테');
            return '<span class="cal-cell__subitem"><b>' + tag + '</b> ' + esc(e.name) + '</span>';
        }).join('');
    }

    function cellHtml(y, m, d) {
        var key = ymd(y, m, d);
        var day = state.days[key];
        var dowClass = '';
        var dow = new Date(y, m, d).getDay();
        var dateNum = '<span class="cal-cell__date">' + d + '</span>';
        var todayCls = (key === todayYmd()) ? ' cal-cell--today' : '';
        if (!day) {
            return '<div class="cal-cell cal-cell--empty' + todayCls + '">' + dateNum + '</div>';
        }
        var lead = day[state.type];
        var tint = '<span class="cal-cell__tint" style="background:' + (lead ? tintOf(lead.name) : 'transparent') + '"></span>';
        var body;
        if (lead) {
            var rate = (state.type === 'stock' && lead.rate != null)
                ? '<span class="cal-cell__rate">+' + lead.rate.toFixed(1) + '%</span>' : '';
            var meta = (state.type !== 'stock' && lead.count)
                ? '<span class="cal-cell__rate" style="color:var(--text-secondary)">' + lead.count + '종목</span>' : '';
            body = '<div class="cal-cell__lead"><span class="cal-cell__name">' + esc(lead.name) + '</span>' +
                rate + meta + '</div>';
        } else {
            body = '<div class="cal-cell__none">대장 없음</div>';
        }
        var sub = '<div class="cal-cell__sub">' + subItems(day, state.type) + '</div>';
        // 대장주일 때 종목 상세로 링크 (색은 칸 전체 배경 틴트로만 표현)
        if (state.type === 'stock' && lead && day.stock && day.stock.ticker) {
            return '<a class="cal-cell cal-cell--data' + todayCls + '" href="/stock/' + esc(day.stock.ticker) + '">' +
                tint + dateNum + body + sub + '</a>';
        }
        return '<div class="cal-cell cal-cell--data' + todayCls + '">' + tint + dateNum + body + sub + '</div>';
    }

    function renderLegend() {
        var $legend = document.getElementById('calLegend');
        var prefix = String(state.year) + ('0' + (state.month + 1)).slice(-2);
        var counts = {};
        Object.keys(state.days).forEach(function (k) {
            if (k.indexOf(prefix) !== 0) return;
            var nm = leaderName(state.days[k], state.type);
            if (nm) counts[nm] = (counts[nm] || 0) + 1;
        });
        var repeated = Object.keys(counts).filter(function (n) { return counts[n] >= 2; })
            .sort(function (a, b) { return counts[b] - counts[a]; });
        if (!repeated.length) { $legend.style.display = 'none'; return; }
        var html = '<div class="cal-legend__head">이 달 ' + TYPE_LABEL[state.type] + ' — 여러 번 대장 (' + repeated.length + ')</div>' +
            '<div class="cal-legend__items">';
        repeated.forEach(function (n) {
            html += '<span class="cal-legend__item"><span class="cal-legend__dot" style="background:' + dotOf(n) + '"></span>' +
                esc(n) + ' <span class="cal-legend__count">×' + counts[n] + '</span></span>';
        });
        html += '</div>';
        $legend.innerHTML = html;
        $legend.style.display = 'block';
    }

    function render() {
        var y = state.year, m = state.month;
        document.getElementById('calLabel').textContent = y + '. ' + ('0' + (m + 1)).slice(-2);
        // 네비 활성화 — 데이터 범위 안에서만
        var prev = new Date(y, m - 1, 1), next = new Date(y, m + 1, 1);
        document.getElementById('calPrev').disabled = !monthHasData(prev.getFullYear(), prev.getMonth());
        document.getElementById('calNext').disabled = !monthHasData(next.getFullYear(), next.getMonth());

        var first = new Date(y, m, 1).getDay();
        var daysInMonth = new Date(y, m + 1, 0).getDate();
        var html = '';
        DOW.forEach(function (d, i) {
            var c = i === 0 ? ' cal-dow--sun' : (i === 6 ? ' cal-dow--sat' : '');
            html += '<div class="cal-dow' + c + '">' + d + '</div>';
        });
        for (var b = 0; b < first; b++) html += '<div class="cal-cell cal-cell--blank"></div>';
        for (var d = 1; d <= daysInMonth; d++) html += cellHtml(y, m, d);
        document.getElementById('calGrid').innerHTML = html;
        renderLegend();
    }

    function bind() {
        document.getElementById('calPrev').addEventListener('click', function () { shiftMonth(-1); });
        document.getElementById('calNext').addEventListener('click', function () { shiftMonth(1); });
        document.getElementById('calToggle').addEventListener('click', function (e) {
            var btn = e.target.closest('.cal-toggle__btn');
            if (btn) setType(btn.getAttribute('data-type'));
        });
        // 다크/라이트 토글 (다른 페이지와 동일 동작)
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
                // 최신 데이터 월로 시작
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
