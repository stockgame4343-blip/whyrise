/**
 * 흐름 (Sankey) — 섹터 → 테마 → 종목 3단계.
 *
 * - 노드:
 *    Col 1 = 섹터 (sector)
 *    Col 2 = 테마 (theme_tag, 빈 값은 "기타")
 *    Col 3 = 종목 (ticker)
 * - 링크 두께 ∝ change_rate
 *    (sector→theme): 그 쌍에 속한 종목들 상승률 합
 *    (theme→stock):  종목 자신의 상승률
 * - 색:
 *    섹터 노드 = 섹터 categorical
 *    테마 노드 = 회색 톤
 *    종목 노드 = 상승률 강도 빨강
 *    링크 = 섹터 색 (반투명)
 * - 호버:
 *    노드 hover → 그 노드에 연결된 흐름만 강조 (다른 dim)
 *    종목 hover → title 툴팁 (이름·상승률·이유)
 * - 클릭:
 *    종목 노드 클릭 → 모달
 */
(function () {
    if (typeof d3 === 'undefined') { console.error('d3 not loaded'); return; }
    if (typeof d3.sankey === 'undefined') { console.error('d3-sankey not loaded'); return; }

    var CUTOFF = 15;

    var SECTOR_PALETTE = [
        '#5b9df9', '#22c55e', '#f59e0b', '#ec4899', '#a78bfa',
        '#06b6d4', '#84cc16', '#f97316', '#14b8a6', '#fb7185',
        '#8b5cf6', '#10b981', '#eab308', '#3b82f6', '#d946ef',
    ];
    function sectorColorFn(sectors) {
        var map = {};
        sectors.forEach(function (s, i) { map[s] = SECTOR_PALETTE[i % SECTOR_PALETTE.length]; });
        return function (s) { return map[s] || SECTOR_PALETTE[0]; };
    }

    function rateShade(rate) {
        var t = Math.max(0, Math.min(1, (rate - 15) / 15));
        var alpha = 0.5 + 0.5 * t;
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

    var state = { rankings: [], searchTerm: '', stockByTicker: {} };

    function stage() {
        var $s = document.getElementById('flowStage');
        return { w: $s.clientWidth, h: $s.clientHeight };
    }

    function shortLabel(s, max) {
        if (!s) return '';
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function render() {
        var $svg = d3.select('#flowSvg');
        $svg.selectAll('*').remove();

        var s = stage();
        $svg.attr('viewBox', '0 0 ' + s.w + ' ' + s.h)
            .attr('width', s.w).attr('height', s.h);

        var rankings = state.rankings;
        if (!rankings.length) {
            $svg.append('text').attr('x', s.w / 2).attr('y', s.h / 2)
                .attr('text-anchor', 'middle').attr('fill', 'currentColor').attr('opacity', 0.4)
                .text('오늘 +15% 이상 오른 종목이 없습니다.');
            return;
        }

        // 노드 키: prefix 로 컬럼 구분
        var sectorSet = new Map();   // name → totalRate
        var themeSet = new Map();
        rankings.forEach(function (r) {
            var sec = r.sector || '기타';
            var th = (r.theme_tag || '').trim() || '기타';
            sectorSet.set(sec, (sectorSet.get(sec) || 0) + r.change_rate);
            themeSet.set(th, (themeSet.get(th) || 0) + r.change_rate);
        });

        var sectors = Array.from(sectorSet.keys()).sort();
        var themes = Array.from(themeSet.keys()).sort();
        var stocks = rankings.slice().sort(function (a, b) { return b.change_rate - a.change_rate; });

        var nodes = [];
        var nodeIdx = {};
        sectors.forEach(function (k) { nodeIdx['S:' + k] = nodes.length; nodes.push({ key: 'S:' + k, name: k, col: 0 }); });
        themes.forEach(function (k) { nodeIdx['T:' + k] = nodes.length; nodes.push({ key: 'T:' + k, name: k, col: 1 }); });
        stocks.forEach(function (r) { nodeIdx['N:' + r.ticker] = nodes.length; nodes.push({ key: 'N:' + r.ticker, name: r.name, ticker: r.ticker, col: 2, stock: r }); });

        var links = [];
        var stMap = {};   // (sector, theme) → rate 합
        rankings.forEach(function (r) {
            var sec = r.sector || '기타';
            var th = (r.theme_tag || '').trim() || '기타';
            var key = sec + '|' + th;
            stMap[key] = (stMap[key] || 0) + r.change_rate;
            links.push({
                source: nodeIdx['T:' + th],
                target: nodeIdx['N:' + r.ticker],
                value: r.change_rate,
                sector: sec,
                kind: 't2n',
            });
        });
        Object.keys(stMap).forEach(function (k) {
            var p = k.split('|');
            links.push({
                source: nodeIdx['S:' + p[0]],
                target: nodeIdx['T:' + p[1]],
                value: stMap[k],
                sector: p[0],
                kind: 's2t',
            });
        });

        var PAD = 18;
        var sankeyGen = d3.sankey()
            .nodeWidth(14)
            .nodePadding(6)
            .extent([[PAD + 60, PAD], [s.w - PAD - 80, s.h - PAD - 8]])
            .nodeId(function (d) { return d.key; })
            .nodeAlign(d3.sankeyJustify);
        var graph = sankeyGen({
            nodes: nodes.map(function (n) { return Object.assign({}, n); }),
            links: links.map(function (l) { return Object.assign({}, l); }),
        });

        var colorFn = sectorColorFn(sectors);

        // ── 링크 ──
        var linkG = $svg.append('g').attr('class', 'flow-links').attr('fill', 'none');
        var linkSel = linkG.selectAll('path').data(graph.links).join('path')
            .attr('class', 'flow-link')
            .attr('d', d3.sankeyLinkHorizontal())
            .attr('stroke', function (d) { return colorFn(d.sector); })
            .attr('stroke-opacity', 0.28)
            .attr('stroke-width', function (d) { return Math.max(1, d.width); });

        linkSel.append('title').text(function (d) {
            var sName = (typeof d.source === 'object') ? d.source.name : '';
            var tName = (typeof d.target === 'object') ? d.target.name : '';
            return sName + '  →  ' + tName + '\n상승률 합 ' + d.value.toFixed(1) + '%';
        });

        // ── 노드 ──
        var nodeG = $svg.append('g').attr('class', 'flow-nodes');
        var nSel = nodeG.selectAll('g').data(graph.nodes).join('g')
            .attr('class', function (d) { return 'flow-node flow-node--col' + d.col; })
            .attr('transform', function (d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; });

        nSel.append('rect')
            .attr('width', function (d) { return d.x1 - d.x0; })
            .attr('height', function (d) { return Math.max(2, d.y1 - d.y0); })
            .attr('rx', 3)
            .attr('fill', function (d) {
                if (d.col === 0) return colorFn(d.name);                          // 섹터
                if (d.col === 1) return 'rgba(255,255,255,0.45)';                  // 테마
                return rateShade((d.stock && d.stock.change_rate) || 15);          // 종목
            })
            .style('cursor', function (d) { return d.col === 2 ? 'pointer' : 'default'; })
            .on('click', function (e, d) {
                if (d.col === 2 && d.stock) openModal(d.stock);
            });

        // 노드 라벨
        nSel.append('text')
            .attr('class', 'flow-node-label')
            .attr('y', function (d) { return (d.y1 - d.y0) / 2; })
            .attr('dy', '.32em')
            .attr('fill', 'currentColor')
            .attr('font-size', function (d) { return d.col === 2 ? 11 : 12; })
            .attr('font-weight', function (d) { return d.col === 0 ? 700 : 600; })
            .attr('x', function (d) { return d.col === 2 ? (d.x1 - d.x0) + 6 : -6; })
            .attr('text-anchor', function (d) { return d.col === 2 ? 'start' : 'end'; })
            .text(function (d) {
                if (d.col === 2 && d.stock) {
                    var nm = shortLabel(d.name, 8);
                    return nm + '  +' + d.stock.change_rate.toFixed(1) + '%';
                }
                return shortLabel(d.name, 10);
            });

        // hover 강조
        nSel.on('mouseenter', function (event, d) {
            var connectedLinks = graph.links.filter(function (l) {
                var sk = (typeof l.source === 'object') ? l.source.key : l.source;
                var tk = (typeof l.target === 'object') ? l.target.key : l.target;
                return sk === d.key || tk === d.key;
            });
            var connectedNodes = new Set();
            connectedLinks.forEach(function (l) {
                var sk = (typeof l.source === 'object') ? l.source.key : l.source;
                var tk = (typeof l.target === 'object') ? l.target.key : l.target;
                connectedNodes.add(sk); connectedNodes.add(tk);
            });
            connectedNodes.add(d.key);
            linkSel.attr('stroke-opacity', function (l) {
                return connectedLinks.indexOf(l) >= 0 ? 0.7 : 0.06;
            });
            nSel.attr('opacity', function (n) { return connectedNodes.has(n.key) ? 1 : 0.25; });
        }).on('mouseleave', function () {
            linkSel.attr('stroke-opacity', 0.28);
            nSel.attr('opacity', 1);
        });

        nSel.filter(function (d) { return d.col === 2 && d.stock; })
            .append('title').text(function (d) {
                var r = d.stock;
                return r.name + ' (' + r.ticker + ')\n+' + r.change_rate.toFixed(2) + '%\n' +
                    (r.sector || '') + ' · ' + (r.theme_tag || '') + '\n' + (r.rise_reason || '');
            });

        applySearch();
    }

    function applySearch() {
        var q = (state.searchTerm || '').toLowerCase().trim();
        d3.selectAll('.flow-node--col2')
            .classed('dim', function (d) {
                if (!q) return false;
                var nm = (d.name || '').toLowerCase();
                var tk = (d.ticker || '').toLowerCase();
                return !(nm.indexOf(q) !== -1 || tk.indexOf(q) === 0);
            });
    }

    // ── 모달 ──
    function openModal(d) {
        var $modal = document.getElementById('bubbleModal');
        if (!$modal) return;
        document.getElementById('modalName').textContent = d.name || d.ticker;
        document.getElementById('modalTicker').textContent = d.ticker || '';
        document.getElementById('modalRate').textContent = '+' + d.change_rate.toFixed(2) + '%';
        document.getElementById('modalReason').textContent = d.rise_reason || '이유 미수집';
        document.getElementById('modalMeta').innerHTML =
            '<dt>섹터</dt><dd>' + (d.sector || '-') + '</dd>' +
            '<dt>테마</dt><dd>' + (d.theme_tag || '-') + '</dd>' +
            '<dt>시가총액</dt><dd>' + fmtCap(d.market_cap) + '</dd>' +
            '<dt>시장</dt><dd>' + (d.market || '-') + '</dd>';
        document.getElementById('modalCta').setAttribute('href', '/stock/' + d.ticker);
        $modal.style.display = 'flex';
    }
    function closeModal() { document.getElementById('bubbleModal').style.display = 'none'; }
    function bindModal() {
        document.getElementById('bubbleModalClose').addEventListener('click', closeModal);
        document.getElementById('bubbleModalOverlay').addEventListener('click', closeModal);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    }

    function bindSearch() {
        var $s = document.getElementById('flowSearch');
        if (!$s) return;
        $s.addEventListener('input', function () { state.searchTerm = $s.value; applySearch(); });
    }

    // ── 데이터 ──
    function loadAndRender() {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'flex';

        WhyAPI.getDates().then(function (dates) {
            if (!dates || !dates.length) throw new Error('거래일 데이터 없음');
            return WhyAPI.getRankings(dates[0]).then(function (data) {
                state.rankings = (data.rankings || []).filter(function (r) {
                    return r.change_rate != null && r.change_rate >= CUTOFF;
                });
                document.getElementById('flowCount').textContent = state.rankings.length;
                var d = dates[0];
                document.getElementById('flowDate').textContent =
                    d.slice(0,4) + '.' + d.slice(4,6) + '.' + d.slice(6,8);
                $loading.style.display = 'none';
                render();
                window.addEventListener('resize', function () {
                    clearTimeout(window._flowResize);
                    window._flowResize = setTimeout(render, 250);
                });
            });
        }).catch(function (err) {
            $loading.style.display = 'none';
            $msg.textContent = '데이터 로딩 실패: ' + err.message;
            $msg.style.display = 'flex';
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        bindThemeToggle();
        bindSearch();
        bindModal();
        loadAndRender();
    });
})();
