/**
 * 시각화 샘플 — 5가지 (A 워드클라우드, B 비스웜, C 선버스트, D 바차트, E 생키).
 * 사용자가 마음에 드는 것을 채택하기 위한 비교용 페이지.
 */
(function () {
    if (typeof d3 === 'undefined') { console.error('d3 not loaded'); return; }

    var CUTOFF = 15;
    var ACCENT = '#5b9df9';
    var RISE = '#f04452';

    // 섹터별 색 (categorical) — 톤 다운된 파스텔
    var SECTOR_PALETTE = [
        '#5b9df9', '#22c55e', '#f59e0b', '#ec4899', '#a78bfa',
        '#06b6d4', '#84cc16', '#f97316', '#14b8a6', '#fb7185',
        '#8b5cf6', '#10b981', '#eab308', '#3b82f6', '#d946ef',
    ];
    function sectorColor(sectors) {
        var map = {};
        sectors.forEach(function (s, i) { map[s] = SECTOR_PALETTE[i % SECTOR_PALETTE.length]; });
        return function (s) { return map[s] || SECTOR_PALETTE[0]; };
    }

    function rateShade(rate) {
        var t = Math.max(0, Math.min(1, (rate - 15) / 15));
        var alpha = 0.45 + 0.55 * t;
        return 'rgba(240, 68, 82, ' + alpha.toFixed(2) + ')';
    }

    function fmtCap(n) {
        if (n == null || n === 0) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8) + '억';
        return n.toLocaleString('ko-KR');
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

    // ── A. 워드 클라우드 — 이유 카테고리 빈도 ─────────
    function renderCloud(rankings) {
        var $svg = d3.select('#vizCloud');
        $svg.selectAll('*').remove();
        var counts = d3.rollup(rankings,
            function (v) { return v.length; },
            function (d) {
                var r = (d.rise_reason || '').trim();
                if (!r || r === '-' || r === '상한가 — 사유 미수집' || r === '52주 신고가 도달') return null;
                return r;
            });
        var words = Array.from(counts, function (e) { return { text: e[0], count: e[1] }; })
            .filter(function (w) { return w.text; })
            .sort(function (a, b) { return b.count - a.count; })
            .slice(0, 40);
        if (!words.length) {
            $svg.append('text').attr('x', 400).attr('y', 150)
                .attr('text-anchor', 'middle').attr('fill', 'currentColor').attr('opacity', 0.4)
                .text('이유 데이터 없음');
            return;
        }
        var maxC = words[0].count;
        var minC = words[words.length - 1].count;
        var sizeOf = function (c) { return 12 + (c - minC) / Math.max(1, maxC - minC) * 38; };

        if (typeof d3.layout === 'undefined' || typeof d3.layout.cloud === 'undefined') {
            // fallback — grid 배치
            var cols = Math.ceil(Math.sqrt(words.length));
            words.forEach(function (w, i) {
                var x = 50 + (i % cols) * (700 / cols);
                var y = 40 + Math.floor(i / cols) * (260 / Math.ceil(words.length / cols));
                $svg.append('text')
                    .attr('x', x).attr('y', y)
                    .attr('fill', ACCENT).attr('font-weight', 700)
                    .attr('font-size', sizeOf(w.count))
                    .text(w.text + ' (' + w.count + ')');
            });
            return;
        }

        d3.layout.cloud()
            .size([800, 300])
            .words(words.map(function (w) { return { text: w.text, size: sizeOf(w.count), count: w.count }; }))
            .padding(4)
            .rotate(function () { return (Math.random() < 0.7 ? 0 : 90); })
            .fontSize(function (d) { return d.size; })
            .on('end', function (laid) {
                var g = $svg.append('g').attr('transform', 'translate(400,150)');
                g.selectAll('text').data(laid).join('text')
                    .attr('text-anchor', 'middle')
                    .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ') rotate(' + d.rotate + ')'; })
                    .attr('fill', function (d, i) { return d3.interpolateRgb('#7dd3fc', '#1d4ed8')(i / laid.length); })
                    .attr('font-weight', 700)
                    .attr('font-size', function (d) { return d.size; })
                    .text(function (d) { return d.text; })
                    .append('title').text(function (d) { return d.text + ' — ' + d.count + '건'; });
            })
            .start();
    }

    // ── B. Beeswarm — 상승률 분포 ─────────────────
    function renderBeeswarm(rankings) {
        var $svg = d3.select('#vizBeeswarm');
        $svg.selectAll('*').remove();
        if (!rankings.length) return;
        var W = 800, H = 220, PAD = 50;
        var x = d3.scaleLinear().domain([14.5, Math.max(30.5, d3.max(rankings, function (d) { return d.change_rate; }))])
            .range([PAD, W - PAD]);
        // x 축
        var ax = $svg.append('g').attr('transform', 'translate(0,' + (H - 30) + ')');
        ax.selectAll('line.tick').data([15, 20, 25, 30]).join('line')
            .attr('x1', x).attr('x2', x).attr('y1', -5).attr('y2', 0)
            .attr('stroke', 'currentColor').attr('opacity', 0.3);
        ax.selectAll('text.tick').data([15, 20, 25, 30]).join('text')
            .attr('x', x).attr('y', 16).attr('text-anchor', 'middle')
            .attr('fill', 'currentColor').attr('opacity', 0.5).attr('font-size', 11)
            .text(function (d) { return '+' + d + '%'; });
        // 기준선
        $svg.append('line').attr('x1', PAD).attr('x2', W - PAD)
            .attr('y1', H - 30).attr('y2', H - 30)
            .attr('stroke', 'currentColor').attr('opacity', 0.2);

        var sectors = Array.from(new Set(rankings.map(function (d) { return d.sector || '기타'; })));
        var colorFn = sectorColor(sectors);

        var nodes = rankings.map(function (r) {
            return Object.assign({}, r, {
                x: x(r.change_rate),
                y: (H - 30) / 2,
                r: 7,
            });
        });

        // 충돌 시뮬레이션 — x 고정, y jitter
        var sim = d3.forceSimulation(nodes)
            .force('x', d3.forceX(function (d) { return x(d.change_rate); }).strength(1))
            .force('y', d3.forceY((H - 30) / 2).strength(0.3))
            .force('collide', d3.forceCollide(function (d) { return d.r + 1.5; }).iterations(3))
            .stop();
        for (var i = 0; i < 200; i++) sim.tick();

        var g = $svg.append('g').attr('class', 'bee-nodes');
        g.selectAll('circle').data(nodes).join('circle')
            .attr('cx', function (d) { return d.x; })
            .attr('cy', function (d) { return d.y; })
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return colorFn(d.sector || '기타'); })
            .attr('stroke', '#fff').attr('stroke-width', 0.5).attr('opacity', 0.9)
            .style('cursor', 'pointer')
            .on('click', function (e, d) { window.location.href = '/stock/' + d.ticker; })
            .append('title').text(function (d) {
                return d.name + ' (' + d.ticker + ')\n' +
                    '+' + d.change_rate.toFixed(2) + '%\n' +
                    (d.sector || '') + ' · ' + (d.rise_reason || '');
            });
    }

    // ── C. 선버스트 — 섹터 → 종목 ─────────────────
    function renderSunburst(rankings) {
        var $svg = d3.select('#vizSunburst');
        $svg.selectAll('*').remove();
        if (!rankings.length) return;
        var W = 400, H = 400, R = Math.min(W, H) / 2 - 8;

        var groups = d3.group(rankings, function (d) { return d.sector || '기타'; });
        var root = d3.hierarchy({
            name: 'root',
            children: Array.from(groups, function (e) {
                return {
                    name: e[0],
                    children: e[1].map(function (r) {
                        return Object.assign({}, r, { value: Math.max(1, r.market_cap || 1) });
                    }),
                };
            }),
        }).sum(function (d) { return d.value; });

        d3.partition().size([2 * Math.PI, R])(root);
        var arc = d3.arc()
            .startAngle(function (d) { return d.x0; })
            .endAngle(function (d) { return d.x1; })
            .innerRadius(function (d) { return d.y0; })
            .outerRadius(function (d) { return d.y1 - 1; })
            .padAngle(0.005);

        var sectors = Array.from(groups.keys());
        var colorFn = sectorColor(sectors);

        var g = $svg.append('g').attr('transform', 'translate(' + W / 2 + ',' + H / 2 + ')');

        // 섹터 호 (depth 1)
        var sectorArcs = root.descendants().filter(function (d) { return d.depth === 1; });
        g.selectAll('path.sect').data(sectorArcs).join('path')
            .attr('class', 'sect')
            .attr('d', arc)
            .attr('fill', function (d) { return colorFn(d.data.name); })
            .attr('opacity', 0.85)
            .append('title').text(function (d) { return d.data.name + ' — ' + d.children.length + '종목'; });

        // 종목 호 (depth 2)
        var leafArcs = root.descendants().filter(function (d) { return d.depth === 2; });
        g.selectAll('path.leaf').data(leafArcs).join('path')
            .attr('class', 'leaf')
            .attr('d', arc)
            .attr('fill', function (d) { return rateShade(d.data.change_rate); })
            .attr('stroke', 'rgba(0,0,0,0.4)').attr('stroke-width', 0.5)
            .style('cursor', 'pointer')
            .on('click', function (e, d) { window.location.href = '/stock/' + d.data.ticker; })
            .append('title').text(function (d) {
                return d.data.name + ' (' + d.data.ticker + ')\n' +
                    '+' + d.data.change_rate.toFixed(2) + '%\n' +
                    (d.data.rise_reason || '');
            });

        // 중앙 라벨
        g.append('text').attr('text-anchor', 'middle').attr('dy', '.3em')
            .attr('fill', 'currentColor').attr('font-weight', 700)
            .attr('font-size', 14).text(rankings.length + '종목');
    }

    // ── D. 바차트 TOP 20 ──────────────────────────
    function renderBar(rankings) {
        var $svg = d3.select('#vizBar');
        $svg.selectAll('*').remove();
        if (!rankings.length) return;
        var W = 400, H = 500, PAD_L = 90, PAD_R = 16, PAD_T = 8, PAD_B = 8;
        var top = rankings.slice().sort(function (a, b) { return b.change_rate - a.change_rate; }).slice(0, 20);
        var x = d3.scaleLinear().domain([0, d3.max(top, function (d) { return d.change_rate; })])
            .range([PAD_L, W - PAD_R]);
        var y = d3.scaleBand().domain(top.map(function (d) { return d.ticker; }))
            .range([PAD_T, H - PAD_B]).padding(0.18);

        var g = $svg.append('g');
        // 막대
        g.selectAll('rect').data(top).join('rect')
            .attr('x', PAD_L)
            .attr('y', function (d) { return y(d.ticker); })
            .attr('width', function (d) { return x(d.change_rate) - PAD_L; })
            .attr('height', y.bandwidth())
            .attr('fill', function (d) { return rateShade(d.change_rate); })
            .attr('rx', 3)
            .style('cursor', 'pointer')
            .on('click', function (e, d) { window.location.href = '/stock/' + d.ticker; })
            .append('title').text(function (d) {
                return d.name + ' +' + d.change_rate.toFixed(2) + '% — ' + (d.rise_reason || '');
            });

        // 종목명 (좌측)
        g.selectAll('text.label').data(top).join('text')
            .attr('class', 'label')
            .attr('x', PAD_L - 6)
            .attr('y', function (d) { return y(d.ticker) + y.bandwidth() / 2; })
            .attr('dy', '.32em').attr('text-anchor', 'end')
            .attr('fill', 'currentColor').attr('font-size', 11).attr('font-weight', 600)
            .text(function (d) {
                var nm = d.name || '';
                return nm.length > 8 ? nm.slice(0, 7) + '…' : nm;
            });

        // 상승률 (막대 끝)
        g.selectAll('text.value').data(top).join('text')
            .attr('class', 'value')
            .attr('x', function (d) { return x(d.change_rate) - 4; })
            .attr('y', function (d) { return y(d.ticker) + y.bandwidth() / 2; })
            .attr('dy', '.32em').attr('text-anchor', 'end')
            .attr('fill', '#fff').attr('font-size', 11).attr('font-weight', 700)
            .text(function (d) { return '+' + d.change_rate.toFixed(1); });
    }

    // ── E. Sankey — 섹터 → 테마 ───────────────────
    function renderSankey(rankings) {
        var $svg = d3.select('#vizSankey');
        $svg.selectAll('*').remove();
        if (!rankings.length || typeof d3.sankey === 'undefined') {
            $svg.append('text').attr('x', 450).attr('y', 180).attr('text-anchor', 'middle')
                .attr('fill', 'currentColor').attr('opacity', 0.4)
                .text(typeof d3.sankey === 'undefined' ? 'd3-sankey 미로드' : '데이터 없음');
            return;
        }
        var W = 900, H = 360, PAD = 24;

        // 노드: 섹터 set + 테마 set (양쪽)
        var sectors = Array.from(new Set(rankings.map(function (d) { return 'S:' + (d.sector || '기타'); })));
        var themes = Array.from(new Set(rankings.map(function (d) {
            var t = (d.theme_tag || '').trim();
            return 'T:' + (t || '기타');
        })));
        var nodeKeys = sectors.concat(themes);
        var nodes = nodeKeys.map(function (k) { return { name: k.slice(2), key: k }; });
        var nodeIdx = {};
        nodeKeys.forEach(function (k, i) { nodeIdx[k] = i; });

        var linkMap = {};
        rankings.forEach(function (r) {
            var sk = 'S:' + (r.sector || '기타');
            var tk = 'T:' + ((r.theme_tag || '').trim() || '기타');
            var key = sk + '|' + tk;
            linkMap[key] = (linkMap[key] || 0) + 1;
        });
        var links = Object.keys(linkMap).map(function (k) {
            var parts = k.split('|');
            return { source: nodeIdx[parts[0]], target: nodeIdx[parts[1]], value: linkMap[k] };
        });

        var sankey = d3.sankey()
            .nodeWidth(14).nodePadding(8)
            .extent([[PAD, PAD], [W - PAD, H - PAD]]);
        var graph = sankey({
            nodes: nodes.map(function (n) { return Object.assign({}, n); }),
            links: links.map(function (l) { return Object.assign({}, l); }),
        });

        var sectorList = sectors.map(function (s) { return s.slice(2); });
        var colorFn = sectorColor(sectorList);

        // 링크
        $svg.append('g').selectAll('path').data(graph.links).join('path')
            .attr('d', d3.sankeyLinkHorizontal())
            .attr('fill', 'none')
            .attr('stroke', function (d) {
                return colorFn(d.source.name);
            })
            .attr('stroke-opacity', 0.35)
            .attr('stroke-width', function (d) { return Math.max(1, d.width); })
            .append('title').text(function (d) { return d.source.name + ' → ' + d.target.name + ' (' + d.value + ')'; });

        // 노드
        var nodeG = $svg.append('g').selectAll('g').data(graph.nodes).join('g');
        nodeG.append('rect')
            .attr('x', function (d) { return d.x0; })
            .attr('y', function (d) { return d.y0; })
            .attr('width', function (d) { return d.x1 - d.x0; })
            .attr('height', function (d) { return d.y1 - d.y0; })
            .attr('fill', function (d) {
                if (d.key && d.key[0] === 'S') return colorFn(d.name);
                return 'rgba(255,255,255,0.4)';
            })
            .append('title').text(function (d) { return d.name + ' (' + d.value + ')'; });

        // 노드 라벨
        nodeG.append('text')
            .attr('x', function (d) { return d.x0 < W / 2 ? d.x1 + 6 : d.x0 - 6; })
            .attr('y', function (d) { return (d.y0 + d.y1) / 2; })
            .attr('dy', '.32em')
            .attr('text-anchor', function (d) { return d.x0 < W / 2 ? 'start' : 'end'; })
            .attr('fill', 'currentColor').attr('font-size', 11).attr('font-weight', 600)
            .text(function (d) {
                var nm = d.name || '';
                return nm.length > 14 ? nm.slice(0, 13) + '…' : nm;
            });
    }

    // ── 진입점 ─────────────────────────────────────
    function loadAll() {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');

        WhyAPI.getDates().then(function (dates) {
            if (!dates || !dates.length) throw new Error('거래일 데이터 없음');
            return WhyAPI.getRankings(dates[0]).then(function (data) {
                var ranks = (data.rankings || []).filter(function (r) { return r.change_rate >= CUTOFF; });
                document.getElementById('vizCount').textContent = ranks.length;
                var d = dates[0];
                document.getElementById('vizDate').textContent =
                    d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8);
                $loading.style.display = 'none';

                renderCloud(ranks);
                renderBeeswarm(ranks);
                renderSunburst(ranks);
                renderBar(ranks);
                renderSankey(ranks);
            });
        }).catch(function (err) {
            $loading.style.display = 'none';
            $msg.textContent = '데이터 로딩 실패: ' + err.message;
            $msg.style.display = 'block';
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        bindThemeToggle();
        loadAll();
    });
})();
