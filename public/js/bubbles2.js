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

    var PERIOD_LABEL = { '1d': '1일', '1w': '1주', '1m': '1달', '3m': '3달', '1y': '1년' };

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
    var $save = document.getElementById('tmapSave');
    var $datePrev = document.getElementById('tmapDatePrev');
    var $dateNext = document.getElementById('tmapDateNext');

    var state = {
        liveItems: [],
        snapshotItems: [],
        sectorMap: {},
        filter: 'ALL',
        period: '1d',
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

    // 글래스 톤 — 반투명 단색 (radial gradient 없이 flat). 강도에 따라 alpha·L 변화.
    function colorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) {
            return 'hsla(220, 6%, 48%, 0.55)';
        }
        var r = Math.max(-5, Math.min(5, rate));
        var t = Math.abs(r) / 5;
        var a = 0.55 + t * 0.30;            // 활발할수록 진함
        if (r > 0) {
            return 'hsla(0, ' + (72 + t * 18) + '%, ' + (50 + t * 8) + '%, ' + a + ')';
        }
        return 'hsla(220, ' + (62 + t * 18) + '%, ' + (48 - t * 8) + '%, ' + a + ')';
    }

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
        var items = activeItems();
        if (state.filter === 'KOSPI' || state.filter === 'KOSDAQ') {
            return items.filter(function (it) { return it.market === state.filter; });
        }
        return items;
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
        // (sum(π r²) = w*h*fill ⇒ r = k·√mc, k = √(w*h*fill / (π·Σmc)))
        var totalMcap = 0;
        items.forEach(function (d) { totalMcap += (d.market_cap || 0); });
        var fillRatio = 0.62;                    // 화면의 62% 면적 점유 — 빽빽
        var rMax = Math.min(w, h) * 0.20;        // 단변의 20% 상한
        var rMin = Math.max(10, Math.min(w, h) * 0.015);
        var k = totalMcap > 0
            ? Math.sqrt((w * h * fillRatio) / (Math.PI * totalMcap))
            : Math.min(w, h) * 0.05;

        // 같은 ticker 의 이전 위치·속도 유지 — 갱신 시 자연 transition
        var prev = {};
        lastNodes.forEach(function (n) { prev[n.ticker] = n; });

        // 각 노드에 외곽 target (random) 부여 — center 가 아닌 화면 전반 분산
        var nodes = items.map(function (d, i) {
            var r = Math.max(rMin, Math.min(rMax, k * Math.sqrt(d.market_cap || 1)));
            var p = prev[d.ticker];
            // random 자리 — 화면 전체에 균등 분포
            var angle = (i * 137.5) * Math.PI / 180;   // 황금각 분산
            var radius = Math.sqrt((i + 0.5) / items.length) * Math.min(w, h) * 0.48;
            var tx = w / 2 + Math.cos(angle) * radius;
            var ty = h / 2 + Math.sin(angle) * radius;
            return Object.assign({}, d, {
                r: r,
                targetX: tx,
                targetY: ty,
                x: p ? p.x : tx,
                y: p ? p.y : ty,
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

        var node = svg.selectAll('g.bmap2-node')
            .data(nodes, function (d) { return d.ticker; })
            .enter()
            .append('g')
            .attr('class', 'bmap2-node')
            .style('cursor', 'pointer')
            .on('click', function (e, d) {
                if (d && d.ticker) window.location.href = '/stock/' + d.ticker;
            });

        // 평평한 글래스 원 — radial gradient 제거, 단색 + 살짝 stroke
        node.append('circle')
            .attr('class', 'bmap2-node__circle')
            .attr('r', function (d) { return d.r; })
            .attr('fill', function (d) { return colorFor(d.change_rate); })
            .attr('stroke', 'rgba(255,255,255,0.28)')
            .attr('stroke-width', 1);

        node.each(function (d) {
            var g = d3.select(this);
            var r = d.r;
            if (r < 12) return;     // 너무 작은 버블은 텍스트 생략
            var nameSize = Math.max(8, Math.min(18, r * 0.42));
            var rateSize = Math.max(7, Math.min(14, r * 0.32));
            var mcapSize = Math.max(7, Math.min(12, r * 0.28));

            var name = d.name || '';
            var maxChars = Math.max(2, Math.floor(r * 1.8 / nameSize));
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';

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

            if (has3) {
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
        //  - alphaDecay 0 → 영원히 안 멈춤 (백그라운드 탭에서는 visibility 로 정지)
        //  - velocityDecay 0.16 → 가벼운 마찰, 너무 빠르지 않게
        //  - drift force → 매 tick 약한 random velocity 더해서 살랑살랑 부유
        //  - collide + 경계 반사 → 부딪히면 살짝 튕김
        if (simulation) simulation.stop();
        var DRIFT = 0.06;
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
            .velocityDecay(0.16)
            .force('charge', d3.forceManyBody().strength(-1.2))
            .force('collide', d3.forceCollide()
                .radius(function (d) { return d.r + 1.5; })
                .strength(0.95)
                .iterations(2))
            .force('x', d3.forceX(function (d) { return d.targetX; }).strength(0.018))
            .force('y', d3.forceY(function (d) { return d.targetY; }).strength(0.018))
            .force('drift', driftForce)
            .on('tick', function () {
                node.attr('transform', function (d) {
                    var pad = d.r;
                    // 경계 부딪힘 — 살짝 튕김 (반발 60%)
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
            $liveLabel.textContent = isLiveDate() ? 'CLOSED' : 'PAST';
            stopRingFill();
        }
    }

    // ── fetch ──────────────────────────────────────────
    function fetchLive() {
        return fetch('/api/marketmap', { cache: 'no-cache' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                if (!data || !data.items || !data.items.length) throw new Error('empty');
                state.liveItems = data.items;
                state.marketStatus = data.market_status || state.marketStatus;
                if (state.dateIndex === 0 && state.period === '1d') render();
            });
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
                updateDateNav();
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

    function tick() {
        $clock.textContent = formatClock();
        var open = isMarketOpen();
        var live = isLiveDate() && state.period === '1d';
        if (live && open && document.visibilityState !== 'hidden') {
            startRingFill();
            fetchLive().catch(function () {});
            setLiveState(true);
        } else {
            setLiveState(false);
        }
        updateDateNav();
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
        var ctxStr = (PERIOD_LABEL[state.period] || state.period) + ' · ' + modeText + '   ·   ' + formatDate(state.currentDate);
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
                var fname = 'whyrise-bubblemap2-' + stamp + '-' + state.filter.toLowerCase() + '-' + state.period + '.png';
                a.href = dl; a.download = fname;
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
        $marketTabs.forEach(function (b) {
            b.addEventListener('click', function () { setFilter(b.getAttribute('data-filter')); });
        });
        $periodTabs.forEach(function (b) {
            b.addEventListener('click', function () { setPeriod(b.getAttribute('data-period')); });
        });
        if ($save) $save.addEventListener('click', savePNG);
        if ($datePrev) $datePrev.addEventListener('click', function () { gotoDateIndex(state.dateIndex + 1); });
        if ($dateNext) $dateNext.addEventListener('click', function () { gotoDateIndex(state.dateIndex - 1); });
        if ($date) $date.addEventListener('click', openDatePicker);

        $clock.textContent = formatClock();
        setInterval(function () { $clock.textContent = formatClock(); }, 1000);

        fetchSnapshot('')
            .then(fetchDateIndex)
            .then(function () {
                if (isMarketOpen() && state.period === '1d' && state.dateIndex === 0) {
                    return fetchLive().catch(function () {});
                }
            })
            .catch(function (err) {
                $loading.style.display = 'none';
                $message.style.display = '';
                $message.textContent = '데이터를 불러올 수 없습니다 — ' + (err && err.message ? err.message : err);
            });

        if (isMarketOpen() && state.period === '1d' && state.dateIndex === 0) {
            startRingFill();
            setLiveState(true);
        } else {
            setLiveState(false);
        }
        setInterval(tick, POLL_MS);

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                if (simulation) simulation.alpha(1).restart();
                tick();
            } else {
                // 백그라운드 탭에서는 CPU 절약 — 시뮬레이션 정지
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
