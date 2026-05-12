/**
 * 버블맵 — 오늘 +15% 이상 종목을 D3 force-directed 로 시각화.
 *
 * - 버블 크기 = sqrt(market_cap) 스케일
 * - 색 = 상승률 (15% 옅음 → 30% 진함)
 * - 위치 = 섹터/테마 별 클러스터 (forceX/Y) + 충돌(forceCollide)
 * - 드래그 가능 (d3.drag)
 * - 호버 = 툴팁, 클릭 = /stock/{ticker}
 */
(function () {
    if (typeof d3 === 'undefined') {
        console.error('d3 not loaded');
        return;
    }

    var CUTOFF = 15;

    var state = {
        rankings: [],
        groupBy: 'sector',     // 'sector' | 'theme'
        sim: null,
        width: 0,
        height: 0,
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

    function color(rate) {
        // 15%(soft) → 30%(strong) red gradient (한국 증시 빨강 톤)
        var t = Math.max(0, Math.min(1, (rate - 15) / 15));
        // start: rgba(240,68,82,.35) → end: rgba(240,68,82,1)
        var alpha = 0.35 + 0.65 * t;
        return 'rgba(240, 68, 82, ' + alpha.toFixed(2) + ')';
    }

    function radius(cap, maxCap) {
        // sqrt scale: 시총이 너무 큰 종목이 화면 압도하지 않게
        var minR = 18, maxR = 78;
        if (!cap || cap <= 0) return minR;
        var t = Math.sqrt(cap / Math.max(1, maxCap));
        return minR + (maxR - minR) * t;
    }

    function shortName(name, max) {
        max = max || 6;
        if (!name) return '';
        return name.length > max ? name.slice(0, max - 1) + '…' : name;
    }

    function ensureGroupCenters(nodes, key) {
        // 그룹 키 → 화면 내 anchor (x,y) 매핑
        var keys = Array.from(new Set(nodes.map(function (n) { return n[key] || '기타'; }))).sort();
        var n = keys.length;
        var w = state.width, h = state.height;
        // 그리드 배치 (sqrt 형태)
        var cols = Math.ceil(Math.sqrt(n));
        var rows = Math.ceil(n / cols);
        var centers = {};
        keys.forEach(function (k, i) {
            var c = i % cols, r = Math.floor(i / cols);
            centers[k] = {
                x: w * (c + 0.5) / cols,
                y: h * (r + 0.5) / rows,
            };
        });
        return centers;
    }

    function render() {
        var $svg = d3.select('#bubblesSvg');
        $svg.selectAll('*').remove();

        var rankings = state.rankings.filter(function (r) {
            return r.change_rate != null && r.change_rate >= CUTOFF;
        });

        var $wrap = document.getElementById('bubblesWrap');
        var w = $wrap.clientWidth;
        var h = Math.max(560, Math.min(820, window.innerHeight - 240));
        state.width = w; state.height = h;
        $svg.attr('viewBox', '0 0 ' + w + ' ' + h).attr('width', '100%').attr('height', h);

        if (!rankings.length) {
            $svg.append('text')
                .attr('x', w / 2).attr('y', h / 2)
                .attr('text-anchor', 'middle')
                .attr('fill', 'currentColor')
                .attr('opacity', 0.5)
                .text('오늘 +15% 이상 오른 종목이 없습니다.');
            return;
        }

        var maxCap = d3.max(rankings, function (d) { return d.market_cap || 0; });
        var nodes = rankings.map(function (r) {
            return {
                ticker: r.ticker,
                name: r.name,
                change_rate: r.change_rate,
                market_cap: r.market_cap,
                sector: r.sector || '기타',
                theme: (r.theme_tag || '').trim() || '기타',
                rise_reason: r.rise_reason || '',
                r: radius(r.market_cap, maxCap),
            };
        });

        var groupKey = state.groupBy === 'theme' ? 'theme' : 'sector';
        var centers = ensureGroupCenters(nodes, groupKey);

        // 그룹 라벨 (배경 텍스트)
        var labels = $svg.append('g').attr('class', 'bubble-labels');
        Object.keys(centers).forEach(function (k) {
            labels.append('text')
                .attr('x', centers[k].x).attr('y', centers[k].y)
                .attr('text-anchor', 'middle')
                .attr('class', 'bubble-group-label')
                .attr('fill', 'currentColor')
                .attr('opacity', 0.08)
                .attr('font-size', 28)
                .attr('font-weight', 800)
                .text(k);
        });

        var nodeG = $svg.append('g').attr('class', 'bubble-nodes')
            .selectAll('g').data(nodes).join('g')
            .attr('class', 'bubble-node')
            .style('cursor', 'pointer')
            .on('click', function (event, d) {
                window.location.href = '/stock/' + d.ticker;
            });

        nodeG.append('circle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return color(d.change_rate); })
            .attr('stroke', 'rgba(255,255,255,0.18)')
            .attr('stroke-width', 1);

        // 이름 (큰 버블만 노출)
        nodeG.append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', '-0.1em')
            .attr('class', 'bubble-name')
            .attr('fill', '#fff')
            .attr('font-size', function (d) { return Math.max(10, d.r * 0.34); })
            .attr('font-weight', 700)
            .attr('pointer-events', 'none')
            .text(function (d) { return d.r >= 28 ? shortName(d.name, 5) : ''; });

        // 상승률 (작은 글씨)
        nodeG.append('text')
            .attr('text-anchor', 'middle')
            .attr('dy', '1.1em')
            .attr('class', 'bubble-rate')
            .attr('fill', '#fff')
            .attr('font-size', function (d) { return Math.max(9, d.r * 0.28); })
            .attr('font-weight', 600)
            .attr('opacity', 0.9)
            .attr('pointer-events', 'none')
            .text(function (d) {
                return d.r >= 28 ? '+' + d.change_rate.toFixed(1) + '%' : '';
            });

        // 툴팁
        var tooltip = d3.select('body').append('div').attr('class', 'bubble-tooltip').style('display', 'none');
        nodeG.on('mouseenter', function (event, d) {
            tooltip.style('display', 'block').html(
                '<div class="bubble-tooltip__title">' + d.name + ' <span class="bubble-tooltip__ticker">' + d.ticker + '</span></div>' +
                '<div class="bubble-tooltip__rate">+' + d.change_rate.toFixed(2) + '%</div>' +
                (d.rise_reason ? '<div class="bubble-tooltip__reason">' + d.rise_reason + '</div>' : '') +
                '<div class="bubble-tooltip__meta">' +
                (d.theme && d.theme !== '기타' ? d.theme + ' · ' : '') +
                (d.sector || '') +
                '</div>'
            );
        }).on('mousemove', function (event) {
            tooltip.style('left', (event.pageX + 14) + 'px').style('top', (event.pageY + 14) + 'px');
        }).on('mouseleave', function () {
            tooltip.style('display', 'none');
        });

        // 시뮬레이션
        if (state.sim) state.sim.stop();
        state.sim = d3.forceSimulation(nodes)
            .force('x', d3.forceX(function (d) { return centers[d[groupKey]].x; }).strength(0.18))
            .force('y', d3.forceY(function (d) { return centers[d[groupKey]].y; }).strength(0.18))
            .force('collide', d3.forceCollide(function (d) { return d.r + 2; }).strength(0.95).iterations(2))
            .force('charge', d3.forceManyBody().strength(-12))
            .alphaDecay(0.04)
            .on('tick', function () {
                nodeG.attr('transform', function (d) {
                    // 화면 경계 클램프
                    d.x = Math.max(d.r, Math.min(w - d.r, d.x));
                    d.y = Math.max(d.r, Math.min(h - d.r, d.y));
                    return 'translate(' + d.x + ',' + d.y + ')';
                });
            });

        // 드래그
        nodeG.call(d3.drag()
            .on('start', function (event, d) {
                if (!event.active) state.sim.alphaTarget(0.25).restart();
                d.fx = d.x; d.fy = d.y;
            })
            .on('drag', function (event, d) {
                d.fx = event.x; d.fy = event.y;
            })
            .on('end', function (event, d) {
                if (!event.active) state.sim.alphaTarget(0);
                d.fx = null; d.fy = null;
            })
        );
    }

    function bindGroupToggle() {
        var btns = document.querySelectorAll('.group-btn');
        btns.forEach(function (b) {
            b.addEventListener('click', function () {
                var g = b.getAttribute('data-group');
                if (g === state.groupBy) return;
                state.groupBy = g;
                btns.forEach(function (x) { x.classList.toggle('active', x === b); });
                render();
            });
        });
    }

    function loadAndRender() {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'block';

        WhyAPI.getDates().then(function (dates) {
            if (!dates || !dates.length) throw new Error('거래일 데이터 없음');
            return WhyAPI.getRankings(dates[0]).then(function (data) {
                state.rankings = data.rankings || [];
                $loading.style.display = 'none';
                var n = state.rankings.filter(function (r) { return r.change_rate >= CUTOFF; }).length;
                var $sub = document.getElementById('bubblesSub');
                if ($sub) $sub.textContent = dates[0].slice(0,4) + '.' + dates[0].slice(4,6) + '.' + dates[0].slice(6,8) +
                    ' · +15% 이상 ' + n + '개 종목';
                render();
                window.addEventListener('resize', function () {
                    // 리사이즈 시 1회 재렌더 (debounce)
                    clearTimeout(window._wrResize);
                    window._wrResize = setTimeout(render, 250);
                });
            });
        }).catch(function (err) {
            $loading.style.display = 'none';
            $msg.textContent = '데이터 로딩 실패: ' + err.message;
            $msg.style.display = 'block';
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        bindThemeToggle();
        bindGroupToggle();
        loadAndRender();
    });
})();
