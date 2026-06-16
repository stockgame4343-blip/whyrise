/**
 * 샘플2 — 오늘의 대장 캘린더
 * public/data/leaders-calendar.json (일자별 대장주/섹터/테마) 를 월 캘린더로 렌더.
 * 한 달에 여러 번 대장인(반복) 항목만 같은 색 dot 으로 표시해 흐름을 인지하게 한다.
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
    function dotOf(name) { return 'hsl(' + hueOf(name) + ', 60%, 56%)'; }

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

    // 칸 하단 — '섹/테' 가 아니라 선택한 대장 '자신의' 정보로 채움
    function subInfo(day, type) {
        var e = day[type];
        if (!e) return '';
        var lines = [];
        if (type === 'stock') {
            if (e.theme) lines.push(['테마', e.theme]);
            if (e.sector && e.sector !== e.theme) lines.push(['섹터', e.sector]);
        } else {
            if (e.avgRate != null) lines.push(['평균', '+' + Number(e.avgRate).toFixed(1) + '%']);
            if (e.top) lines.push(['대장', e.top]);
        }
        return lines.map(function (l) {
            return '<span class="cal-cell__subitem"><b>' + l[0] + '</b> ' + esc(l[1]) + '</span>';
        }).join('');
    }

    function cellHtml(y, m, d, counts) {
        var key = ymd(y, m, d);
        var day = state.days[key];
        var dow = new Date(y, m, d).getDay();
        var dateNum = '<span class="cal-cell__date">' + d + '</span>';
        var todayCls = (key === todayYmd()) ? ' cal-cell--today' : '';

        if (!day) {
            var cls = 'cal-cell cal-cell--empty' + todayCls;
            var off = '';
            if (dow === 0 || dow === 6) {
                cls += ' cal-cell--weekend';
            } else if (key >= state.min && key <= state.max) {
                // 데이터 기간 안의 평일인데 기록 없음 = 공휴일(휴장) — 살짝만 표시
                cls += ' cal-cell--holiday';
                off = '<span class="cal-cell__off">휴장</span>';
            }
            return '<div class="' + cls + '">' + dateNum + off + '</div>';
        }

        var lead = day[state.type];
        var body;
        if (lead) {
            var repeated = counts[lead.name] >= 2;
            var dot = repeated ? '<span class="cal-cell__dot" style="background:' + dotOf(lead.name) + '"></span>' : '';
            var metric = (state.type === 'stock')
                ? (lead.rate != null ? '<span class="cal-cell__rate">+' + Number(lead.rate).toFixed(1) + '%</span>' : '')
                : (lead.count ? '<span class="cal-cell__count">' + lead.count + '종목</span>' : '');
            body = '<div class="cal-cell__lead">' + dot +
                '<span class="cal-cell__name">' + esc(lead.name) + '</span></div>' +
                metric + '<div class="cal-cell__sub">' + subInfo(day, state.type) + '</div>';
        } else {
            body = '<div class="cal-cell__none">대장 없음</div>';
        }

        if (state.type === 'stock' && lead && day.stock && day.stock.ticker) {
            return '<a class="cal-cell cal-cell--data' + todayCls + '" href="/stock/' + esc(day.stock.ticker) + '">' +
                dateNum + body + '</a>';
        }
        return '<div class="cal-cell cal-cell--data' + todayCls + '">' + dateNum + body + '</div>';
    }

    function renderLegend(counts) {
        var $legend = document.getElementById('calLegend');
        var repeated = Object.keys(counts).filter(function (n) { return counts[n] >= 2; })
            .sort(function (a, b) { return counts[b] - counts[a]; });
        if (!repeated.length) { $legend.style.display = 'none'; return; }
        var html = '<div class="cal-legend__head">이 달 여러 번 대장인 ' + TYPE_LABEL[state.type] +
            ' <span class="cal-legend__hint">— 같은 색으로 표시</span></div><div class="cal-legend__items">';
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
        document.getElementById('calLabel').textContent = y + '. ' + ('0' + (m + 1)).slice(-2) + '.';
        var prev = new Date(y, m - 1, 1), next = new Date(y, m + 1, 1);
        document.getElementById('calPrev').disabled = !monthHasData(prev.getFullYear(), prev.getMonth());
        document.getElementById('calNext').disabled = !monthHasData(next.getFullYear(), next.getMonth());

        var counts = monthCounts();
        var first = new Date(y, m, 1).getDay();
        var daysInMonth = new Date(y, m + 1, 0).getDate();
        var html = '';
        DOW.forEach(function (dn, i) {
            var c = i === 0 ? ' cal-dow--sun' : (i === 6 ? ' cal-dow--sat' : '');
            html += '<div class="cal-dow' + c + '">' + dn + '</div>';
        });
        for (var b = 0; b < first; b++) html += '<div class="cal-cell cal-cell--blank"></div>';
        for (var d = 1; d <= daysInMonth; d++) html += cellHtml(y, m, d, counts);
        document.getElementById('calGrid').innerHTML = html;
        renderLegend(counts);
    }

    function bind() {
        document.getElementById('calPrev').addEventListener('click', function () { shiftMonth(-1); });
        document.getElementById('calNext').addEventListener('click', function () { shiftMonth(1); });
        document.getElementById('calToggle').addEventListener('click', function (e) {
            var btn = e.target.closest('.seg__btn');
            if (btn) setType(btn.getAttribute('data-type'));
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
