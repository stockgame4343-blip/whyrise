/**
 * 트리맵 — 한국 시총 TOP 100.
 *  면적 = market_cap (squarified treemap)
 *  색상 = change_rate (상승 빨강 / 하락 파랑 / 보합 회색, 강도 그라데이션)
 *
 * 데이터: /data/marketmap.json — scripts/build-history.py build_marketmap()
 * 의존: d3 v7 (treemap, hierarchy)
 */
(function () {
    'use strict';

    var $stage = document.getElementById('tmapStage');
    var $svg = document.getElementById('tmapSvg');
    var $loading = document.getElementById('tmapLoading');
    var $message = document.getElementById('tmapMessage');
    var $count = document.getElementById('tmapCount');
    var $date = document.getElementById('tmapDate');
    var $tabs = document.querySelectorAll('.tmap-tab');

    var state = {
        items: [],
        filter: 'ALL',
        date: '',
    };

    // ── 색상 ──
    // 등락률 절댓값 기준 강도 5단계 (0 ~ ±5% 클램프). 한국식: 상승=빨강 / 하락=파랑.
    function colorFor(rate) {
        if (rate == null || isNaN(rate)) return '#5a5e66';
        var r = Math.max(-5, Math.min(5, rate));
        var t = Math.abs(r) / 5;          // 0..1
        if (Math.abs(r) < 0.1) return '#5a5e66';
        if (r > 0) {
            // 빨강 — 흐림(#5a3030)부터 강함(#ff3742)까지
            var rr = Math.round(90 + t * 165);
            var gg = Math.round(48 - t * 40);
            var bb = Math.round(56 - t * 36);
            return 'rgb(' + rr + ',' + gg + ',' + bb + ')';
        }
        // 파랑 — 흐림(#303a5a)부터 강함(#3742ff)까지
        var br = Math.round(48 - t * 30);
        var bg = Math.round(58 - t * 30);
        var bb2 = Math.round(90 + t * 165);
        return 'rgb(' + br + ',' + bg + ',' + bb2 + ')';
    }

    function formatRate(r) {
        if (r == null || isNaN(r)) return '0.00%';
        return (r >= 0 ? '+' : '') + r.toFixed(2) + '%';
    }
    function formatDate(d) {
        if (!d || d.length !== 8) return d || '—';
        return d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8);
    }
    function formatMcap(v) {
        if (!v) return '-';
        if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
        if (v >= 1e8) return Math.round(v / 1e8) + '억';
        return Math.round(v).toLocaleString();
    }

    function render() {
        if (!state.items.length) return;
        var w = $stage.clientWidth;
        var h = $stage.clientHeight;
        if (w < 80 || h < 80) return;

        var items = state.filter === 'ALL'
            ? state.items
            : state.items.filter(function (it) { return it.market === state.filter; });

        $count.textContent = items.length;

        if (!items.length) {
            $svg.innerHTML = '';
            $message.style.display = '';
            $message.textContent = '표시할 종목이 없습니다.';
            return;
        }
        $message.style.display = 'none';

        var root = d3.hierarchy({ children: items })
            .sum(function (d) { return Math.max(d.market_cap || 0, 1); })
            .sort(function (a, b) { return b.value - a.value; });

        d3.treemap()
            .size([w, h])
            .paddingInner(2)
            .paddingOuter(0)
            .round(true)(root);

        var svg = d3.select($svg)
            .attr('width', w)
            .attr('height', h)
            .attr('viewBox', '0 0 ' + w + ' ' + h);

        svg.selectAll('*').remove();

        var cell = svg.selectAll('g.tmap-cell')
            .data(root.leaves())
            .enter()
            .append('g')
            .attr('class', 'tmap-cell')
            .attr('transform', function (d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; })
            .attr('data-ticker', function (d) { return d.data.ticker; })
            .style('cursor', 'pointer')
            .on('click', function (e, d) {
                if (d && d.data && d.data.ticker) {
                    window.location.href = '/stock/' + d.data.ticker;
                }
            });

        cell.append('rect')
            .attr('width', function (d) { return Math.max(0, d.x1 - d.x0); })
            .attr('height', function (d) { return Math.max(0, d.y1 - d.y0); })
            .attr('fill', function (d) { return colorFor(d.data.change_rate); })
            .attr('rx', 2);

        // 종목명 + 등락률 — 셀 크기에 따라 표시 여부와 글자 크기 동적
        cell.each(function (d) {
            var cw = d.x1 - d.x0;
            var ch = d.y1 - d.y0;
            if (cw < 36 || ch < 28) return;   // 너무 작은 셀은 텍스트 생략
            var g = d3.select(this);
            var nameSize = Math.max(10, Math.min(20, cw / 8));
            var rateSize = Math.max(9, nameSize - 3);

            var name = d.data.name || '';
            var maxChars = Math.max(2, Math.floor(cw / (nameSize * 0.55)) - 1);
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';

            g.append('text')
                .attr('class', 'tmap-name')
                .attr('x', cw / 2)
                .attr('y', ch / 2 - rateSize / 2)
                .attr('text-anchor', 'middle')
                .attr('dominant-baseline', 'middle')
                .style('font-size', nameSize + 'px')
                .text(name);

            if (ch >= 42) {
                g.append('text')
                    .attr('class', 'tmap-rate')
                    .attr('x', cw / 2)
                    .attr('y', ch / 2 + nameSize / 2 + 2)
                    .attr('text-anchor', 'middle')
                    .attr('dominant-baseline', 'middle')
                    .style('font-size', rateSize + 'px')
                    .text(formatRate(d.data.change_rate));
            }
        });

        // hover 툴팁 (SVG 네이티브 <title> — 별도 라이브러리 없음)
        cell.append('title').text(function (d) {
            return d.data.name + ' (' + d.data.ticker + ')\n'
                + d.data.market + ' · ' + (d.data.sector || '-') + '\n'
                + '시총: ' + formatMcap(d.data.market_cap) + '\n'
                + formatRate(d.data.change_rate);
        });
    }

    function setFilter(f) {
        if (state.filter === f) return;
        state.filter = f;
        $tabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-filter') === f);
        });
        render();
    }

    function init() {
        $tabs.forEach(function (b) {
            b.addEventListener('click', function () { setFilter(b.getAttribute('data-filter')); });
        });

        fetch('/data/marketmap.json', { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('marketmap.json 없음 — 빌드 대기 중');
                return r.json();
            })
            .then(function (data) {
                state.items = (data && data.items) || [];
                state.date = (data && data.date) || '';
                $date.textContent = formatDate(state.date) + ' 기준';
                $loading.style.display = 'none';
                if (!state.items.length) {
                    $message.style.display = '';
                    $message.textContent = '데이터가 아직 준비되지 않았습니다.';
                    return;
                }
                render();
            })
            .catch(function (err) {
                $loading.style.display = 'none';
                $message.style.display = '';
                $message.textContent = '데이터를 불러올 수 없습니다 — ' + (err && err.message ? err.message : err);
            });

        // resize 디바운스
        var rt;
        window.addEventListener('resize', function () {
            clearTimeout(rt);
            rt = setTimeout(render, 180);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
