/**
 * 흐름맵 — stock-rise rankings (그날 +15% 친 종목 TOP 100) 을 시각화.
 *
 * 모드
 *   - rise:   평면 100개, 면적 = change_rate^2 (변동 큰 종목 강조)
 *   - sector: sector 그룹화. 트리=박스, 버블=d3.pack
 *   - theme:  theme_tags[] 한 종목이 여러 테마면 각 테마에 중복 등록
 *
 * 표시
 *   - tree:   d3.treemap squarified
 *   - bubble: d3.pack (큰 원 안 작은 원) — 정적, 부드러운 transition
 *
 * 색  = change_rate (빨강·파랑). 클릭 = /stock/{ticker}.
 */
(function () {
    'use strict';

    var KST_OFFSET = 9 * 60;
    var OPEN_MIN = 9 * 60;
    var CLOSE_MIN = 15 * 60 + 30;
    var POLL_MS = 60 * 1000;     // 60초 (stock-rise 일별이 5분 주기로 갱신되지만 ux 위해 짧게)
    var RING_CIRCUM = 2 * Math.PI * 9;
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    var MODE_LABEL = { rise: '상승률', sector: '주도섹터', theme: '핫테마' };
    var VIEW_LABEL = { tree: '트리', bubble: '버블' };

    // 섹터 표시 정규화 (트리맵·버블맵과 동일)
    var SECTOR_FORMAT = {
        '반도체와반도체장비': '반도체·장비',
        '소프트웨어와서비스': '소프트웨어·서비스',
        '제약과생물공학': '제약·바이오',
        '기술하드웨어와장비': '하드웨어·장비',
        '상업및전문서비스': '상업·전문서비스',
        '내구재와의류': '내구재·의류',
        '식품과주요생필품소매': '식품·생필품',
        '식품음료와담배': '식품·음료',
        '자동차와부품': '자동차·부품',
        '미디어와엔터테인먼트': '미디어·엔터',
        '건강관리장비와서비스': '의료장비·서비스',
        '운수창고업': '운수·창고',
        '기타금융': '기타 금융',
    };
    function displayGroup(name) {
        if (!name) return '기타';
        return SECTOR_FORMAT[name] || name;
    }

    var $stage = document.getElementById('tmapStage');
    var $svg = document.getElementById('tmapSvg');
    var $loading = document.getElementById('tmapLoading');
    var $message = document.getElementById('tmapMessage');
    var $clock = document.getElementById('tmapClock');
    var $date = document.getElementById('tmapDate');
    var $modeTabs = document.querySelectorAll('.tmap-tabs--mode .tmap-tab');
    var $viewTabs = document.querySelectorAll('.tmap-tabs--view .tmap-tab');
    var $save = document.getElementById('tmapSave');
    var $datePrev = document.getElementById('tmapDatePrev');
    var $dateNext = document.getElementById('tmapDateNext');
    var $back = document.getElementById('tmapBack');
    var $backLabel = document.getElementById('tmapBackLabel');
    var $live = document.getElementById('tmapLive');
    var $liveLabel = document.getElementById('tmapLiveLabel');
    var $ringFg = document.querySelector('.tmap-live__ring-fg');

    var state = {
        rankings: [],
        availableDates: [],
        dateIndex: 0,
        currentDate: '',
        mode: 'rise',
        view: 'bubble',
        zoomedGroup: null,    // sector/theme 이름 — 버블 모드의 그룹 dive 상태
    };

    var simulation = null;
    var lastNodes = [];

    // ── 시간 / 포맷 ────────────────────────────────────
    function kstNow() { return new Date(Date.now() + KST_OFFSET * 60000); }
    function isMarketOpen() {
        var k = kstNow();
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }
    function isLiveDate() { return state.dateIndex === 0; }
    function formatClock() {
        var k = kstNow();
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        return pad(k.getUTCHours()) + ':' + pad(k.getUTCMinutes()) + ':' + pad(k.getUTCSeconds());
    }
    function formatDate(d) {
        if (!d || d.length !== 8) return '—';
        var y = d.slice(0, 4), m = d.slice(4, 6), day = d.slice(6, 8);
        var dt = new Date(+y, +m - 1, +day);
        var dow = ['일', '월', '화', '수', '목', '금', '토'][dt.getDay()];
        return y + '.' + m + '.' + day + ' (' + dow + ')';
    }
    function formatRate(r) {
        if (r == null || isNaN(r)) return '0.00%';
        return (r >= 0 ? '+' : '') + r.toFixed(2) + '%';
    }
    function formatMcap(억) {
        if (!억) return '-';
        if (억 >= 100 * 10000) return Math.round(억 / 10000).toLocaleString() + '조';
        if (억 >= 10000) return (억 / 10000).toFixed(1) + '조';
        return Math.round(억).toLocaleString() + '억';
    }
    function colorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) return 'hsl(220, 5%, 28%)';
        var r = Math.max(-5, Math.min(30, rate));
        var t = Math.min(1, Math.abs(r) / 15);
        if (r > 0) return 'hsl(0, ' + (70 + t * 25) + '%, ' + (32 + t * 24) + '%)';
        return 'hsl(220, ' + (60 + t * 25) + '%, ' + (32 - t * 12) + '%)';
    }
    function edgeColorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) return 'hsl(220, 6%, 58%)';
        var r = Math.max(-5, Math.min(30, rate));
        var t = Math.min(1, Math.abs(r) / 15);
        if (r > 0) return 'hsl(0, ' + (80 + t * 12) + '%, ' + (54 + t * 6) + '%)';
        return 'hsl(220, ' + (70 + t * 12) + '%, ' + (52 - t * 4) + '%)';
    }

    // ── 데이터 가공 ────────────────────────────────────
    // stock-rise rankings 의 market_cap 단위 = 원. formatMcap 은 억원 입력 가정.
    // fetch 시점에 정규화하여 모든 후속 처리 일관.
    function normalizeRanking(r) {
        return Object.assign({}, r, {
            market_cap: Math.max(1, Math.round((r.market_cap || 0) / 1e8)),  // 원 → 억원
        });
    }
    function activeItems() {
        return (state.rankings || []).filter(function (r) {
            return !BLOCKED_TICKERS[r.ticker] && r.ticker && (r.change_rate || 0) > 0;
        });
    }
    function sizeOf(it) {
        var r = it.change_rate || 0;
        return r > 0 ? r * r : 1;
    }
    var RISE_CUTOFF = 15;   // 상승률 모드 컷오프 (%)
    function buildHierarchy() {
        var items = activeItems();
        if (state.mode === 'rise') {
            // 상승률 모드: +15% 이상만. change_rate desc 정렬
            var filtered = items.filter(function (it) { return (it.change_rate || 0) >= RISE_CUTOFF; });
            filtered.sort(function (a, b) { return (b.change_rate || 0) - (a.change_rate || 0); });
            return { children: filtered };
        }
        if (state.mode === 'sector') {
            var by = {};
            items.forEach(function (it) {
                var s = it.sector || '기타';
                (by[s] = by[s] || []).push(it);
            });
            return {
                children: Object.keys(by).map(function (k) {
                    return { name: k, isGroup: true, children: by[k] };
                }),
            };
        }
        // theme — 한 종목이 여러 테마면 각 테마에 중복 (시각 가중치 자연). 그룹 수 제한 없음
        var by2 = {};
        items.forEach(function (it) {
            var tags = (it.theme_tags && it.theme_tags.length) ? it.theme_tags : (it.theme_tag ? [it.theme_tag] : []);
            tags.forEach(function (t) {
                if (!t) return;
                (by2[t] = by2[t] || []).push(it);
            });
        });
        var groups = Object.keys(by2).map(function (k) {
            return { name: k, isGroup: true, children: by2[k] };
        });
        groups.sort(function (a, b) { return b.children.length - a.children.length; });
        return { children: groups };
    }

    // 버블 모드 — 그룹 노드 산출 (sector/theme 모드에서 사용)
    function groupNodes() {
        var hier = buildHierarchy();
        return (hier.children || []).map(function (g) {
            var children = g.children || [];
            var sum = 0, maxRate = 0;
            children.forEach(function (c) {
                var r = c.change_rate || 0;
                sum += r > 0 ? r * r : 0;
                if (r > maxRate) maxRate = r;
            });
            // 그룹 사이즈 = 종목 change_rate^2 합. 그룹 색 = 그 그룹 최고 상승률
            return {
                name: g.name,
                isGroup: true,
                children: children,
                value: Math.max(sum, 1),
                topRate: maxRate,
            };
        });
    }

    // 줌인된 그룹의 종목 리스트
    function zoomedItems() {
        if (!state.zoomedGroup) return [];
        var groups = groupNodes();
        var picked = groups.filter(function (g) { return g.name === state.zoomedGroup; })[0];
        return picked ? (picked.children || []) : [];
    }

    // ── 렌더링 공통 ────────────────────────────────────
    function clearSvg() {
        d3.select($svg).selectAll('*').remove();
    }

    function renderEmpty() {
        clearSvg();
        $message.style.display = '';
        $message.textContent = '이 날짜엔 +15% 이상 오른 종목이 없습니다.';
    }

    function render() {
        var items = activeItems();
        var w = $stage.clientWidth;
        var h = $stage.clientHeight;
        if (w < 80 || h < 80) return;
        if (!items.length) return renderEmpty();
        $message.style.display = 'none';
        if (state.view === 'tree') renderTree(w, h);
        else renderBubble(w, h);
    }

    // ── 트리맵 ─────────────────────────────────────────
    function renderTree(w, h) {
        var grouped = state.mode !== 'rise';
        var SECTOR_LABEL_H = 22;
        var root = d3.hierarchy(buildHierarchy())
            .sum(function (d) { return d.children ? 0 : sizeOf(d); })
            .sort(function (a, b) { return b.value - a.value; });
        d3.treemap()
            .size([w, h])
            .paddingOuter(grouped ? 4 : 0)
            .paddingTop(function (d) {
                if (!grouped) return 0;
                if (d.depth === 0) return 0;
                if (d.data && d.data.isGroup) return SECTOR_LABEL_H;
                return 0;
            })
            .paddingInner(grouped ? 5 : 2)
            .round(true)(root);

        var svg = d3.select($svg)
            .attr('width', w).attr('height', h)
            .attr('viewBox', '0 0 ' + w + ' ' + h);
        svg.selectAll('*').remove();

        if (grouped) {
            var sectorG = svg.selectAll('g.tmap-sector')
                .data(root.children || [])
                .enter().append('g')
                .attr('class', 'tmap-sector')
                .attr('transform', function (d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; });
            sectorG.append('rect')
                .attr('class', 'tmap-sector__box')
                .attr('width', function (d) { return Math.max(0, d.x1 - d.x0); })
                .attr('height', function (d) { return Math.max(0, d.y1 - d.y0); })
                .attr('rx', 4);
            sectorG.append('text')
                .attr('class', 'tmap-sector__label')
                .attr('x', 8).attr('y', 15)
                .text(function (d) {
                    var width = d.x1 - d.x0;
                    var name = displayGroup(d.data.name || '기타');
                    var max = Math.max(2, Math.floor(width / 8));
                    if (name.length > max) name = name.slice(0, max - 1) + '…';
                    return name + ' · ' + (d.children || []).length;
                });
            sectorG.append('title').text(function (d) {
                var sum = 0;
                (d.children || []).forEach(function (c) { sum += (c.data.change_rate || 0); });
                return displayGroup(d.data.name) + ' · ' + (d.children || []).length + '종목 · 합산 +' + sum.toFixed(1) + '%';
            });
        }

        var cell = svg.selectAll('g.tmap-cell')
            .data(root.leaves())
            .enter().append('g')
            .attr('class', 'tmap-cell')
            .attr('transform', function (d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; })
            .style('cursor', 'pointer')
            .on('click', function (e, d) {
                if (d && d.data && d.data.ticker) window.location.href = '/stock/' + d.data.ticker;
            });
        cell.append('rect')
            .attr('width', function (d) { return Math.max(0, d.x1 - d.x0); })
            .attr('height', function (d) { return Math.max(0, d.y1 - d.y0); })
            .attr('fill', function (d) { return colorFor(d.data.change_rate); })
            .attr('rx', 2);

        cell.each(function (d) {
            var cw = d.x1 - d.x0, ch = d.y1 - d.y0;
            if (cw < 36 || ch < 28) return;
            var g = d3.select(this);
            var nameSize = Math.max(10, Math.min(20, cw / 8));
            var rateSize = Math.max(9, nameSize - 3);
            var name = d.data.name || '';
            var maxChars = Math.max(2, Math.floor(cw / (nameSize * 0.55)) - 1);
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';
            var has2 = ch >= 42;
            function line(cls, y, size, txt, opacity) {
                var t = g.append('text').attr('class', cls)
                    .attr('x', cw / 2).attr('y', y)
                    .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                    .style('font-size', size + 'px').text(txt);
                if (opacity != null) t.style('opacity', opacity);
                return t;
            }
            if (has2) {
                line('tmap-name', ch / 2 - rateSize / 2, nameSize, name);
                line('tmap-rate', ch / 2 + nameSize / 2 + 2, rateSize, formatRate(d.data.change_rate));
            } else {
                line('tmap-name', ch / 2, nameSize, name);
            }
        });

        cell.append('title').text(function (d) {
            return d.data.name + ' (' + d.data.ticker + ')\n'
                + d.data.market + (d.data.sector ? ' · ' + displayGroup(d.data.sector) : '') + '\n'
                + '시총: ' + formatMcap(d.data.market_cap) + '\n'
                + formatRate(d.data.change_rate);
        });
    }

    // ── 버블맵 — force 기반 둥둥. mode='rise' or zoomedGroup 있으면 종목, 아니면 그룹 ──
    function renderBubble(w, h) {
        var grouped = state.mode !== 'rise';
        var showItems = !grouped || !!state.zoomedGroup;
        if (showItems) renderItemBubbles(w, h);
        else renderGroupBubbles(w, h);
    }

    // 그룹 큰 원만 떠다님 (sector/theme 모드 첫 화면)
    // 디자인: 종목 버블과 동일한 외곽 그라데이션 + 그레이 톤 (그룹은 변동률 의미 없으므로)
    function renderGroupBubbles(w, h) {
        var groups = groupNodes();
        if (!groups.length) return renderEmpty();

        var totalSize = 0;
        groups.forEach(function (g) { totalSize += g.value; });
        var fillRatio = 0.55;
        var rMin = Math.max(28, Math.min(w, h) * 0.06);
        var rMax = Math.min(w, h) * 0.28;
        var k = totalSize > 0 ? Math.sqrt((w * h * fillRatio) / (Math.PI * totalSize)) : 50;

        var nodes = groups.map(function (g) {
            var r = Math.max(rMin, Math.min(rMax, k * Math.sqrt(g.value)));
            return Object.assign({}, g, {
                r: r,
                x: r + Math.random() * (w - r * 2),
                y: r + Math.random() * (h - r * 2),
                vx: 0, vy: 0,
            });
        });

        var svg = d3.select($svg).attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);
        svg.selectAll('*').remove();
        var defs = svg.append('defs');

        // 종목과 동일한 글래스 그라데이션 — 단, 그레이 톤 (그룹은 변동률 의미 없음)
        var groupEdge = 'hsl(220, 8%, 64%)';
        nodes.forEach(function (d, i) {
            var gid = 'flow-gr-' + i;
            d._gradId = gid;
            var grad = defs.append('radialGradient').attr('id', gid)
                .attr('cx', '50%').attr('cy', '50%').attr('r', '50%');
            grad.append('stop').attr('offset', '0%').attr('stop-color', groupEdge).attr('stop-opacity', 0);
            grad.append('stop').attr('offset', '45%').attr('stop-color', groupEdge).attr('stop-opacity', 0);
            grad.append('stop').attr('offset', '78%').attr('stop-color', groupEdge).attr('stop-opacity', 0.16);
            grad.append('stop').attr('offset', '95%').attr('stop-color', groupEdge).attr('stop-opacity', 0.5);
            grad.append('stop').attr('offset', '100%').attr('stop-color', groupEdge).attr('stop-opacity', 0.8);
        });

        var g = svg.selectAll('g.flow-group')
            .data(nodes, function (d) { return d.name; })
            .enter().append('g')
            .attr('class', 'flow-group flow-group--clickable')
            .style('cursor', 'pointer')
            .on('click', function (e, d) {
                state.zoomedGroup = d.name;
                updateBackBtn();
                render();
            });
        g.append('circle')
            .attr('class', 'flow-group__bigcircle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return 'url(#' + d._gradId + ')'; })
            .attr('stroke', groupEdge)
            .attr('stroke-width', 1)
            .attr('stroke-opacity', 0.45);
        g.each(function (d) {
            var sel = d3.select(this);
            var r = d.r;
            var labelSize = Math.max(11, Math.min(22, r * 0.20));
            var countSize = Math.max(9, Math.min(14, r * 0.13));
            var name = displayGroup(d.name || '');
            var maxChars = Math.max(3, Math.floor(r / (labelSize * 0.42)));
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';
            sel.append('text')
                .attr('class', 'flow-group__name')
                .attr('text-anchor', 'middle')
                .attr('dominant-baseline', 'middle')
                .attr('y', -countSize / 2 - 1)
                .style('font-size', labelSize + 'px')
                .attr('pointer-events', 'none')
                .text(name);
            sel.append('text')
                .attr('class', 'flow-group__count')
                .attr('text-anchor', 'middle')
                .attr('dominant-baseline', 'middle')
                .attr('y', labelSize / 2 + 1)
                .style('font-size', countSize + 'px')
                .attr('pointer-events', 'none')
                .text((d.children || []).length + '종목 · 최고 +' + d.topRate.toFixed(1) + '%');
        });
        g.append('title').text(function (d) {
            return displayGroup(d.name) + ' · ' + (d.children || []).length + '종목 · 최고 +' + d.topRate.toFixed(1) + '%';
        });

        runForceSimulation(nodes, w, h, g, 0.08);
    }

    // 종목 원 — rise 모드 평면 또는 zoom 모드 그룹 내 종목
    function renderItemBubbles(w, h) {
        var items;
        if (state.zoomedGroup) items = zoomedItems();
        else items = buildHierarchy().children || [];   // rise 모드: TOP 50 (buildHierarchy 가 cut)
        if (!items.length) return renderEmpty();

        var totalSize = 0;
        items.forEach(function (d) { totalSize += sizeOf(d); });
        var fillRatio = state.zoomedGroup ? 0.55 : 0.62;
        var rMax = Math.min(w, h) * 0.24;
        var rMin = Math.max(10, Math.min(w, h) * 0.022);
        var k = totalSize > 0 ? Math.sqrt((w * h * fillRatio) / (Math.PI * totalSize)) : Math.min(w, h) * 0.05;

        var prev = {};
        lastNodes.forEach(function (n) { prev[n.ticker] = n; });
        var nodes = items.map(function (d) {
            var r = Math.max(rMin, Math.min(rMax, k * Math.sqrt(sizeOf(d))));
            var p = prev[d.ticker];
            return Object.assign({}, d, {
                r: r,
                x: p ? p.x : (r + Math.random() * (w - r * 2)),
                y: p ? p.y : (r + Math.random() * (h - r * 2)),
                vx: p ? p.vx : 0,
                vy: p ? p.vy : 0,
            });
        });
        lastNodes = nodes;

        var svg = d3.select($svg).attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);
        svg.selectAll('*').remove();
        var defs = svg.append('defs');
        nodes.forEach(function (d, i) {
            var gid = 'flow-it-' + i;
            d._gradId = gid;
            var edge = edgeColorFor(d.change_rate);
            var grad = defs.append('radialGradient').attr('id', gid)
                .attr('cx', '50%').attr('cy', '50%').attr('r', '50%');
            grad.append('stop').attr('offset', '0%').attr('stop-color', edge).attr('stop-opacity', 0);
            grad.append('stop').attr('offset', '45%').attr('stop-color', edge).attr('stop-opacity', 0);
            grad.append('stop').attr('offset', '78%').attr('stop-color', edge).attr('stop-opacity', 0.18);
            grad.append('stop').attr('offset', '95%').attr('stop-color', edge).attr('stop-opacity', 0.55);
            grad.append('stop').attr('offset', '100%').attr('stop-color', edge).attr('stop-opacity', 0.85);
        });

        // 드래그 vs 클릭 구분
        var dragMoved = 0;
        function onDragStart(event, d) { dragMoved = 0; d.fx = d.x; d.fy = d.y; }
        function onDrag(event, d) {
            dragMoved += Math.abs(event.dx) + Math.abs(event.dy);
            d.fx = event.x; d.fy = event.y;
            if (simulation) simulation.alpha(1);
        }
        function onDragEnd(event, d) {
            d.fx = null; d.fy = null;
            if (dragMoved < 4 && d && d.ticker) window.location.href = '/stock/' + d.ticker;
        }

        var node = svg.selectAll('g.flow-node')
            .data(nodes, function (d) { return d.ticker; })
            .enter().append('g')
            .attr('class', 'flow-node')
            .style('cursor', 'pointer')
            .call(d3.drag().on('start', onDragStart).on('drag', onDrag).on('end', onDragEnd));
        node.append('circle')
            .attr('class', 'flow-node__circle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return 'url(#' + d._gradId + ')'; })
            .attr('stroke', function (d) { return edgeColorFor(d.change_rate); })
            .attr('stroke-width', 1)
            .attr('stroke-opacity', 0.5);

        node.each(function (d) {
            var sel = d3.select(this);
            var r = d.r;
            if (r < 14) return;
            var nameSize = Math.max(8, Math.min(16, r * 0.4));
            var rateSize = Math.max(7, Math.min(13, r * 0.3));
            var name = d.name || '';
            var maxChars = Math.max(2, Math.floor(r * 1.8 / nameSize));
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';
            var has2 = r >= 22;
            function line(cls, y, size, txt) {
                sel.append('text').attr('class', cls)
                    .attr('x', 0).attr('y', y)
                    .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                    .attr('pointer-events', 'none')
                    .style('font-size', size + 'px').text(txt);
            }
            if (has2) {
                line('flow-node__name', -rateSize / 2 - 1, nameSize, name);
                line('flow-node__rate', nameSize / 2 + 1, rateSize, formatRate(d.change_rate));
            } else {
                line('flow-node__name', 0, nameSize, name);
            }
        });

        node.append('title').text(function (d) {
            return d.name + ' (' + d.ticker + ')\n'
                + d.market + (d.sector ? ' · ' + displayGroup(d.sector) : '') + '\n'
                + '시총: ' + formatMcap(d.market_cap) + '\n'
                + formatRate(d.change_rate);
        });

        runForceSimulation(nodes, w, h, node, 0.10);
    }

    // 공통 force simulation (그룹·종목 양쪽에서 사용)
    function runForceSimulation(nodes, w, h, selection, drift) {
        if (simulation) simulation.stop();
        function driftForce() {
            for (var i = 0; i < nodes.length; i++) {
                nodes[i].vx += (Math.random() - 0.5) * drift;
                nodes[i].vy += (Math.random() - 0.5) * drift;
            }
        }
        simulation = d3.forceSimulation(nodes)
            .alpha(1).alphaMin(0).alphaDecay(0)
            .velocityDecay(0.14)
            .force('charge', d3.forceManyBody().strength(-10).distanceMax(140))
            .force('collide', d3.forceCollide().radius(function (d) { return d.r + 3; }).strength(1.0).iterations(4))
            .force('drift', driftForce)
            .on('tick', function () {
                selection.attr('transform', function (d) {
                    var pad = d.r;
                    if (d.x < pad) { d.x = pad; d.vx = Math.abs(d.vx) * 0.6; }
                    if (d.x > w - pad) { d.x = w - pad; d.vx = -Math.abs(d.vx) * 0.6; }
                    if (d.y < pad) { d.y = pad; d.vy = Math.abs(d.vy) * 0.6; }
                    if (d.y > h - pad) { d.y = h - pad; d.vy = -Math.abs(d.vy) * 0.6; }
                    return 'translate(' + d.x + ',' + d.y + ')';
                });
            });
    }

    function updateBackBtn() {
        if (state.zoomedGroup) {
            $back.style.display = '';
            $backLabel.textContent = displayGroup(state.zoomedGroup);
        } else {
            $back.style.display = 'none';
        }
    }

    // ── 라이브 ring ───────────────────────────────────
    function startRingFill() {
        if (!$ringFg) return;
        $ringFg.style.transition = 'none';
        $ringFg.style.strokeDashoffset = String(RING_CIRCUM);
        void $ringFg.getBoundingClientRect();
        $ringFg.style.transition = 'stroke-dashoffset ' + (POLL_MS / 1000) + 's linear';
        $ringFg.style.strokeDashoffset = '0';
    }
    function stopRingFill() {
        if (!$ringFg) return;
        $ringFg.style.transition = 'none';
        $ringFg.style.strokeDashoffset = String(RING_CIRCUM);
    }
    function setLiveState(open) {
        if (!$live) return;
        if (open) {
            $live.classList.remove('tmap-live--idle');
            $liveLabel.textContent = 'LIVE';
        } else {
            $live.classList.add('tmap-live--idle');
            $liveLabel.textContent = '장 마감';
            stopRingFill();
        }
        updateLastUpdated();   // 시각 부분 다시 붙임
    }

    function updateLastUpdated() {
        if (!$liveLabel) return;
        var t = state.collectedAt || '';
        if (!t) return;
        // 'YYYY-MM-DDTHH:MM:SS' → 'HH:MM'
        var hhmm = t.slice(11, 16);
        // LIVE 또는 장 마감 라벨 옆에 마지막 fetch 시각 함께
        var prefix = $liveLabel.textContent && $liveLabel.textContent.indexOf('LIVE') === 0 ? 'LIVE' : '장 마감';
        $liveLabel.textContent = prefix + ' · ' + hhmm;
    }

    // 새 데이터 도착 시 같은 ticker 위치 보존 + 그룹 화면이면 사이즈만 갱신
    function refreshLive() {
        if (!isLiveDate()) return Promise.resolve();
        return WhyAPI.getRankings(state.currentDate).then(function (data) {
            state.rankings = (data.rankings || []).map(normalizeRanking);
            state.collectedAt = data.collected_at || state.collectedAt;
            updateLastUpdated();
            render();   // lastNodes 에 prev x/y 있어 위치 유지
        }).catch(function () {});
    }

    // ring transition 시간 = setTimeout = fetch 정확 동기화 (chain pattern)
    function liveCycle() {
        var open = isMarketOpen();
        if (!isLiveDate() || !open || document.visibilityState === 'hidden') {
            setLiveState(false);
            setTimeout(liveCycle, 5000);
            return;
        }
        setLiveState(true);
        startRingFill();
        setTimeout(function () {
            refreshLive().then(function () { liveCycle(); });
        }, POLL_MS);
    }

    // ── 데이터 fetch ───────────────────────────────────
    function loadDate(date) {
        $loading.style.display = '';
        return WhyAPI.getRankings(date).then(function (data) {
            state.rankings = (data.rankings || []).map(normalizeRanking);
            state.collectedAt = data.collected_at || '';
            state.currentDate = date;
            updateDateNav();
            updateLastUpdated();
            $loading.style.display = 'none';
            render();
        }).catch(function (err) {
            $loading.style.display = 'none';
            $message.style.display = '';
            $message.textContent = '데이터 로딩 실패: ' + (err && err.message ? err.message : err);
        });
    }
    function loadDates() {
        return WhyAPI.getDates().then(function (dates) {
            state.availableDates = (dates || []).slice().sort().reverse();
            if (!state.availableDates.length) throw new Error('거래일 없음');
            state.dateIndex = 0;
            state.currentDate = state.availableDates[0];
            updateDateNav();
            return loadDate(state.currentDate);
        });
    }

    // ── 컨트롤 ────────────────────────────────────────
    function updateDateNav() {
        var n = state.availableDates.length;
        var i = state.dateIndex;
        if ($datePrev) $datePrev.disabled = i >= n - 1;
        if ($dateNext) $dateNext.disabled = i <= 0;
        $date.textContent = formatDate(state.currentDate);
    }
    function gotoDateIndex(idx) {
        if (idx < 0 || idx >= state.availableDates.length) return;
        state.dateIndex = idx;
        state.zoomedGroup = null;
        lastNodes = [];
        updateBackBtn();
        var d = state.availableDates[idx];
        loadDate(d);
    }
    function openDatePicker() {
        if (!window.DatePicker || !state.availableDates.length) return;
        DatePicker.open({
            trigger: $date,
            dates: state.availableDates,
            current: state.currentDate,
            onSelect: function (picked) {
                var idx = state.availableDates.indexOf(picked);
                if (idx < 0 || idx === state.dateIndex) return;
                gotoDateIndex(idx);
            },
        });
    }
    function setMode(m) {
        if (state.mode === m) return;
        state.mode = m;
        state.zoomedGroup = null;
        lastNodes = [];
        updateBackBtn();
        $modeTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-mode') === m);
        });
        render();
    }
    function setView(v) {
        if (state.view === v) return;
        state.view = v;
        lastNodes = [];
        $viewTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-view') === v);
        });
        render();
    }
    function bindThemeToggle() {
        var btn = document.getElementById('themeToggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('theme', next);
        });
    }

    // ── PNG 저장 ──────────────────────────────────────
    function savePNG() {
        var svgEl = $svg;
        var w = svgEl.clientWidth, h = svgEl.clientHeight;
        if (w < 80 || h < 80) return;
        var HEAD_H = 44;
        var totalH = h + HEAD_H;
        var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
        var bgColor = isDark ? '#191919' : '#ffffff';
        var fgColor = isDark ? '#ffffff' : '#191919';
        var fgDim = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(10,11,15,0.55)';
        var fontStack = '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Noto Sans KR", sans-serif';
        var ns = 'http://www.w3.org/2000/svg';

        function mkText(x, y, txt, opts) {
            opts = opts || {};
            var t = document.createElementNS(ns, 'text');
            t.setAttribute('x', String(x)); t.setAttribute('y', String(y));
            t.setAttribute('fill', opts.fill || fgColor);
            t.setAttribute('font-size', String(opts.size || 12));
            t.setAttribute('font-weight', String(opts.weight || 600));
            t.setAttribute('font-family', fontStack);
            if (opts.anchor) t.setAttribute('text-anchor', opts.anchor);
            t.textContent = txt;
            return t;
        }

        var wrap = document.createElementNS(ns, 'svg');
        wrap.setAttribute('xmlns', ns);
        wrap.setAttribute('width', String(w)); wrap.setAttribute('height', String(totalH));
        wrap.setAttribute('viewBox', '0 0 ' + w + ' ' + totalH);
        var bg = document.createElementNS(ns, 'rect');
        bg.setAttribute('width', String(w)); bg.setAttribute('height', String(totalH));
        bg.setAttribute('fill', bgColor);
        wrap.appendChild(bg);

        wrap.appendChild(mkText(20, HEAD_H - 16, '이거왜오름?', { size: 16, weight: 800, fill: fgColor }));
        wrap.appendChild(mkText(132, HEAD_H - 16, 'whyrise.vercel.app', { size: 11, weight: 600, fill: fgDim }));
        var ctxStr = '흐름맵 · ' + (MODE_LABEL[state.mode] || state.mode) + ' · ' + (VIEW_LABEL[state.view] || state.view)
            + '   ·   ' + formatDate(state.currentDate);
        wrap.appendChild(mkText(w - 20, HEAD_H - 16, ctxStr, { size: 13, weight: 700, fill: fgColor, anchor: 'end' }));

        var clone = svgEl.cloneNode(true);
        // 인라인 스타일 보강 (외부 CSS 가 PNG 에 안 묻음)
        var sectorBoxFill = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.035)';
        var sectorBoxStroke = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.16)';
        var labelFill = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(20,22,28,0.92)';
        var cellStroke = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.45)';

        clone.querySelectorAll('.tmap-sector__box').forEach(function (el) {
            el.setAttribute('fill', sectorBoxFill);
            el.setAttribute('stroke', sectorBoxStroke);
            el.setAttribute('stroke-width', '1');
        });
        clone.querySelectorAll('.tmap-sector__label').forEach(function (el) {
            el.setAttribute('fill', labelFill);
            el.setAttribute('font-family', fontStack);
            el.setAttribute('font-weight', '800');
        });
        clone.querySelectorAll('.tmap-cell text').forEach(function (el) {
            el.setAttribute('fill', '#fff'); el.setAttribute('font-family', fontStack);
            el.setAttribute('paint-order', 'stroke');
            el.setAttribute('stroke', cellStroke); el.setAttribute('stroke-width', '0.6');
        });
        clone.querySelectorAll('.flow-group__circle').forEach(function (el) {
            el.setAttribute('fill', 'none');
            el.setAttribute('stroke', sectorBoxStroke);
            el.setAttribute('stroke-width', '1');
            el.setAttribute('stroke-dasharray', '4 3');
        });
        clone.querySelectorAll('.flow-group__label').forEach(function (el) {
            el.setAttribute('fill', labelFill);
            el.setAttribute('font-family', fontStack); el.setAttribute('font-weight', '700');
        });
        // 그룹 큰 원 — JS 인라인 그라데이션이 fill 이미 적용. stroke 만 그레이 톤 유지.
        clone.querySelectorAll('.flow-group__bigcircle').forEach(function (el) {
            el.setAttribute('stroke', 'hsl(220, 8%, 64%)');
            el.setAttribute('stroke-width', '1');
        });
        clone.querySelectorAll('.flow-group__name').forEach(function (el) {
            el.setAttribute('fill', '#fff'); el.setAttribute('font-family', fontStack);
            el.setAttribute('font-weight', '800');
            el.setAttribute('paint-order', 'stroke');
            el.setAttribute('stroke', cellStroke); el.setAttribute('stroke-width', '0.6');
        });
        clone.querySelectorAll('.flow-group__count').forEach(function (el) {
            el.setAttribute('fill', 'rgba(255,255,255,0.85)'); el.setAttribute('font-family', fontStack);
            el.setAttribute('font-weight', '600');
        });
        clone.querySelectorAll('.flow-node text').forEach(function (el) {
            el.setAttribute('fill', '#fff'); el.setAttribute('font-family', fontStack);
            el.setAttribute('paint-order', 'stroke');
            el.setAttribute('stroke', cellStroke); el.setAttribute('stroke-width', '0.6');
        });

        var mapG = document.createElementNS(ns, 'g');
        mapG.setAttribute('transform', 'translate(0, ' + HEAD_H + ')');
        while (clone.firstChild) mapG.appendChild(clone.firstChild);
        wrap.appendChild(mapG);

        var svgStr = new XMLSerializer().serializeToString(wrap);
        var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
            var canvas = document.createElement('canvas');
            canvas.width = w * 2; canvas.height = totalH * 2;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bgColor; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            canvas.toBlob(function (b) {
                if (!b) return;
                var dl = URL.createObjectURL(b);
                var a = document.createElement('a');
                var stamp = (state.currentDate || '').replace(/[^0-9]/g, '');
                a.href = dl; a.download = 'whyrise-flowmap-' + stamp + '-' + state.mode + '-' + state.view + '.png';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                URL.revokeObjectURL(dl);
            }, 'image/png');
        };
        img.onerror = function () { URL.revokeObjectURL(url); };
        img.src = url;
    }

    // ── 초기화 ─────────────────────────────────────────
    function init() {
        bindThemeToggle();
        $modeTabs.forEach(function (b) {
            b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
        });
        $viewTabs.forEach(function (b) {
            b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
        });
        if ($save) $save.addEventListener('click', savePNG);
        if ($datePrev) $datePrev.addEventListener('click', function () { gotoDateIndex(state.dateIndex + 1); });
        if ($dateNext) $dateNext.addEventListener('click', function () { gotoDateIndex(state.dateIndex - 1); });
        if ($date) $date.addEventListener('click', openDatePicker);
        if ($back) $back.addEventListener('click', function () {
            state.zoomedGroup = null;
            lastNodes = [];
            updateBackBtn();
            render();
        });

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                if (simulation) simulation.alpha(1).restart();
            } else {
                if (simulation) simulation.stop();
            }
        });

        // 시계 element 제거 — LIVE 라벨의 마지막 업데이트 시각만 표시

        loadDates().then(function () {
            liveCycle();   // chain pattern 시작
        }).catch(function (err) {
            $loading.style.display = 'none';
            $message.style.display = '';
            $message.textContent = '데이터를 불러올 수 없습니다 — ' + (err && err.message ? err.message : err);
        });

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
