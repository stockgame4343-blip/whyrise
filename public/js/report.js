/**
 * 리포트 페이지 — 사전 집계된 report-summary.json 한 번 fetch 후 위젯 렌더.
 *
 * 데이터: scripts/build-history.py 의 build_report_summary() 가 빌드 끝에 생성.
 * 갱신: 평일 KST 09:10 / 15:40 incremental + 일요일 06:00 full 시 자동.
 */
(function () {
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

    /** 막대 너비 = count / max * 100% */
    function bar(count, max, label, sub) {
        var width = max ? (count / max * 100).toFixed(1) : 0;
        return '<li class="report-row">' +
            '<div class="report-row__bar" style="width:' + width + '%"></div>' +
            '<div class="report-row__content">' +
            '<span class="report-row__label">' + label + '</span>' +
            (sub ? '<span class="report-row__sub">' + sub + '</span>' : '') +
            '<span class="report-row__count">' + count + '회</span>' +
            '</div></li>';
    }

    function renderSectorTop(rows) {
        var $el = document.getElementById('sectorTop');
        if (!rows || !rows.length) { $el.innerHTML = '<li class="report-empty">데이터 없음</li>'; return; }
        var max = Math.max.apply(null, rows.map(function (r) { return r.count; }));
        $el.innerHTML = rows.map(function (r) {
            var sub = '평균 ' + pct(r.avg_rate) + ' · ' + r.tickers + ' 종목';
            return bar(r.count, max, r.sector, sub);
        }).join('');
    }

    function renderTickerList(elId, rows, opts) {
        var $el = document.getElementById(elId);
        if (!rows || !rows.length) { $el.innerHTML = '<li class="report-empty">데이터 없음</li>'; return; }
        var max = Math.max.apply(null, rows.map(function (r) { return r.count; }));
        $el.innerHTML = rows.map(function (r) {
            var label = '<a href="/stock/' + r.ticker + '">' + r.name + '</a>';
            var sub = (opts && opts.showTicker) ? r.ticker : '';
            return bar(r.count, max, label, sub);
        }).join('');
    }

    function renderReasonTop(rows) {
        var $el = document.getElementById('reasonTop');
        if (!rows || !rows.length) { $el.innerHTML = '<li class="report-empty">데이터 없음</li>'; return; }
        var max = Math.max.apply(null, rows.map(function (r) { return r.count; }));
        $el.innerHTML = rows.map(function (r) {
            return bar(r.count, max, r.reason, '');
        }).join('');
    }

    function fmtBuiltAt(iso) {
        if (!iso) return '';
        // 'YYYY-MM-DDTHH:MM:SSZ' → 'YYYY-MM-DD HH:MM UTC' → KST 변환
        try {
            var d = new Date(iso);
            return d.toLocaleString('ko-KR', { hour12: false });
        } catch (e) { return iso; }
    }

    function init() {
        bindThemeToggle();

        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        var $grid = document.getElementById('reportGrid');

        fetch('/data/report-summary.json', { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (s) {
                $loading.style.display = 'none';
                $grid.style.display = 'grid';
                document.getElementById('totalTickers').textContent = fmt(s.total_tickers);
                document.getElementById('totalEvents').textContent = fmt(s.total_events_15);
                var $upd = document.getElementById('lastUpdated');
                if ($upd && s.built_at) $upd.textContent = fmtBuiltAt(s.built_at) + ' 갱신';

                renderSectorTop(s.sector_top);
                renderTickerList('limitTop', s.limit_up_top);
                renderTickerList('high52w', s.high_52w_top);
                renderTickerList('recent30', s.recent_30d_top);
                renderTickerList('frequentTop', s.frequent_top, { showTicker: true });
                renderReasonTop(s.reason_top);
            })
            .catch(function (err) {
                $loading.style.display = 'none';
                $msg.textContent = '리포트 로딩 실패: ' + err.message + ' — 다음 빌드 후 표시됩니다.';
                $msg.style.display = 'block';
            });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
