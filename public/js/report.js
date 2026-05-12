/**
 * 리포트 페이지 — 사전 집계된 report-summary.json 한 번 fetch 후
 * 기간 토글(1D/1W/1M/3M/1Y) 별 위젯 렌더.
 *
 * 데이터: scripts/build-history.py 의 build_report_summary() 가 빌드 끝에 생성.
 *   { periods: { d1, w1, m1, m3, y1 }, total_tickers, built_at, ... + y1 미러 }
 * 갱신: 평일 KST 09:10 / 15:40 incremental + 일요일 06:00 full 시 자동.
 */
(function () {
    var PERIODS = ['d1', 'w1', 'm1', 'm3', 'y1'];
    var PERIOD_LABEL = { d1: '1일', w1: '1주', m1: '1개월', m3: '3개월', y1: '1년' };

    var state = {
        period: 'y1',
        summary: null,
    };

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

    function fmt(n) {
        return (n != null) ? n.toLocaleString('ko-KR') : '-';
    }

    function pct(n) {
        if (n == null) return '-';
        return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    }

    /** bar — primary 수치(상승률) 강조, count 는 우측 보조 라벨로. */
    function bar(primary, max, label, sub, countLabel) {
        var width = max ? (primary / max * 100).toFixed(1) : 0;
        return '<li class="report-row">' +
            '<div class="report-row__bar" style="width:' + width + '%"></div>' +
            '<div class="report-row__content">' +
            '<span class="report-row__label">' + label + '</span>' +
            (sub ? '<span class="report-row__sub">' + sub + '</span>' : '') +
            '<span class="report-row__count">' + countLabel + '</span>' +
            '</div></li>';
    }

    function renderSectorTop(rows) {
        var $el = document.getElementById('sectorTop');
        if (!rows || !rows.length) { $el.innerHTML = '<li class="report-empty">데이터 없음</li>'; return; }
        var hasSumRate = rows[0].sum_rate != null;
        var key = hasSumRate ? 'sum_rate' : 'count';
        var max = Math.max.apply(null, rows.map(function (r) { return r[key]; }));
        $el.innerHTML = rows.map(function (r) {
            var sub = '평균 ' + pct(r.avg_rate) + ' · ' + r.tickers + ' 종목';
            var countLabel = hasSumRate ? pct(r.sum_rate) : (r.count + '회');
            return bar(r[key], max, r.sector, sub, countLabel);
        }).join('');
    }

    function renderTickerList(elId, rows, opts) {
        var $el = document.getElementById(elId);
        if (!rows || !rows.length) { $el.innerHTML = '<li class="report-empty">데이터 없음</li>'; return; }
        var hasSumRate = rows[0].sum_rate != null;
        var key = hasSumRate ? 'sum_rate' : 'count';
        var max = Math.max.apply(null, rows.map(function (r) { return r[key]; }));
        $el.innerHTML = rows.map(function (r) {
            var label = '<a href="/stock/' + r.ticker + '">' + r.name + '</a>';
            var subParts = [];
            if (opts && opts.showTicker) subParts.push(r.ticker);
            if (hasSumRate) subParts.push(r.count + '회');
            var sub = subParts.join(' · ');
            var countLabel = hasSumRate ? pct(r.sum_rate) : (r.count + '회');
            return bar(r[key], max, label, sub, countLabel);
        }).join('');
    }

    function renderReasonTop(rows) {
        var $el = document.getElementById('reasonTop');
        if (!rows || !rows.length) { $el.innerHTML = '<li class="report-empty">데이터 없음</li>'; return; }
        var max = Math.max.apply(null, rows.map(function (r) { return r.count; }));
        $el.innerHTML = rows.map(function (r) {
            return bar(r.count, max, r.reason, '', r.count + '회');
        }).join('');
    }

    function fmtBuiltAt(iso) {
        if (!iso) return '';
        try {
            var d = new Date(iso);
            return d.toLocaleString('ko-KR', { hour12: false });
        } catch (e) { return iso; }
    }

    /** summary 에서 현재 period 의 데이터 추출 (없으면 top-level fallback) */
    function pickPeriod(summary, period) {
        if (summary && summary.periods && summary.periods[period]) {
            return summary.periods[period];
        }
        // 구 포맷 (periods 없는 빌드) — top-level 이 y1 미러
        return {
            total_events_15: summary.total_events_15,
            sector_top: summary.sector_top || [],
            limit_up_top: summary.limit_up_top || [],
            high_52w_top: summary.high_52w_top || [],
            frequent_top: summary.frequent_top || [],
            reason_top: summary.reason_top || [],
        };
    }

    function applyPeriod() {
        if (!state.summary) return;
        var data = pickPeriod(state.summary, state.period);
        var label = PERIOD_LABEL[state.period] || '';

        document.getElementById('reportTitle').textContent = label + ' 급등 분석';

        var $sub = document.getElementById('reportSub');
        if ($sub) {
            $sub.innerHTML = '최근 ' + label + ' +15% 이상 사건 — ' +
                '<strong>' + fmt(state.summary.total_tickers) + '</strong>종목 / ' +
                '<strong>' + fmt(data.total_events_15) + '</strong>건';
        }

        // 위젯별 desc 도 기간 반영
        var $descSector = document.getElementById('descSector');
        if ($descSector) $descSector.textContent = label + ' 누적 상승률 합산 — 평균 상승률·종목 수';
        var $descLimit = document.getElementById('descLimit');
        if ($descLimit) $descLimit.textContent = label + ' 상한가(+29.9%) 친 종목 — 누적 상승률 순';
        var $descHigh = document.getElementById('descHigh');
        if ($descHigh) $descHigh.textContent = label + ' 52주 신고가 갱신 종목 — 누적 상승률 순';
        var $descFrequent = document.getElementById('descFrequent');
        if ($descFrequent) $descFrequent.textContent = label + ' +15% 이상 누적 상승률 TOP — 동률은 횟수 보조';
        var $descReason = document.getElementById('descReason');
        if ($descReason) $descReason.textContent = label + ' 자동 추정된 이유 라벨';

        renderSectorTop(data.sector_top);
        renderTickerList('limitTop', data.limit_up_top);
        renderTickerList('high52w', data.high_52w_top);
        renderTickerList('frequentTop', data.frequent_top, { showTicker: true });
        renderReasonTop(data.reason_top);
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
                btns[i].classList.toggle('active', btns[i].getAttribute('data-p') === p);
            }
            applyPeriod();
        });
    }

    function init() {
        bindThemeToggle();
        bindPeriodTabs();

        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        var $grid = document.getElementById('reportGrid');

        fetch('/data/report-summary.json', { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (s) {
                state.summary = s;
                $loading.style.display = 'none';
                $grid.style.display = 'grid';
                var $upd = document.getElementById('lastUpdated');
                if ($upd && s.built_at) $upd.textContent = fmtBuiltAt(s.built_at) + ' 갱신';
                applyPeriod();
            })
            .catch(function (err) {
                $loading.style.display = 'none';
                $msg.textContent = '리포트 로딩 실패: ' + err.message + ' — 다음 빌드 후 표시됩니다.';
                $msg.style.display = 'block';
            });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
