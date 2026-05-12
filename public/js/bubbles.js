/**
 * 버블맵 — cryptobubbles.net 스타일.
 *
 * 풀스크린 캔버스 + D3 force simulation:
 *  - 버블 안에 종목명·상승률 큰 텍스트
 *  - 부유 모션 (alphaDecay 0, 약한 charge → 계속 떠다님)
 *  - 드래그 가능, 검색 하이라이트, 클릭 시 모달
 *  - 토글: 섹터별 / 테마별 / 자유(forceCenter)
 *  - 색: 상승률 강도 — 15% rgba(.45) → 30% rgba(1) 빨강 (한국 증시)
 *  - 크기: log scale on market_cap
 */
(function () {
    if (typeof d3 === 'undefined') {
        console.error('d3 not loaded');
        return;
    }

    var CUTOFF = 15;

    var state = {
        nodes: [],
        groupBy: 'sector',     // 'sector' | 'theme' | 'none'
        sim: null,
        width: 0,
        height: 0,
        searchTerm: '',
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

    function shadeColor(rate) {
        // 15% → 30% 강도. 단순 빨강 채도/명도.
        // 한국 증시 빨강 (#F04452) 기반.
        var t = Math.max(0, Math.min(1, (rate - 15) / 15));
        var alpha = 0.5 + 0.5 * t;
        return 'rgba(240, 68, 82, ' + alpha.toFixed(3) + ')';
    }

    function strokeColor(rate) {
        var t = Math.max(0, Math.min(1, (rate - 15) / 15));
        return 'rgba(255, 110, 130, ' + (0.6 + 0.4 * t).toFixed(2) + ')';
    }

    function radius(cap, maxCap, minCap) {
        // log 스케일 — 시총 큰 종목 너무 크지 않게
        var minR = 36, maxR = 130;
        if (!cap || cap <= 0) return minR;
        var lcap = Math.log10(Math.max(1, cap));
        var lmin = Math.log10(Math.max(1, minCap || 1));
        var lmax = Math.log10(Math.max(1, maxCap || 1));
        var t = (lmax === lmin) ? 0.5 : (lcap - lmin) / (lmax - lmin);
        return minR + (maxR - minR) * t;
    }

    function shortName(name, max) {
        max = max || 6;
        if (!name) return '';
        return name.length > max ? name.slice(0, max - 1) + '…' : name;
    }

    function fmtCap(n) {
        if (n == null || n === 0) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8) + '억';
        return n.toLocaleString('ko-KR');
    }

    function stage() {
        var $stage = document.getElementById('bubblesStage');
        return {
            w: $stage.clientWidth,
            h: $stage.clientHeight,
        };
    }

    function groupCenters(nodes, key) {
        if (key === 'none') return null;
        var keys = Array.from(new Set(nodes.map(function (n) { return n[key] || '기타'; }))).sort();
        var n = keys.length;
        var w = state.width, h = state.height;
        var cols = Math.max(1, Math.ceil(Math.sqrt(n * (w / Math.max(1, h)))));
        var rows = Math.max(1, Math.ceil(n / cols));
        var centers = {};
        keys.forEach(function (k, i) {
            var c = i % cols, r = Math.floor(i / cols);
            centers[k] = {
                x: w * (c + 0.5) / cols,
                y: h * (r + 0.5) / rows + 12,
                label: k,
            };
        });
        return centers;
    }

    function render() {
        var $svg = d3.select('#bubblesSvg');
        $svg.selectAll('*').remove();

        var s = stage();
        state.width = s.w;
        state.height = s.h;
        $svg.attr('viewBox', '0 0 ' + s.w + ' ' + s.h)
            .attr('width', s.w).attr('height', s.h);

        var nodes = state.nodes;
        if (!nodes.length) {
            $svg.append('text')
                .attr('x', s.w / 2).attr('y', s.h / 2)
                .attr('text-anchor', 'middle')
                .attr('fill', 'currentColor').attr('opacity', 0.4)
                .attr('font-size', 16)
                .text('오늘 +15% 이상 오른 종목이 없습니다.');
            return;
        }

        var groupKey = state.groupBy;
        var centers = groupCenters(nodes, groupKey);

        // 그룹 배경 라벨
        if (centers) {
            var labels = $svg.append('g').attr('class', 'bubble-labels');
            Object.keys(centers).forEach(function (k) {
                labels.append('text')
                    .attr('x', centers[k].x).attr('y', centers[k].y - 100)
                    .attr('text-anchor', 'middle')
                    .attr('class', 'bubble-group-label')
                    .attr('fill', 'currentColor')
                    .attr('opacity', 0.06)
                    .attr('font-size', Math.min(56, Math.max(24, s.w / 18)))
                    .attr('font-weight', 800)
                    .text(k);
            });
        }

        var nodeG = $svg.append('g').attr('class', 'bubble-nodes')
            .selectAll('g').data(nodes, function (d) { return d.ticker; }).join('g')
            .attr('class', 'bubble-node')
            .style('cursor', 'pointer')
            .on('click', function (event, d) {
                if (event.defaultPrevented) return;
                openModal(d);
            });

        nodeG.append('circle')
            .attr('class', 'bubble-circle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return shadeColor(d.change_rate); })
            .attr('stroke', function (d) { return strokeColor(d.change_rate); })
            .attr('stroke-width', 1.5);

        // 종목명 (윗줄)
        nodeG.append('text')
            .attr('class', 'bubble-name')
            .attr('text-anchor', 'middle')
            .attr('dy', '-0.25em')
            .attr('fill', '#fff')
            .attr('font-weight', 700)
            .attr('font-size', function (d) { return Math.max(11, d.r * 0.26); })
            .attr('pointer-events', 'none')
            .text(function (d) {
                var max = Math.max(3, Math.floor(d.r / 9));
                return shortName(d.name, max);
            });

        // 상승률 (큰 글씨, 아래)
        nodeG.append('text')
            .attr('class', 'bubble-rate')
            .attr('text-anchor', 'middle')
            .attr('dy', '1.05em')
            .attr('fill', '#fff')
            .attr('font-weight', 800)
            .attr('font-size', function (d) { return Math.max(13, d.r * 0.38); })
            .attr('pointer-events', 'none')
            .text(function (d) { return '+' + d.change_rate.toFixed(1) + '%'; });

        // 드래그
        nodeG.call(d3.drag()
            .on('start', function (event, d) {
                if (!event.active) state.sim.alphaTarget(0.3).restart();
                d.fx = d.x; d.fy = d.y;
                event.sourceEvent && event.sourceEvent.preventDefault();
            })
            .on('drag', function (event, d) {
                d.fx = event.x; d.fy = event.y;
            })
            .on('end', function (event, d) {
                if (!event.active) state.sim.alphaTarget(0.05);
                d.fx = null; d.fy = null;
            })
        );

        // 시뮬레이션 — 부유 유지
        if (state.sim) state.sim.stop();
        var sim = d3.forceSimulation(nodes)
            .force('collide', d3.forceCollide(function (d) { return d.r + 3; }).strength(1).iterations(3))
            .force('charge', d3.forceManyBody().strength(-30))
            .alphaDecay(0.005)
            .alphaMin(0.001)
            .velocityDecay(0.3)
            .on('tick', tick);

        if (centers) {
            sim.force('x', d3.forceX(function (d) { return centers[d[groupKey] || '기타'].x; }).strength(0.12))
               .force('y', d3.forceY(function (d) { return centers[d[groupKey] || '기타'].y; }).strength(0.12));
        } else {
            sim.force('x', d3.forceX(s.w / 2).strength(0.04))
               .force('y', d3.forceY(s.h / 2).strength(0.04));
        }

        function tick() {
            nodeG.attr('transform', function (d) {
                d.x = Math.max(d.r + 2, Math.min(s.w - d.r - 2, d.x));
                d.y = Math.max(d.r + 2, Math.min(s.h - d.r - 2, d.y));
                return 'translate(' + d.x + ',' + d.y + ')';
            });
        }
        state.sim = sim;

        applySearch();
    }

    function applySearch() {
        var q = (state.searchTerm || '').toLowerCase().trim();
        d3.selectAll('.bubble-node')
            .classed('dim', function (d) {
                if (!q) return false;
                var name = (d.name || '').toLowerCase();
                var tk = (d.ticker || '').toLowerCase();
                return !(name.indexOf(q) !== -1 || tk.indexOf(q) === 0);
            })
            .classed('hit', function (d) {
                if (!q) return false;
                var name = (d.name || '').toLowerCase();
                var tk = (d.ticker || '').toLowerCase();
                return (name.indexOf(q) !== -1 || tk.indexOf(q) === 0);
            });
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

    function bindSearch() {
        var $s = document.getElementById('bubblesSearch');
        if (!$s) return;
        $s.addEventListener('input', function () {
            state.searchTerm = $s.value;
            applySearch();
        });
    }

    // ── 모달 ────────────────────────────────────────────
    function openModal(d) {
        var $modal = document.getElementById('bubbleModal');
        if (!$modal) return;
        document.getElementById('modalName').textContent = d.name || d.ticker;
        document.getElementById('modalTicker').textContent = d.ticker || '';
        document.getElementById('modalRate').textContent = '+' + d.change_rate.toFixed(2) + '%';
        document.getElementById('modalReason').textContent = d.rise_reason || '이유 미수집';
        var $meta = document.getElementById('modalMeta');
        $meta.innerHTML =
            '<dt>섹터</dt><dd>' + (d.sector || '-') + '</dd>' +
            '<dt>테마</dt><dd>' + (d.theme || '-') + '</dd>' +
            '<dt>시가총액</dt><dd>' + fmtCap(d.market_cap) + '</dd>' +
            '<dt>시장</dt><dd>' + (d.market || '-') + '</dd>';
        document.getElementById('modalCta').setAttribute('href', '/stock/' + d.ticker);
        $modal.style.display = 'flex';
    }
    function closeModal() {
        var $modal = document.getElementById('bubbleModal');
        if ($modal) $modal.style.display = 'none';
    }
    function bindModal() {
        document.getElementById('bubbleModalClose').addEventListener('click', closeModal);
        document.getElementById('bubbleModalOverlay').addEventListener('click', closeModal);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeModal();
        });
    }

    // ── 데이터 ─────────────────────────────────────────
    function buildNodes(rankings) {
        var caps = rankings.map(function (r) { return r.market_cap || 0; }).filter(function (c) { return c > 0; });
        var maxCap = caps.length ? Math.max.apply(null, caps) : 1;
        var minCap = caps.length ? Math.min.apply(null, caps) : 1;
        return rankings.map(function (r) {
            return {
                ticker: r.ticker,
                name: r.name,
                change_rate: r.change_rate,
                market_cap: r.market_cap,
                market: r.market,
                sector: r.sector || '기타',
                theme: (r.theme_tag || '').trim() || '기타',
                rise_reason: r.rise_reason || '',
                r: radius(r.market_cap, maxCap, minCap),
            };
        });
    }

    function loadAndRender() {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'block';

        WhyAPI.getDates().then(function (dates) {
            if (!dates || !dates.length) throw new Error('거래일 데이터 없음');
            return WhyAPI.getRankings(dates[0]).then(function (data) {
                var filtered = (data.rankings || []).filter(function (r) {
                    return r.change_rate != null && r.change_rate >= CUTOFF;
                });
                state.nodes = buildNodes(filtered);

                document.getElementById('bubblesCount').textContent = filtered.length;
                var d = dates[0];
                document.getElementById('bubblesDate').textContent =
                    d.slice(0,4) + '.' + d.slice(4,6) + '.' + d.slice(6,8);

                $loading.style.display = 'none';
                render();

                window.addEventListener('resize', function () {
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
        bindSearch();
        bindModal();
        loadAndRender();
    });
})();
