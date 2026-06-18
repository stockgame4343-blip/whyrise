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
    var OPEN_MIN = 8 * 60; // NXT 시작 08:00부터 라이브 대기
    var CLOSE_MIN = 15 * 60 + 30;
    var POLL_MS = 30 * 1000;     // 30초 — 라이브 숫자(/api/marketmap) 오버레이 주기. ring 도 이 값에 동기.
    var IDLE_RECHECK_MS = 5000;          // 비라이브 상태 재확인 주기
    var STATUS_RECHECK_MS = 5 * 60 * 1000; // 서버 CLOSE(공휴일/오판) 재확인 주기
    var CLOSE_SETTLE_MS = 90 * 1000;     // 마감 후 확정 종가 fetch 지연 (동시호가 체결 대기)
    var RING_CIRCUM = 2 * Math.PI * 9;
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };
    // 모바일 탭은 손가락 떨림으로 시작점 주변에서 왕복함. 누적 경로가 아니라
    // "시작점으로부터의 최대 변위" 가 임계값을 넘어야 드래그로 친다. 10px 반경.
    var TAP_RADIUS_SQ = 100;

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

    function initialView() {
        try {
            var view = new URLSearchParams(window.location.search).get('view');
            if (view === 'tree' || view === 'bubble') return view;
            if (new URLSearchParams(window.location.search).get('embed') === 'leaders2') return 'tree';
        } catch (err) {}
        return 'bubble';
    }

    var state = {
        rankings: [],
        availableDates: [],
        dateIndex: 0,
        currentDate: '',
        virtualDate: '',      // 라이브가 알려준 오늘 거래일 — 빌드(dates.json) 도착 전 라벨/피커용
        mode: 'sector',
        view: initialView(),
        zoomedGroup: null,    // sector/theme 이름 — 버블 모드의 그룹 dive 상태
        marketStatus: '',     // ''=미확인(로컬 시계 신뢰) | 'OPEN' | 'CLOSE' (서버 판정 — 공휴일 포함)
    };

    var simulation = null;
    var lastNodes = [];
    var lastGroupNodes = [];  // 그룹 버블 위치 보존 — 라이브 갱신마다 랜덤 재배치 방지 (name 키)

    // ── 시간 / 포맷 ────────────────────────────────────
    function kstNow() { return new Date(Date.now() + KST_OFFSET * 60000); }
    function isMarketOpen() {
        var k = kstNow();
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }
    function isNxtLeadIn() {
        var k = kstNow();
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < 9 * 60;
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
    function positiveLeaderT(rate) {
        return Math.max(0, Math.min(1, (rate - 10) / 20));
    }
    function colorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) return 'hsl(220, 5%, 28%)';
        if (rate > 0) {
            var pt = positiveLeaderT(rate);
            return 'hsl(0, ' + (65 + pt * 20) + '%, ' + (32 + pt * 30) + '%)';
        }
        var r = Math.max(-5, Math.min(5, rate));
        var t = Math.abs(r) / 5;
        return 'hsl(220, ' + (55 + t * 25) + '%, ' + (32 - t * 23) + '%)';
    }
    function edgeColorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) return 'hsl(220, 6%, 58%)';
        if (rate > 0) {
            var pt = positiveLeaderT(rate);
            return 'hsl(0, ' + (80 + pt * 12) + '%, ' + (54 + pt * 6) + '%)';
        }
        var r = Math.max(-5, Math.min(5, rate));
        var t = Math.abs(r) / 5;
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
        // NXT 프리마켓(08~09시)엔 NXT 시세가 있는 종목만 — 어제 급등주가 어제 등락률로
        // 박제되는 것 방지(라이브 맵 미수신 전이면 필터 보류해 빈 화면 회피). 09:00 정규장부턴 해제.
        var leadInLive = isLiveDate() && isNxtLeadIn() && state.liveMap;
        return (state.rankings || []).filter(function (r) {
            if (!r.ticker || BLOCKED_TICKERS[r.ticker]) return false;
            if (leadInLive && !state.liveMap[r.ticker]) return false;
            return (r.change_rate || 0) > 0;
        });
    }
    // 주도주는 stock-rise rankings (그날 1d) 만 사용 — 항상 1d 기준이라 항상 캡.
    // 한국 일일 상한 +30%, 신규상장만 +100/+300% (왜곡) → +30% 초과 동일 사이즈 (+30% 의 1.3배)
    var CHANGE_SIZE_THRESHOLD = 30;
    var CHANGE_SIZE_CAP_SCORE = 30 * 30 * 1.3;
    function sizeOf(it) {
        var r = it.change_rate || 0;
        if (r <= 0) return 1;
        if (r > CHANGE_SIZE_THRESHOLD) return CHANGE_SIZE_CAP_SCORE;
        return r * r;
    }
    var RISE_CUTOFF = 15;   // 상승률 모드 컷오프 (%)
    var GROUP_MIN = 3;      // 주도섹터·핫테마: 그룹 종목 ≥ N 만 표시 (1·2 종목짜리 노이즈 제거)
    function buildHierarchy() {
        var items = activeItems();
        // 줌인 — sector/theme 모드에서 특정 그룹 선택. 그 그룹 종목만 flat. (트리·버블 공용)
        if (state.zoomedGroup && state.mode !== 'rise') {
            var picked = items.filter(function (it) {
                if (state.mode === 'sector') return (it.sector || '기타') === state.zoomedGroup;
                var tags = (it.theme_tags && it.theme_tags.length)
                    ? it.theme_tags : (it.theme_tag ? [it.theme_tag] : []);
                return tags.indexOf(state.zoomedGroup) >= 0;
            });
            picked.sort(function (a, b) { return (b.change_rate || 0) - (a.change_rate || 0); });
            return { children: picked };
        }
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
                children: Object.keys(by)
                    .filter(function (k) { return by[k].length >= GROUP_MIN; })
                    .map(function (k) {
                        return { name: k, isGroup: true, children: by[k] };
                    }),
            };
        }
        // theme — 한 종목이 여러 테마면 각 테마에 중복 (시각 가중치 자연). ≥3 그룹만
        var by2 = {};
        items.forEach(function (it) {
            var tags = (it.theme_tags && it.theme_tags.length) ? it.theme_tags : (it.theme_tag ? [it.theme_tag] : []);
            tags.forEach(function (t) {
                if (!t) return;
                (by2[t] = by2[t] || []).push(it);
            });
        });
        var groups = Object.keys(by2)
            .filter(function (k) { return by2[k].length >= GROUP_MIN; })
            .map(function (k) { return { name: k, isGroup: true, children: by2[k] }; });
        groups.sort(function (a, b) { return b.children.length - a.children.length; });
        return { children: groups };
    }

    // 버블 모드 — 그룹 노드 산출 (sector/theme 모드에서 사용)
    function groupNodes() {
        var hier = buildHierarchy();
        return (hier.children || []).map(function (g) {
            var children = g.children || [];
            var sizeSum = 0, rateSum = 0;
            children.forEach(function (c) {
                sizeSum += sizeOf(c);   // 사이즈는 캡 적용 (신규상장 outlier 방지)
                rateSum += (c.change_rate || 0);   // 평균용 — 실값
            });
            var avgRate = children.length > 0 ? rateSum / children.length : 0;
            return {
                name: g.name,
                isGroup: true,
                children: children,
                value: Math.max(sizeSum, 1),
                avgRate: avgRate,
            };
        });
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
        syncBodyState();
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
        // 줌 상태에서는 그룹 wrap 없이 flat — buildHierarchy 가 이미 flat 으로 자름
        var grouped = state.mode !== 'rise' && !state.zoomedGroup;
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
                .attr('class', 'tmap-sector tmap-sector--clickable')
                .attr('transform', function (d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; })
                .style('cursor', 'pointer')
                .on('click', function (e, d) {
                    // 종목 셀 클릭 시 사방으로 버블링되어 들어오는 이벤트 차단
                    if (e.target && e.target.closest && e.target.closest('g.tmap-cell')) return;
                    if (!d || !d.data || !d.data.isGroup) return;
                    state.zoomedGroup = d.data.name;
                    lastNodes = [];
                    updateBackBtn();
                    render();
                });
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
                var ch = d.children || [];
                var sum = 0;
                ch.forEach(function (c) { sum += (c.data.change_rate || 0); });
                var avg = ch.length > 0 ? sum / ch.length : 0;
                return displayGroup(d.data.name) + ' · ' + ch.length + '종목 · 평균 +' + avg.toFixed(1) + '%';
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
            var mcapSize = Math.max(8, Math.min(13, nameSize - 5));
            var name = d.data.name || '';
            var maxChars = Math.max(2, Math.floor(cw / (nameSize * 0.55)) - 1);
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';
            var has3 = ch >= 58;   // 이름·시총·상승률 3줄 들어갈 높이
            var has2 = ch >= 42;
            function line(cls, y, size, txt, opacity) {
                var t = g.append('text').attr('class', cls)
                    .attr('x', cw / 2).attr('y', y)
                    .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                    .style('font-size', size + 'px').text(txt);
                if (opacity != null) t.style('opacity', opacity);
                return t;
            }
            if (has3) {
                var gap = 2;
                var totalH = nameSize + mcapSize + rateSize + gap * 2;
                var top = ch / 2 - totalH / 2;
                line('tmap-name', top + nameSize / 2, nameSize, name);
                line('tmap-mcap', top + nameSize + gap + mcapSize / 2, mcapSize, formatMcap(d.data.market_cap));
                line('tmap-rate', top + nameSize + gap + mcapSize + gap + rateSize / 2, rateSize, formatRate(d.data.change_rate));
            } else if (has2) {
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

        // 같은 그룹은 직전 위치/속도 재사용 — 라이브 30초 갱신마다 전체 랜덤 재배치되는 문제 방지
        var prevG = {};
        lastGroupNodes.forEach(function (n) { prevG[n.name] = n; });
        var nodes = groups.map(function (g) {
            var r = Math.max(rMin, Math.min(rMax, k * Math.sqrt(g.value)));
            var p = prevG[g.name];
            return Object.assign({}, g, {
                r: r,
                x: p ? p.x : (r + Math.random() * (w - r * 2)),
                y: p ? p.y : (r + Math.random() * (h - r * 2)),
                vx: p ? p.vx : 0,
                vy: p ? p.vy : 0,
            });
        });
        lastGroupNodes = nodes;

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

        // 드래그·클릭 구분 — 시작점 대비 최대 변위가 TAP_RADIUS_SQ 안이면 탭(=zoom).
        // 누적 경로가 아니라 변위라서 손가락 떨림(왕복)을 흡수.
        var startX = 0, startY = 0, maxDistSq = 0;
        var g = svg.selectAll('g.flow-group')
            .data(nodes, function (d) { return d.name; })
            .enter().append('g')
            .attr('class', 'flow-group flow-group--clickable')
            .style('cursor', 'pointer')
            .call(d3.drag()
                .on('start', function (e, d) {
                    startX = e.x; startY = e.y; maxDistSq = 0;
                    d.fx = d.x; d.fy = d.y;
                })
                .on('drag', function (e, d) {
                    var ddx = e.x - startX, ddy = e.y - startY;
                    var d2 = ddx * ddx + ddy * ddy;
                    if (d2 > maxDistSq) maxDistSq = d2;
                    d.fx = e.x; d.fy = e.y;
                    if (simulation) simulation.alpha(1);
                })
                .on('end', function (e, d) {
                    d.fx = null; d.fy = null;
                    if (maxDistSq < TAP_RADIUS_SQ) {
                        state.zoomedGroup = d.name;
                        updateBackBtn();
                        render();
                    }
                })
            );
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
                .text((d.children || []).length + '종목 · 평균 +' + d.avgRate.toFixed(1) + '%');
        });
        g.append('title').text(function (d) {
            return displayGroup(d.name) + ' · ' + (d.children || []).length + '종목 · 평균 +' + d.avgRate.toFixed(1) + '%';
        });

        runForceSimulation(nodes, w, h, g, 0.08);
    }

    // 종목 원 — rise 모드 평면 또는 zoom 모드 그룹 내 종목
    function renderItemBubbles(w, h) {
        // rise 모드 / 줌인 모드 모두 buildHierarchy 가 flat 종목 배열로 잘라 둠.
        var items = buildHierarchy().children || [];
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

        // 드래그 vs 클릭 — 시작점 대비 최대 변위 기준 (떨림 흡수)
        var startX = 0, startY = 0, maxDistSq = 0;
        function onDragStart(event, d) {
            startX = event.x; startY = event.y; maxDistSq = 0;
            d.fx = d.x; d.fy = d.y;
        }
        function onDrag(event, d) {
            var ddx = event.x - startX, ddy = event.y - startY;
            var d2 = ddx * ddx + ddy * ddy;
            if (d2 > maxDistSq) maxDistSq = d2;
            d.fx = event.x; d.fy = event.y;
            if (simulation) simulation.alpha(1);
        }
        function onDragEnd(event, d) {
            d.fx = null; d.fy = null;
            if (maxDistSq < TAP_RADIUS_SQ && d && d.ticker) window.location.href = '/stock/' + d.ticker;
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
            var mcapSize = Math.max(7, Math.min(11, r * 0.26));
            // 충분히 큰 노드만 시총 라인 추가 (name 과 rate 사이)
            var has3 = r >= 30;
            var has2 = r >= 22;
            function line(cls, y, size, txt, opacity) {
                var t = sel.append('text').attr('class', cls)
                    .attr('x', 0).attr('y', y)
                    .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                    .attr('pointer-events', 'none')
                    .style('font-size', size + 'px').text(txt);
                if (opacity != null) t.style('opacity', opacity);
            }
            if (has3) {
                var gap3 = 1;
                var totalH3 = nameSize + mcapSize + rateSize + gap3 * 2;
                var top3 = -totalH3 / 2 + nameSize / 2;
                line('flow-node__name', top3, nameSize, name);
                line('flow-node__mcap', top3 + nameSize / 2 + gap3 + mcapSize / 2, mcapSize, formatMcap(d.market_cap), 0.78);
                line('flow-node__rate', top3 + nameSize / 2 + gap3 + mcapSize + gap3 + rateSize / 2, rateSize, formatRate(d.change_rate));
            } else if (has2) {
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

    function syncBodyState() {
        if (!document.body) return;
        document.body.setAttribute('data-flow-view', state.view);
        document.body.setAttribute('data-flow-mode', state.mode);
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
        // 라이브 숫자만 오버레이 — 섹터/테마(세부)는 loadDate 의 1시간 빌드 유지(getRankings 재호출 안 함).
        return WhyAPI.getLiveMarketmap().then(function (res) {
            if (!isLiveDate()) return;   // 느린 fetch 도중 과거 날짜로 이동했으면 오버레이/렌더 스킵(불일치 방지)
            var live = res.map;
            state.liveMap = live;        // activeItems 의 NXT 프리마켓 필터용(라이브 시세 보유 종목 판정)
            state.marketStatus = res.market_status || state.marketStatus;
            // 라벨 시각을 라이브 갱신 시각으로 — 빌드 collected_at 에 고정되던 버그 수정
            // (getLiveMarketmap 이 이미 KST 'YYYY-MM-DDTHH:MM:SS' 로 변환, slice(11,16) 호환)
            if (res.updated_at) state.collectedAt = res.updated_at;
            // 라이브 거래일이 빌드(어제)보다 새로우면 화면 날짜도 전진 — treemap/bubbles2 와 동일 패턴
            if (res.date && res.date.length === 8 && res.date > (state.currentDate || '')) {
                state.virtualDate = res.date;
                state.currentDate = res.date;
                if (state.availableDates.indexOf(res.date) < 0) state.availableDates.unshift(res.date);
                updateDateNav();
            }
            (state.rankings || []).forEach(function (r) {
                var lv = live[r.ticker];
                if (!lv) return;
                if (lv.change_rate != null) r.change_rate = lv.change_rate;
                if (lv.close_price != null) r.close_price = lv.close_price;
                if (lv.trading_value != null) r.trading_value = lv.trading_value;
                if (lv.market_cap != null) r.market_cap = lv.market_cap;   // 억원 그대로 (state.rankings 는 normalizeRanking 으로 이미 억원)
            });
            updateLastUpdated();
            render();   // lastNodes 에 prev x/y 있어 위치 유지
        }).catch(function () {});
    }

    // ring transition 시간 = setTimeout = fetch 정확 동기화 (chain pattern)
    var _wasOpen = false;       // 장중→마감 전이 감지 (확정 종가 1회 fetch)
    function liveCycle() {
        var clockOpen = isMarketOpen();
        // 08~09시 NXT 리드인은 서버가 아직 CLOSE 여도 라이브 재시도를 유지.
        // 그 이후 서버 market_status 는 휴장/공휴일 가드로 사용.
        // ''(미확인) 은 로컬 시계 신뢰 (첫 fetch 실패 시 폴링이 영구 정지하지 않도록).
        var statusClosed = clockOpen && state.marketStatus === 'CLOSE' && !isNxtLeadIn();
        var open = clockOpen && !statusClosed;
        if (!isLiveDate() || !open || document.visibilityState === 'hidden') {
            setLiveState(false);
            if (isLiveDate() && document.visibilityState !== 'hidden') {
                // 장중부터 열어둔 탭 — 마감 직후 1회 더 받아 동시호가 확정 종가 반영
                if (_wasOpen && !clockOpen) {
                    _wasOpen = false;
                    setTimeout(function () { refreshLive(); }, CLOSE_SETTLE_MS);
                }
                // 로컬 시계는 장중인데 서버가 CLOSE (공휴일 또는 일시 오판) — 5분 간격 재확인으로 자동 복구
                if (statusClosed) {
                    setTimeout(function () {
                        refreshLive().then(function () { liveCycle(); });
                    }, STATUS_RECHECK_MS);
                    return;
                }
            }
            setTimeout(liveCycle, IDLE_RECHECK_MS);
            return;
        }
        _wasOpen = true;
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
            if (date === state.virtualDate) state.virtualDate = '';   // 빌드 도착 — 정식 거래일
            return data;
        }).catch(function (err) {
            // 라이브 가상 날짜(오늘 빌드 미도착) — 직전 거래일 빌드를 베이스라인으로.
            // 라이브 오버레이(refreshLive)가 오늘 시세로 덮으므로 화면 날짜는 오늘 유지.
            if (date === state.virtualDate && state.availableDates[1]) {
                return WhyAPI.getRankings(state.availableDates[1]);
            }
            throw err;
        }).then(function (data) {
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
        syncBodyState();
        $modeTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-mode') === m);
        });
        render();
    }
    function setView(v) {
        if (state.view === v) return;
        state.view = v;
        lastNodes = [];
        syncBodyState();
        $viewTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-view') === v);
        });
        render();
    }
    function syncInitialControls() {
        syncBodyState();
        $viewTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-view') === state.view);
        });
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
    // SVG-as-image 는 웹폰트 로딩이 비결정적(레이스)이라 텍스트는 SVG 에서 빼고,
    // 페이지에 이미 로드된 폰트로 캔버스에 직접 그린다 — 폰트 적용 100% 보장.

    // 라이브 SVG 의 <text> 들을 캔버스 드로잉 스펙으로 수집 (화면 computed style 그대로)
    function collectTextSpecs(svgEl, offsetY, patch) {
        var specs = [];
        svgEl.querySelectorAll('text').forEach(function (el) {
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            var ctm = el.getCTM();
            if (!ctm) return;
            var x = parseFloat(el.getAttribute('x') || '0');
            var y = parseFloat(el.getAttribute('y') || '0');
            var det = Math.abs(ctm.a * ctm.d - ctm.b * ctm.c);
            var opacity = parseFloat(cs.opacity);
            var spec = {
                text: el.textContent,
                x: ctm.a * x + ctm.c * y + ctm.e,
                y: ctm.b * x + ctm.d * y + ctm.f + offsetY,
                size: (parseFloat(cs.fontSize) || 12) * Math.sqrt(det || 1),
                weight: cs.fontWeight || '600',
                fill: (cs.fill && cs.fill !== 'none') ? cs.fill : '#fff',
                opacity: isNaN(opacity) ? 1 : opacity,
                anchor: cs.textAnchor || 'start',
                baseline: cs.dominantBaseline || 'alphabetic',
                stroke: (cs.stroke && cs.stroke !== 'none') ? cs.stroke : null,
                strokeWidth: parseFloat(cs.strokeWidth) || 0,
                letterSpacing: cs.letterSpacing,
            };
            if (patch) patch(el, spec);
            specs.push(spec);
        });
        return specs;
    }

    function drawTextSpecs(ctx, specs, scale, fontStack) {
        specs.forEach(function (s) {
            ctx.save();
            ctx.globalAlpha = s.opacity == null ? 1 : s.opacity;
            ctx.font = (s.weight || '600') + ' ' + (s.size * scale) + 'px ' + fontStack;
            if (s.letterSpacing && s.letterSpacing !== 'normal' && 'letterSpacing' in ctx) {
                ctx.letterSpacing = ((parseFloat(s.letterSpacing) || 0) * scale) + 'px';
            }
            ctx.textAlign = s.anchor === 'middle' ? 'center' : (s.anchor === 'end' ? 'right' : 'left');
            ctx.textBaseline = (s.baseline === 'middle' || s.baseline === 'central') ? 'middle' : 'alphabetic';
            var px = s.x * scale, py = s.y * scale;
            if (s.stroke && s.strokeWidth > 0) {
                // SVG paint-order:stroke 와 동일 — 외곽선을 글자 뒤에 깐다
                ctx.lineWidth = s.strokeWidth * scale;
                ctx.lineJoin = 'round';
                ctx.strokeStyle = s.stroke;
                ctx.strokeText(s.text, px, py);
            }
            ctx.fillStyle = s.fill;
            ctx.fillText(s.text, px, py);
            ctx.restore();
        });
    }

    // 캡처 시점 표기 — 오늘 데이터를 보고 있으면 시:분까지 붙인다
    function captureDateTime() {
        var now = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var todayYmd = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate());
        var s = formatDate(state.currentDate);
        if (state.currentDate === todayYmd) s += ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
        return s;
    }

    function isFlowColorDark(c) {
        var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
        if (!m) return true;
        return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 140;
    }

    function savePNG() {
        var svgEl = $svg;
        var w = svgEl.clientWidth, h = svgEl.clientHeight;
        if (w < 80 || h < 80) return;
        // 헤더 워터마크는 페이지 테마, 차트 영역은 stage 실제 배경(트리뷰=밝음 / 버블뷰=다크)으로 분리
        var pageLight = document.documentElement.getAttribute('data-theme') === 'light';
        var chartBg = window.getComputedStyle(svgEl.parentNode).backgroundColor;
        if (!chartBg || chartBg === 'rgba(0, 0, 0, 0)' || chartBg === 'transparent') chartBg = pageLight ? '#F2F4F6' : '#191919';
        var chartDark = isFlowColorDark(chartBg);   // 차트 텍스트/도형 색 기준
        var isDark = !pageLight;   // 워터마크 헤더 색 기준(페이지 테마)
        var bgColor = pageLight ? '#ffffff' : chartBg;
        var fgColor = isDark ? '#ffffff' : '#191919';
        var fgDim = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(10,11,15,0.55)';
        var dividerColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
        var fontStack = '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Noto Sans KR", sans-serif';
        var ns = 'http://www.w3.org/2000/svg';

        // ── 헤더 워터마크 레이아웃 — 텍스트 폭을 재서 1줄/2줄 결정 ──
        var PAD_X = 20;
        var modeLabel = MODE_LABEL[state.mode] || state.mode;
        if (state.zoomedGroup) modeLabel += ' · ' + displayGroup(state.zoomedGroup);
        var ctxStr = modeLabel +'  ' + captureDateTime();
        var meas = document.createElement('canvas').getContext('2d');
        meas.font = '800 16px ' + fontStack;
        var logoW = meas.measureText('ORGO').width;
        meas.font = '600 12.5px ' + fontStack;
        var infoW = meas.measureText(ctxStr).width;
        meas.font = '600 13px ' + fontStack;
        var domainW = meas.measureText('orgo.kr').width;
        var oneLine = PAD_X + logoW + 10 + domainW + 32 + infoW + PAD_X <= w;
        var HEAD_H = oneLine ? 46 : 68;
        var totalH = h + HEAD_H;

        var wrap = document.createElementNS(ns, 'svg');
        wrap.setAttribute('xmlns', ns);
        wrap.setAttribute('width', String(w)); wrap.setAttribute('height', String(totalH));
        wrap.setAttribute('viewBox', '0 0 ' + w + ' ' + totalH);
        var bg = document.createElementNS(ns, 'rect');
        bg.setAttribute('width', String(w)); bg.setAttribute('height', String(totalH));
        bg.setAttribute('fill', bgColor);
        wrap.appendChild(bg);

        // 차트 영역(헤더 아래)은 stage 실제 배경(버블뷰는 다크) — 헤더(페이지 테마)와 분리
        var chartRect = document.createElementNS(ns, 'rect');
        chartRect.setAttribute('x', '0');
        chartRect.setAttribute('y', String(HEAD_H));
        chartRect.setAttribute('width', String(w));
        chartRect.setAttribute('height', String(h));
        chartRect.setAttribute('fill', chartBg);
        wrap.appendChild(chartRect);

        // 헤더 워터마크 — 좌: 로고+도메인, 우(좁으면 둘째 줄): 차트 정보. 캔버스로 그린다.
        var headerSpecs = [
            { text: 'ORGO', x: PAD_X, y: 28, size: 16, weight: '800', fill: fgColor, anchor: 'start' },
            { text: 'orgo.kr', x: PAD_X + logoW + 10, y: 28, size: 13, weight: '600', fill: fgDim, anchor: 'start' },
            oneLine
                ? { text: ctxStr, x: w - PAD_X, y: 28, size: 12.5, weight: '600', fill: fgColor, anchor: 'end' }
                : { text: ctxStr, x: PAD_X, y: 52, size: 12.5, weight: '600', fill: fgColor, anchor: 'start' }
        ];
        var divider = document.createElementNS(ns, 'line');
        divider.setAttribute('x1', '0');
        divider.setAttribute('x2', String(w));
        divider.setAttribute('y1', String(HEAD_H - 0.5));
        divider.setAttribute('y2', String(HEAD_H - 0.5));
        divider.setAttribute('stroke', dividerColor);
        divider.setAttribute('stroke-width', '1');
        wrap.appendChild(divider);

        var clone = svgEl.cloneNode(true);
        // 인라인 스타일 보강 (외부 CSS 가 PNG 에 안 묻음) — 도형만. 텍스트는 캔버스로.
        var sectorBoxFill = chartDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.035)';
        var sectorBoxStroke = chartDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.16)';
        var labelFill = chartDark ? 'rgba(255,255,255,0.92)' : 'rgba(20,22,28,0.92)';
        var cellStroke = chartDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.45)';

        clone.querySelectorAll('.tmap-sector__box').forEach(function (el) {
            el.setAttribute('fill', sectorBoxFill);
            el.setAttribute('stroke', sectorBoxStroke);
            el.setAttribute('stroke-width', '1');
        });
        clone.querySelectorAll('.flow-group__circle').forEach(function (el) {
            el.setAttribute('fill', 'none');
            el.setAttribute('stroke', sectorBoxStroke);
            el.setAttribute('stroke-width', '1');
            el.setAttribute('stroke-dasharray', '4 3');
        });
        // 그룹 큰 원 — JS 인라인 그라데이션이 fill 이미 적용. stroke 만 그레이 톤 유지.
        clone.querySelectorAll('.flow-group__bigcircle').forEach(function (el) {
            el.setAttribute('stroke', 'hsl(220, 8%, 64%)');
            el.setAttribute('stroke-width', '1');
        });
        clone.querySelectorAll('text').forEach(function (el) { el.parentNode.removeChild(el); });
        var textSpecs = headerSpecs.concat(collectTextSpecs(svgEl, HEAD_H, function (el, spec) {
            // 캡처 가독성 — 기존 캡처 스타일과 동일한 텍스트 외곽선/색 보정
            if (el.closest && (el.closest('.tmap-cell') || el.closest('.flow-node'))) {
                spec.fill = '#fff';
                spec.stroke = cellStroke;
                spec.strokeWidth = 0.6;
            }
            if (el.classList.contains('flow-group__name')) {
                spec.fill = '#fff';
                spec.stroke = cellStroke;
                spec.strokeWidth = 0.6;
            }
            if (el.classList.contains('tmap-sector__label') || el.classList.contains('flow-group__label')) {
                spec.fill = labelFill;
            }
            if (el.classList.contains('flow-group__count')) {
                spec.fill = 'rgba(255,255,255,0.85)';
            }
        }));

        var mapG = document.createElementNS(ns, 'g');
        mapG.setAttribute('transform', 'translate(0, ' + HEAD_H + ')');
        while (clone.firstChild) mapG.appendChild(clone.firstChild);
        wrap.appendChild(mapG);

        var svgStr = new XMLSerializer().serializeToString(wrap);
        var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
            var scale = 2;
            var canvas = document.createElement('canvas');
            canvas.width = w * scale; canvas.height = totalH * scale;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bgColor; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            drawTextSpecs(ctx, textSpecs, scale, fontStack);
            canvas.toBlob(function (b) {
                if (!b) return;
                var dl = URL.createObjectURL(b);
                var a = document.createElement('a');
                var stamp = (state.currentDate || '').replace(/[^0-9]/g, '');
                a.href = dl; a.download = 'orgo-flowmap-' + stamp + '-' + state.mode + '-' + state.view + '.png';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                URL.revokeObjectURL(dl);
            }, 'image/png');
        };
        img.onerror = function () { URL.revokeObjectURL(url); };
        img.src = url;
    }

    function exposeBridge() {
        window.WhyRiseTmapBridge = {
            kind: 'flow',
            getDates: function () { return state.availableDates.slice(); },
            getCurrentDate: function () { return state.currentDate; },
            getDateIndex: function () { return state.dateIndex; },
            gotoDate: function (date) {
                var idx = state.availableDates.indexOf(date);
                if (idx >= 0) gotoDateIndex(idx);
            },
            prevDate: function () { gotoDateIndex(state.dateIndex + 1); },
            nextDate: function () { gotoDateIndex(state.dateIndex - 1); },
            setMode: setMode,
            setView: setView,
            reset: function () {
                state.zoomedGroup = null;
                lastNodes = [];
                updateBackBtn();
                render();
            },
            save: savePNG,
            getChrome: function () {
                return {
                    dateText: $date ? $date.textContent : '',
                    liveText: $liveLabel ? $liveLabel.textContent : '',
                    liveIdle: $live ? $live.classList.contains('tmap-live--idle') : true,
                    prevDisabled: $datePrev ? !!$datePrev.disabled : false,
                    nextDisabled: $dateNext ? !!$dateNext.disabled : false,
                    backVisible: $back ? $back.style.display !== 'none' : false,
                    loadingVisible: $loading ? $loading.style.display !== 'none' : false,
                    ringDashoffset: $ringFg ? $ringFg.style.strokeDashoffset : '',
                    ringTransition: $ringFg ? $ringFg.style.transition : '',
                };
            },
        };
    }

    // ── 초기화 ─────────────────────────────────────────
    function init() {
        exposeBridge();
        bindThemeToggle();
        syncInitialControls();
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
                // 탭 복귀 시 즉시 1회 갱신 — idle 체크 + 30초 폴링 주기를 기다리지 않음
                if (isLiveDate()) refreshLive();
            } else {
                if (simulation) simulation.stop();
            }
        });

        // 시계 element 제거 — LIVE 라벨의 마지막 업데이트 시각만 표시

        loadDates().then(function () {
            // 로드 직후 즉시 라이브 1회 — 장중엔 첫 화면부터 라이브 숫자,
            // 마감 후엔 '실제 종가' 확보 (treemap/bubbles2 의 init 1회 fetch 와 동작 통일)
            refreshLive();
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
