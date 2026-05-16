/**
 * 리포트 페이지 — 사전 집계된 report-summary.json fetch + 기간 토글.
 *
 * 데이터: scripts/build-history.py build_report_summary() 가 빌드 끝에 생성.
 *   { periods: { d1, w1, m1, m3, y1 }, total_tickers, built_at, ... + y1 top-level 미러 }
 */
(function () {
    var PERIODS = ['d1', 'w1', 'm1', 'm3', 'y1'];
    var PERIOD_LABEL = { d1: '1일', w1: '1주', m1: '1달', m3: '3달', y1: '1년' };

    var state = { period: 'd1', summary: null };
    // 차단 종목 — 모든 페이지에서 가려짐 (에이프로젠바이오로직스/졸스/에이프로젠)
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };
    // 라이브 polling — 홈과 동일 60s (장중 + 탭 visible)
    var POLL_MS = 60 * 1000;
    var KST_OFFSET = 9 * 60;
    var OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 30;
    function isMarketOpenKST() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }

    /** HTML 이스케이프 — XSS 방어. */
    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function bindThemeToggle() {
        var $btn = document.getElementById('themeToggle');
        if (!$btn) return;
        $btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('theme', next);
        });
    }

    function fmt(n) { return (n != null) ? n.toLocaleString('ko-KR') : '-'; }

    function pct(n) {
        if (n == null) return '-';
        return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    }

    /** bar — primary 수치(상승률) 기반 바, count 는 우측 라벨로. */
    function bar(primary, max, label, sub, countLabel) {
        var width = max > 0 ? (primary / max * 100).toFixed(1) : 0;
        return '<li class="report-row">' +
            '<div class="report-row__bar" style="width:' + width + '%"></div>' +
            '<div class="report-row__content">' +
            '<span class="report-row__label">' + label + '</span>' +
            (sub ? '<span class="report-row__sub">' + sub + '</span>' : '') +
            '<span class="report-row__count">' + countLabel + '</span>' +
            '</div></li>';
    }

    function emptyMsg(period) {
        var label = PERIOD_LABEL[period] || '';
        if (period === 'd1') {
            return '<li class="report-empty">최근 1거래일 동안 +15% 이상 오른 종목이 없습니다 — 1주 이상의 기간을 선택해보세요</li>';
        }
        return '<li class="report-empty">' + label + ' 기간엔 자료가 부족합니다 — 더 긴 기간을 선택해보세요</li>';
    }

    function renderSectorTop(rows) {
        var $el = document.getElementById('sectorTop');
        if (!rows || !rows.length) { $el.innerHTML = emptyMsg(state.period); return; }
        var hasSumRate = rows[0].sum_rate != null;
        var key = hasSumRate ? 'sum_rate' : 'count';
        var max = Math.max.apply(null, rows.map(function (r) { return r[key]; }));
        $el.innerHTML = rows.map(function (r) {
            var sub = '평균 ' + pct(r.avg_rate) + ' · ' + r.tickers + ' 종목 · ' + r.count + '회';
            var countLabel = hasSumRate ? pct(r.sum_rate) : (r.count + '회');
            return bar(r[key], max, esc(r.sector), sub, countLabel);
        }).join('');
    }

    function renderThemeTop(rows) {
        var $el = document.getElementById('themeTop');
        if (!$el) return;
        if (!rows || !rows.length) { $el.innerHTML = emptyMsg(state.period); return; }
        var key = 'sum_rate';
        var max = Math.max.apply(null, rows.map(function (r) { return r[key]; }));
        $el.innerHTML = rows.map(function (r) {
            var sub = '평균 ' + pct(r.avg_rate) + ' · ' + r.tickers + ' 종목 · ' + r.count + '회';
            var label = '<span class="theme-tag">' + esc(r.theme) + '</span>';
            return bar(r[key], max, label, sub, pct(r.sum_rate));
        }).join('');
    }

    /** 시총 표시 — 억원 단위 raw → 1조 5천억 같은 한국식. */
    function fmtMcap(억) {
        if (!억) return '';
        if (억 >= 10000) return (억 / 10000).toFixed(1) + '조';
        if (억 >= 1000) return (억 / 1000).toFixed(1) + '천억';
        return Math.round(억) + '억';
    }

    function renderTickerList(elId, rows, opts) {
        var $el = document.getElementById(elId);
        if (!$el) return;
        rows = (rows || []).filter(function (r) { return !BLOCKED_TICKERS[r.ticker]; });
        if (!rows.length) { $el.innerHTML = emptyMsg(state.period); return; }
        var hasSumRate = rows[0].sum_rate != null;
        var key = hasSumRate ? 'sum_rate' : 'count';
        var max = Math.max.apply(null, rows.map(function (r) { return r[key]; }));
        $el.innerHTML = rows.map(function (r) {
            var label = '<a href="/stock/' + esc(r.ticker) + '">' + esc(r.name) + '</a>';
            var subParts = [];
            if (r.market_cap) subParts.push(fmtMcap(r.market_cap));
            if (hasSumRate && r.count) subParts.push(r.count + '회');
            var sub = subParts.join(' · ');
            var countLabel = hasSumRate ? pct(r.sum_rate) : (r.count + '회');
            return bar(r[key], max, label, sub, countLabel);
        }).join('');
    }

    function fmtBuiltAt(iso) {
        if (!iso) return '';
        // 'Z' 가 있으면 UTC → KST(+9h) 변환. 없으면 그대로 (KST timezone-naive 가정)
        var t = String(iso);
        if (t.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(t)) {
            try {
                var d = new Date(t);
                var k = new Date(d.getTime() + 9 * 3600000);
                t = k.toISOString().slice(0, 19);   // 'YYYY-MM-DDTHH:MM:SS'
            } catch (e) {}
        }
        // 'YYYY-MM-DDTHH:MM:SS' → 'YYYY.MM.DD HH:MM'
        return t.slice(0, 10).replace(/-/g, '.') + ' ' + t.slice(11, 16);
    }

    function pickPeriod(summary, period) {
        if (summary && summary.periods && summary.periods[period]) return summary.periods[period];
        return {
            total_events_15: summary.total_events_15,
            total_events_all: summary.total_events_15,
            total_limit_count: 0,
            total_52w_count: 0,
            avg_rate_15: 0,
            sector_top: summary.sector_top || [],
            theme_top: [],
            limit_up_top: summary.limit_up_top || [],
            high_52w_top: summary.high_52w_top || [],
            frequent_top: summary.frequent_top || [],
        };
    }

    function applyPeriod() {
        if (!state.summary) return;
        var data = pickPeriod(state.summary, state.period);
        // 헤더 4개 stat — 전체 universe 통계
        var $e1 = document.getElementById('statTotalEvents');
        var $e2 = document.getElementById('statAvgRate');
        var $e3 = document.getElementById('statLimitCount');
        var $e4 = document.getElementById('stat52wCount');
        if ($e1) $e1.textContent = fmt(data.total_events_all || data.total_events_15);
        if ($e2) $e2.textContent = pct(data.avg_rate_15);
        if ($e3) $e3.textContent = fmt(data.total_limit_count);
        if ($e4) $e4.textContent = fmt(data.total_52w_count);

        renderSectorTop(data.sector_top);
        renderThemeTop(data.theme_top);
        renderTickerList('limitTop', data.limit_up_top);
        renderTickerList('high52w', data.high_52w_top);
        renderTickerList('frequentTop', data.frequent_top, { showTicker: true });
    }

    function bindPeriodTabs() {
        var $tabs = document.getElementById('reportPeriodTabs');
        if (!$tabs) return;
        $tabs.addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-p]');
            if (!btn) return;
            var p = btn.getAttribute('data-p');
            if (!p || PERIODS.indexOf(p) < 0 || p === state.period) return;
            state.period = p;
            var btns = $tabs.querySelectorAll('button[data-p]');
            for (var i = 0; i < btns.length; i++) {
                btns[i].classList.toggle('is-active', btns[i].getAttribute('data-p') === p);
            }
            applyPeriod();
        });
    }

    /** 기간 데이터가 비어 있는지 — 모든 섹션이 0/빈 배열이면 true */
    function isPeriodEmpty(p) {
        if (!p) return true;
        var total = p.total_events_15 || p.total_events_all || 0;
        if (total > 0) return false;
        var lists = ['sector_top', 'theme_top', 'limit_up_top', 'high_52w_top', 'frequent_top'];
        for (var i = 0; i < lists.length; i++) {
            if ((p[lists[i]] || []).length > 0) return false;
        }
        return true;
    }

    /** firstLoad 일 때 d1 비어 있으면 가장 가까운 비어있지 않은 기간으로 자동 전환 (1주 → 1달 → 3달 → 1년) */
    function pickInitialPeriod(summary) {
        if (!summary || !summary.periods) return 'd1';
        for (var i = 0; i < PERIODS.length; i++) {
            var p = PERIODS[i];
            if (!isPeriodEmpty(summary.periods[p])) return p;
        }
        return 'd1';
    }

    function setActiveTab(period) {
        var $tabs = document.getElementById('reportPeriodTabs');
        if (!$tabs) return;
        var btns = $tabs.querySelectorAll('button[data-p]');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('is-active', btns[i].getAttribute('data-p') === period);
        }
    }

    function fetchSummary(firstLoad) {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        var $grid = document.getElementById('reportGrid');
        var cacheBust = '?v=' + Date.now();
        return fetch('/data/report-summary.json' + cacheBust, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (s) {
                state.summary = s;
                if (firstLoad) {
                    $loading.style.display = 'none';
                    $grid.style.display = 'grid';
                    // 1일(d1) 이 비어 있으면 (휴장·집계 전 등) 가장 가까운 채워진 기간으로 자동 전환
                    if (isPeriodEmpty(s.periods && s.periods[state.period])) {
                        var fallback = pickInitialPeriod(s);
                        if (fallback !== state.period) {
                            state.period = fallback;
                            setActiveTab(fallback);
                        }
                    }
                }
                // REPORT 라벨에 빌드 시각 합침 — 'REPORT · YYYY.MM.DD HH:MM' (KST)
                var $lab = document.getElementById('reportLiveLabel');
                if ($lab && s.built_at) {
                    var formatted = fmtBuiltAt(s.built_at);
                    $lab.textContent = formatted ? ('REPORT · ' + formatted) : 'REPORT';
                }
                applyPeriod();
            })
            .catch(function (err) {
                if (firstLoad) {
                    $loading.style.display = 'none';
                    $msg.textContent = '리포트 로딩 실패: ' + err.message + ' — 다음 빌드 후 표시됩니다.';
                    $msg.style.display = 'block';
                }
            });
    }

    function init() {
        bindThemeToggle();
        bindPeriodTabs();
        fetchSummary(true);
        // 라이브 polling — 홈과 동일 60s, 장중 + 탭 visible 일 때만
        setInterval(function () {
            if (!isMarketOpenKST()) return;
            if (document.visibilityState === 'hidden') return;
            fetchSummary(false);
        }, POLL_MS);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
