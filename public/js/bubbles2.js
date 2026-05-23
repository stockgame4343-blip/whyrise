/**
 * 버블맵2 — 한국 시총 TOP 100 KOSPI + 100 KOSDAQ.
 *
 * 트리맵과 동일한 데이터·컨트롤·라이브 polling·날짜 네비·PNG 저장 구조.
 * 표현 방식만 d3.forceSimulation 기반 떠다니는 원형 버블 (cryptobubbles.net 스타일).
 *
 * 면적 = market_cap (sqrt 스케일 → 반지름)
 * 색 = 등락률 (HSL 그라데이션, 상승 빨강·하락 파랑)
 * 클릭 = /stock/{ticker}
 */
(function () {
    'use strict';

    var POLL_MS = 15000;
    var KST_OFFSET = 9 * 60;
    var OPEN_MIN = 9 * 60;
    var CLOSE_MIN = 15 * 60 + 30;
    var RING_CIRCUM = 2 * Math.PI * 9;

    var SEMI_LEAD_GROUP = '반도체';
    var SEMI_LEAD_TICKERS = { '005930': true, '005935': true, '000660': true };
    // 차단 종목 — 모든 페이지에서 가려짐
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    // 시총 1·2위 (삼성전자·SK하이닉스) 면적 80% 로 축소 — 시각 균형 (시총 모드 한정)
    var SIZE_SCALE_TICKERS = { '005930': 0.8, '000660': 0.8 };
    // 1d 상승률 면적 캡 — 한국 일일 상한 +30%. 신규상장만 +100/+300% (왜곡) → 캡 +30%×1.3.
    // 1주/1달/3달/1년 누적은 +100%+ 도 정상이라 캡 적용 X.
    var CHANGE_SIZE_THRESHOLD = 30;
    var CHANGE_SIZE_CAP_SCORE = 30 * 30 * 1.3;   // = 1170
    function sizeOf(it, sort) {
        if (sort === 'change') {
            var r = it.change_rate;
            if (r == null || isNaN(r) || r <= 0) return 1;
            if (state.period === '1d' && r > CHANGE_SIZE_THRESHOLD) return CHANGE_SIZE_CAP_SCORE;
            return r * r;
        }
        var v = sortScore(it, sort);
        if (sort === 'mcap') {
            var s = SIZE_SCALE_TICKERS[it.ticker];
            if (s) v = v * s;
        }
        return Math.max(v, 1);
    }

    var PERIOD_LABEL = { '1d': '1일', '1w': '1주', '1m': '1달', '3m': '3달', '1y': '1년' };
    var SORT_LABEL = { mcap: '시총', volume: '거래량', change: '상승률' };

    // 정렬용 score — 양수 큰 순. 사이즈 차별 위해 제곱. 정렬은 캡 적용 X (큰 순 정확).
    function sortScore(it, sort) {
        if (sort === 'volume') return it.trading_value || 0;
        if (sort === 'change') {
            var r = it.change_rate;
            if (r == null || isNaN(r)) return -Infinity;
            return r > 0 ? r * r : r;
        }
        return it.market_cap || 0;
    }

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
    function displaySector(name) {
        if (!name) return '기타';
        return SECTOR_FORMAT[name] || name;
    }

    var $stage = document.getElementById('tmapStage');
    var $svg = document.getElementById('tmapSvg');
    var $loading = document.getElementById('tmapLoading');
    var $message = document.getElementById('tmapMessage');
    var $clock = document.getElementById('tmapClock');
    var $date = document.getElementById('tmapDate');
    var $live = document.getElementById('tmapLive');
    var $liveLabel = document.getElementById('tmapLiveLabel');
    var $ringFg = document.querySelector('.tmap-live__ring-fg');
    var $marketTabs = document.querySelectorAll('.tmap-tabs--market .tmap-tab');
    var $periodTabs = document.querySelectorAll('.tmap-tabs--period .tmap-tab');
    var $sortTabs = document.querySelectorAll('.tmap-tabs--sort .tmap-tab');
    var $save = document.getElementById('tmapSave');
    var $datePrev = document.getElementById('tmapDatePrev');
    var $dateNext = document.getElementById('tmapDateNext');

    var state = {
        liveItems: [],
        snapshotItems: [],
        sectorMap: {},
        filter: 'ALL',
        period: '1d',
        sort: 'mcap',
        availableDates: [],
        dateIndex: 0,
        currentDate: '',
        marketStatus: 'CLOSE',
    };

    var simulation = null;
    var lastNodes = [];      // 이전 render 의 노드 — 같은 ticker 위치/속도 유지

    // ── 시간 / 포맷 ────────────────────────────────────
    function kstNow() {
        return new Date(Date.now() + KST_OFFSET * 60000);
    }
    function isMarketOpen() {
        var k = kstNow();
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }
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
    function formatMcap(v) {
        if (!v) return '-';
        if (v >= 100 * 10000) return Math.round(v / 10000).toLocaleString() + '조';
        if (v >= 10000) return (v / 10000).toFixed(1) + '조';
        return Math.round(v).toLocaleString() + '억';
    }
    // 거래대금 (원 단위) — 조/억/만 으로 압축
    function formatTradingValue(v) {
        if (!v || v <= 0) return '-';
        if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
        if (v >= 1e8) return Math.round(v / 1e8).toLocaleString() + '억';
        if (v >= 1e4) return Math.round(v / 1e4).toLocaleString() + '만';
        return Math.round(v).toLocaleString();
    }

    // 외곽 색 (alpha 없는 hsl). stop-opacity 로 그라데이션 알파 조절.
    function edgeColorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) {
            return 'hsl(220, 6%, 58%)';
        }
        var r = Math.max(-5, Math.min(5, rate));
        var t = Math.abs(r) / 5;
        if (r > 0) {
            return 'hsl(0, ' + (80 + t * 12) + '%, ' + (54 + t * 6) + '%)';
        }
        return 'hsl(220, ' + (70 + t * 12) + '%, ' + (52 - t * 4) + '%)';
    }
    function colorFor(rate) { return edgeColorFor(rate); }

    // ── 데이터 ────────────────────────────────────────
    function isLiveDate() { return state.dateIndex === 0; }

    function activeItems() {
        var useLive = isLiveDate() && state.period === '1d' && state.liveItems.length;
        var base = useLive ? state.liveItems : state.snapshotItems;
        return base.map(function (it) {
            var copy = Object.assign({}, it);
            if (!copy.sector) copy.sector = state.sectorMap[copy.ticker] || '';
            if (SEMI_LEAD_TICKERS[copy.ticker]) copy.sector = SEMI_LEAD_GROUP;
            if (state.period !== '1d') {
                var rates = copy.rates || null;
                if (!rates) {
                    var snap = state.snapshotItems.find(function (s) { return s.ticker === copy.ticker; });
                    rates = snap && snap.rates ? snap.rates : null;
                }
                if (rates && rates[state.period] != null) copy.change_rate = rates[state.period];
                else copy.change_rate = null;
            }
            return copy;
        });
    }
    function visibleItems() {
        var items = activeItems().filter(function (it) { return !BLOCKED_TICKERS[it.ticker]; });
        if (state.filter === 'KOSPI' || state.filter === 'KOSDAQ') {
            items = items.filter(function (it) { return it.market === state.filter; });
        }
        var sort = state.sort;
        // 상승률 모드: 음수(하락) 종목은 제외 — "상승률" 라벨 의미에 맞춤
        if (sort === 'change') {
            items = items.filter(function (it) {
                var r = it.change_rate;
                return r != null && !isNaN(r) && r > 0;
            });
        }
        items.sort(function (a, b) { return sortScore(b, sort) - sortScore(a, sort); });
        return items.slice(0, 100);
    }

    // ── 버블 렌더 ──────────────────────────────────────
    function render() {
        var items = visibleItems();
        var w = $stage.clientWidth;
        var h = $stage.clientHeight;
        if (w < 80 || h < 80) return;

        if (!items.length) {
            $svg.innerHTML = '';
            $message.style.display = '';
            $message.textContent = '표시할 종목이 없습니다.';
            return;
        }
        $message.style.display = 'none';

        // 반지름 — 모든 버블의 면적 합이 화면 면적의 fill_ratio 만큼 차도록 스케일 산출.
        // sizeOf() 는 정렬 기준에 따라 시총·거래대금·|등락률| 사용
        var sortKey = state.sort;
        var totalSize = 0;
        items.forEach(function (d) { totalSize += sizeOf(d, sortKey); });
        var fillRatio = 0.67;                    // 5% 축소 — 더 여유롭게 둥둥
        var rMax = Math.min(w, h) * 0.22;
        var rMin = Math.max(10, Math.min(w, h) * 0.022);
        var k = totalSize > 0
            ? Math.sqrt((w * h * fillRatio) / (Math.PI * totalSize))
            : Math.min(w, h) * 0.05;

        // 같은 ticker 의 이전 위치·속도 유지 — 갱신 시 자연 transition
        var prev = {};
        lastNodes.forEach(function (n) { prev[n.ticker] = n; });

        // 초기 위치: 화면 전체에 균등 random — 중앙 편향 없음
        var nodes = items.map(function (d, i) {
            var r = Math.max(rMin, Math.min(rMax, k * Math.sqrt(sizeOf(d, sortKey))));
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

        var svg = d3.select($svg)
            .attr('width', w)
            .attr('height', h)
            .attr('viewBox', '0 0 ' + w + ' ' + h);
        svg.selectAll('*').remove();

        // 외곽 → 투명 그라데이션 — 안쪽 거의 투명, 외곽 가장자리만 색
        var defs = svg.append('defs');
        nodes.forEach(function (d, i) {
            var gid = 'bmap2-g-' + i;
            d._gradId = gid;
            var edge = edgeColorFor(d.change_rate);
            var grad = defs.append('radialGradient')
                .attr('id', gid)
                .attr('cx', '50%').attr('cy', '50%').attr('r', '50%');
            grad.append('stop').attr('offset', '0%').attr('stop-color', edge).attr('stop-opacity', 0);
            grad.append('stop').attr('offset', '45%').attr('stop-color', edge).attr('stop-opacity', 0);
            grad.append('stop').attr('offset', '78%').attr('stop-color', edge).attr('stop-opacity', 0.18);
            grad.append('stop').attr('offset', '95%').attr('stop-color', edge).attr('stop-opacity', 0.55);
            grad.append('stop').attr('offset', '100%').attr('stop-color', edge).attr('stop-opacity', 0.85);
        });

        // 클릭(작은 이동) vs 드래그(큰 이동) 구분용
        var dragMoved = 0;
        function onDragStart(event, d) {
            dragMoved = 0;
            d.fx = d.x; d.fy = d.y;
        }
        function onDrag(event, d) {
            dragMoved += Math.abs(event.dx) + Math.abs(event.dy);
            d.fx = event.x; d.fy = event.y;
            if (simulation) simulation.alpha(1);   // 흔들리면 시뮬레이션 깨움
        }
        function onDragEnd(event, d) {
            d.fx = null; d.fy = null;
            if (dragMoved < 4 && d && d.ticker) {
                window.location.href = '/stock/' + d.ticker;
            }
        }

        var node = svg.selectAll('g.bmap2-node')
            .data(nodes, function (d) { return d.ticker; })
            .enter()
            .append('g')
            .attr('class', 'bmap2-node')
            .style('cursor', 'pointer')
            .call(d3.drag()
                .on('start', onDragStart)
                .on('drag', onDrag)
                .on('end', onDragEnd));

        // 글래스 외곽 그라데이션 원
        node.append('circle')
            .attr('class', 'bmap2-node__circle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return 'url(#' + d._gradId + ')'; })
            .attr('stroke', function (d) { return edgeColorFor(d.change_rate); })
            .attr('stroke-width', 1)
            .attr('stroke-opacity', 0.45);

        var showVolume = state.sort === 'volume';
        node.each(function (d) {
            var g = d3.select(this);
            var r = d.r;
            if (r < 12) return;     // 너무 작은 버블은 텍스트 생략
            var nameSize = Math.max(8, Math.min(18, r * 0.42));
            var rateSize = Math.max(7, Math.min(14, r * 0.32));
            var mcapSize = Math.max(7, Math.min(12, r * 0.28));
            var volSize = Math.max(7, Math.min(11, r * 0.26));

            var name = d.name || '';
            var maxChars = Math.max(2, Math.floor(r * 1.8 / nameSize));
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';

            // 4줄(name/mcap/rate/volume) 은 충분히 큰 버블만, 그 외엔 기존 3·2·1 줄
            var has4 = showVolume && r >= 46;
            var has3 = r >= 38;
            var has2 = r >= 22;

            function line(cls, y, size, txt, opacity) {
                var t = g.append('text')
                    .attr('class', cls)
                    .attr('x', 0)
                    .attr('y', y)
                    .attr('text-anchor', 'middle')
                    .attr('dominant-baseline', 'middle')
                    .attr('pointer-events', 'none')
                    .style('font-size', size + 'px')
                    .text(txt);
                if (opacity != null) t.style('opacity', opacity);
                return t;
            }

            if (has4) {
                // name, mcap, rate, volume — 가운데 정렬을 4줄 합 기준으로
                var gap4 = 1;
                var totalH4 = nameSize + mcapSize + rateSize + volSize + gap4 * 3;
                var top4 = -totalH4 / 2 + nameSize / 2;
                line('bmap2-node__name', top4, nameSize, name);
                line('bmap2-node__mcap', top4 + nameSize / 2 + gap4 + mcapSize / 2, mcapSize, formatMcap(d.market_cap), 0.78);
                line('bmap2-node__rate', top4 + nameSize / 2 + gap4 + mcapSize + gap4 + rateSize / 2, rateSize, formatRate(d.change_rate));
                line('bmap2-node__vol', top4 + nameSize / 2 + gap4 + mcapSize + gap4 + rateSize + gap4 + volSize / 2, volSize, formatTradingValue(d.trading_value), 0.7);
            } else if (has3) {
                var gap = 1;
                line('bmap2-node__name', -mcapSize / 2 - gap - rateSize / 2, nameSize, name);
                line('bmap2-node__mcap', 0, mcapSize, formatMcap(d.market_cap), 0.78);
                line('bmap2-node__rate', mcapSize / 2 + gap + rateSize / 2, rateSize, formatRate(d.change_rate));
            } else if (has2) {
                line('bmap2-node__name', -rateSize / 2 - 1, nameSize, name);
                line('bmap2-node__rate', nameSize / 2 + 1, rateSize, formatRate(d.change_rate));
            } else {
                line('bmap2-node__name', 0, nameSize, name);
            }
        });

        node.append('title').text(function (d) {
            return d.name + ' (' + d.ticker + ')\n'
                + d.market + (d.sector ? ' · ' + displaySector(d.sector) : '') + '\n'
                + '시총: ' + formatMcap(d.market_cap) + '\n'
                + (PERIOD_LABEL[state.period] || state.period) + ' ' + formatRate(d.change_rate);
        });

        // 끊임없이 둥둥 떠다니는 force simulation
        //  - alphaDecay 0: 영원히 안 멈춤
        //  - velocityDecay 0.16: 가벼운 마찰
        //  - charge: 노드끼리 강한 반발 (가까운 노드만) → 화면 전체 외곽 분산
        //  - collide: 겹침 방지 + 빽빽한 패킹
        //  - drift: 매 tick 약한 random velocity → 살랑살랑 부유
        //  - center force 없음 (가운데로 모이지 않음)
        if (simulation) simulation.stop();
        var DRIFT = 0.11;                        // 둥둥 강화 (0.06 → 0.11)
        function driftForce() {
            for (var i = 0; i < nodes.length; i++) {
                nodes[i].vx += (Math.random() - 0.5) * DRIFT;
                nodes[i].vy += (Math.random() - 0.5) * DRIFT;
            }
        }
        simulation = d3.forceSimulation(nodes)
            .alpha(1)
            .alphaMin(0)
            .alphaDecay(0)
            .velocityDecay(0.13)                 // 마찰 살짝 줄여 흐름 더 부드럽게
            // 가까운 노드끼리만 반발 — 화면 전체로 자연 분산
            .force('charge', d3.forceManyBody()
                .strength(-12)
                .distanceMax(120))
            .force('collide', d3.forceCollide()
                .radius(function (d) { return d.r + 3; })
                .strength(1.0)
                .iterations(4))
            .force('drift', driftForce)
            .on('tick', function () {
                node.attr('transform', function (d) {
                    var pad = d.r;
                    if (d.x < pad) { d.x = pad; d.vx = Math.abs(d.vx) * 0.6; }
                    if (d.x > w - pad) { d.x = w - pad; d.vx = -Math.abs(d.vx) * 0.6; }
                    if (d.y < pad) { d.y = pad; d.vy = Math.abs(d.vy) * 0.6; }
                    if (d.y > h - pad) { d.y = h - pad; d.vy = -Math.abs(d.vy) * 0.6; }
                    return 'translate(' + d.x + ',' + d.y + ')';
                });
            });
    }

    function updateDateNav() {
        var n = state.availableDates.length;
        var i = state.dateIndex;
        if ($datePrev) $datePrev.disabled = i >= n - 1;
        if ($dateNext) $dateNext.disabled = i <= 0;
        $date.textContent = formatDate(state.currentDate);
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
        if (open) {
            $live.classList.remove('tmap-live--idle');
            $liveLabel.textContent = 'LIVE';
        } else {
            $live.classList.add('tmap-live--idle');
            $liveLabel.textContent = '장 마감';
            stopRingFill();
        }
        updateLastUpdated();
    }
    function updateLastUpdated() {
        if (!$liveLabel) return;
        var iso = state.lastUpdated || '';
        if (!iso) return;
        // 라이브 API 의 updated_at = UTC ISO. KST(+9h) 로 변환
        try {
            var d = new Date(iso);
            if (isNaN(d.getTime())) return;
            var k = new Date(d.getTime() + 9 * 3600000);
            var hh = ('0' + k.getUTCHours()).slice(-2);
            var mm = ('0' + k.getUTCMinutes()).slice(-2);
            var prefix = $liveLabel.textContent.indexOf('LIVE') === 0 ? 'LIVE' : '장 마감';
            $liveLabel.textContent = prefix + ' · ' + hh + ':' + mm;
        } catch (e) {}
    }

    // ── fetch ──────────────────────────────────────────
    function fetchLive() {
        return fetch('/api/marketmap', { cache: 'no-cache' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                if (!data || !data.items || !data.items.length) throw new Error('empty');
                state.liveItems = data.items;
                state.marketStatus = data.market_status || state.marketStatus;
                state.lastUpdated = data.updated_at || state.lastUpdated;
                // 라이브 date 가 정적(어제) 보다 새로우면 우선 — 장 시작 후 어제 날짜 보이는 어색함 제거
                if (state.dateIndex === 0 && data.date && data.date > (state.currentDate || '')) {
                    state.currentDate = data.date;
                    if (state.availableDates && state.availableDates.indexOf(data.date) < 0) {
                        state.availableDates.unshift(data.date);
                    }
                    updateDateNav();
                }
                updateLastUpdated();
                $loading.style.display = 'none';
                if (state.dateIndex === 0 && state.period === '1d') render();
            });
    }
    // 라이브 대기 중 정적 데이터 render 안 함 (어제 가격 잠깐 보이는 혼란 방지)
    // 5s 후엔 라이브가 실패한 것으로 보고 정적으로 fallback
    var _liveTimeout = false;
    function isWaitingLive() {
        return isMarketOpen() && state.period === '1d' && state.dateIndex === 0
            && !state.liveItems.length && !_liveTimeout;
    }
    function fetchSnapshot(dateStr) {
        var url = dateStr ? ('/data/marketmap/' + dateStr + '.json') : '/data/marketmap.json';
        return fetch(url, { cache: 'no-cache' })
            .then(function (r) { if (!r.ok) throw new Error('스냅샷 없음'); return r.json(); })
            .then(function (data) {
                var items = (data && data.items) || [];
                items.forEach(function (it) {
                    if (it.ticker && it.sector) state.sectorMap[it.ticker] = it.sector;
                });
                state.snapshotItems = items;
                state.currentDate = (data && data.date) || dateStr || '';
                // 정적 marketmap.json 도 updated_at 가짐 — LIVE 옆 시각 채우기
                if (data && data.updated_at && !state.lastUpdated) {
                    state.lastUpdated = data.updated_at;
                    updateLastUpdated();
                }
                updateDateNav();
                if (isWaitingLive()) return;   // 라이브 도착 대기 중이면 render 보류
                $loading.style.display = 'none';
                if (items.length) render();
            });
    }
    function fetchDateIndex() {
        return fetch('/data/marketmap/index.json', { cache: 'no-cache' })
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (dates) {
                state.availableDates = Array.isArray(dates) ? dates : [];
                if (!state.availableDates.length && state.currentDate) {
                    state.availableDates = [state.currentDate];
                }
                updateDateNav();
            })
            .catch(function () {});
    }

    // 라이브 사이클 — ring transition 시간 = setTimeout = 다음 fetch 까지의 시간 (정확 동기화).
    // setInterval 의 drift 가 없도록 chain pattern. fetch 끝나면 다음 cycle 시작.
    var _cycleRunning = false;
    function liveCycle() {
        _cycleRunning = false;
        updateDateNav();
        var open = isMarketOpen();
        var live = isLiveDate() && state.period === '1d';
        if (!(live && open) || document.visibilityState === 'hidden') {
            setLiveState(false);
            // 라이브 조건 아닐 때는 5s 후 다시 체크 (장 시작/탭 복귀 감지)
            _cycleRunning = true;
            setTimeout(liveCycle, 5000);
            return;
        }
        setLiveState(true);
        startRingFill();
        _cycleRunning = true;
        setTimeout(function () {
            fetchLive().catch(function () {}).then(function () { liveCycle(); });
        }, POLL_MS);
    }

    function setFilter(f) {
        if (state.filter === f) return;
        state.filter = f;
        $marketTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-filter') === f);
        });
        render();
    }
    function setPeriod(p) {
        if (state.period === p) return;
        state.period = p;
        $periodTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-period') === p);
        });
        setLiveState(p === '1d' && isLiveDate() && isMarketOpen());
        render();
    }
    function setSort(s) {
        if (state.sort === s) return;
        state.sort = s;
        $sortTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-sort') === s);
        });
        // 정렬 바뀌면 면적 스케일이 완전 달라지므로 lastNodes 무효화 (위치 재배치)
        lastNodes = [];
        render();
    }
    function gotoDateIndex(idx) {
        if (idx < 0 || idx >= state.availableDates.length) return;
        state.dateIndex = idx;
        var d = state.availableDates[idx];
        if (idx === 0) fetchSnapshot('');
        else fetchSnapshot(d);
        setLiveState(idx === 0 && state.period === '1d' && isMarketOpen());
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
        var w = svgEl.clientWidth;
        var h = svgEl.clientHeight;
        if (w < 80 || h < 80) return;
        var HEAD_H = 44;
        var totalH = h + HEAD_H;
        var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
        var bgColor = isDark ? '#0a0b0f' : '#ffffff';
        var fgColor = isDark ? '#ffffff' : '#0a0b0f';
        var fgDim = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(10,11,15,0.55)';
        var cellTextStrokeColor = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.45)';
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
        wrap.setAttribute('width', String(w));
        wrap.setAttribute('height', String(totalH));
        wrap.setAttribute('viewBox', '0 0 ' + w + ' ' + totalH);

        var bg = document.createElementNS(ns, 'rect');
        bg.setAttribute('width', String(w));
        bg.setAttribute('height', String(totalH));
        bg.setAttribute('fill', bgColor);
        wrap.appendChild(bg);

        wrap.appendChild(mkText(20, HEAD_H - 16, '이거왜오름?', { size: 16, weight: 800, fill: fgColor }));
        wrap.appendChild(mkText(132, HEAD_H - 16, 'whyrise.vercel.app', { size: 11, weight: 600, fill: fgDim }));
        var modeText = state.filter === 'ALL' ? '전체' : (state.filter === 'KOSPI' ? '코스피' : '코스닥');
        var sortText = SORT_LABEL[state.sort] || '시총';
        var ctxStr = (PERIOD_LABEL[state.period] || state.period) + ' · ' + modeText + ' · ' + sortText + '   ·   ' + formatDate(state.currentDate);
        wrap.appendChild(mkText(w - 20, HEAD_H - 16, ctxStr, { size: 13, weight: 700, fill: fgColor, anchor: 'end' }));

        var clone = svgEl.cloneNode(true);
        // 텍스트 fill / stroke 인라인
        clone.querySelectorAll('.bmap2-node text').forEach(function (el) {
            el.setAttribute('fill', '#fff');
            el.setAttribute('font-family', fontStack);
            el.setAttribute('paint-order', 'stroke');
            el.setAttribute('stroke', cellTextStrokeColor);
            el.setAttribute('stroke-width', '0.6');
            el.setAttribute('pointer-events', 'none');
        });
        clone.querySelectorAll('.bmap2-node__name').forEach(function (el) { el.setAttribute('font-weight', '700'); });
        clone.querySelectorAll('.bmap2-node__mcap').forEach(function (el) {
            el.setAttribute('font-weight', '500');
            el.setAttribute('opacity', '0.78');
        });
        clone.querySelectorAll('.bmap2-node__rate').forEach(function (el) { el.setAttribute('font-weight', '600'); });
        clone.querySelectorAll('.bmap2-node__vol').forEach(function (el) {
            el.setAttribute('font-weight', '500');
            el.setAttribute('opacity', '0.7');
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
            canvas.width = w * 2;
            canvas.height = totalH * 2;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            canvas.toBlob(function (b) {
                if (!b) return;
                var dl = URL.createObjectURL(b);
                var a = document.createElement('a');
                var stamp = (state.currentDate || '').replace(/[^0-9]/g, '') || 'live';
                var fname = 'whyrise-bubblemap2-' + stamp + '-' + state.filter.toLowerCase() + '-' + state.period + '-' + state.sort + '.png';
                a.href = dl; a.download = fname;
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                URL.revokeObjectURL(dl);
            }, 'image/png');
        };
        img.onerror = function () { URL.revokeObjectURL(url); };
        img.src = url;
    }

    function exposeBridge() {
        window.WhyRiseTmapBridge = {
            kind: 'bubble',
            getDates: function () { return state.availableDates.slice(); },
            getCurrentDate: function () { return state.currentDate; },
            getDateIndex: function () { return state.dateIndex; },
            gotoDate: function (date) {
                var idx = state.availableDates.indexOf(date);
                if (idx >= 0) gotoDateIndex(idx);
            },
            prevDate: function () { gotoDateIndex(state.dateIndex + 1); },
            nextDate: function () { gotoDateIndex(state.dateIndex - 1); },
            setFilter: setFilter,
            setPeriod: setPeriod,
            setSort: setSort,
            reset: function () {},
            save: savePNG,
            getChrome: function () {
                return {
                    dateText: $date ? $date.textContent : '',
                    liveText: $liveLabel ? $liveLabel.textContent : '',
                    liveIdle: $live ? $live.classList.contains('tmap-live--idle') : true,
                    prevDisabled: $datePrev ? !!$datePrev.disabled : false,
                    nextDisabled: $dateNext ? !!$dateNext.disabled : false,
                    backVisible: false,
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
        $marketTabs.forEach(function (b) {
            b.addEventListener('click', function () { setFilter(b.getAttribute('data-filter')); });
        });
        $periodTabs.forEach(function (b) {
            b.addEventListener('click', function () { setPeriod(b.getAttribute('data-period')); });
        });
        $sortTabs.forEach(function (b) {
            b.addEventListener('click', function () { setSort(b.getAttribute('data-sort')); });
        });
        if ($save) $save.addEventListener('click', savePNG);
        if ($datePrev) $datePrev.addEventListener('click', function () { gotoDateIndex(state.dateIndex + 1); });
        if ($dateNext) $dateNext.addEventListener('click', function () { gotoDateIndex(state.dateIndex - 1); });
        if ($date) $date.addEventListener('click', openDatePicker);

        // 시계 element 제거 — LIVE 라벨의 마지막 업데이트 시각만 표시

        // 5s 안에 라이브 도착 안 하면 정적 데이터로 fallback render
        setTimeout(function () {
            if (state.liveItems.length || _liveTimeout) return;
            _liveTimeout = true;
            if (state.snapshotItems.length) {
                $loading.style.display = 'none';
                render();
            }
        }, 5000);

        fetchSnapshot('')
            .then(fetchDateIndex)
            .then(function () {
                if (isMarketOpen() && state.period === '1d' && state.dateIndex === 0) {
                    return fetchLive().catch(function () {});
                }
            })
            .then(function () { liveCycle(); })   // chain pattern 시작
            .catch(function (err) {
                $loading.style.display = 'none';
                $message.style.display = '';
                $message.textContent = '데이터를 불러올 수 없습니다 — ' + (err && err.message ? err.message : err);
            });

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                if (simulation) simulation.alpha(1).restart();
            } else {
                if (simulation) simulation.stop();
            }
        });

        var rt;
        window.addEventListener('resize', function () {
            clearTimeout(rt);
            rt = setTimeout(render, 200);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
