/**
 * 트리맵 — 한국 시총 TOP 100 KOSPI + 100 KOSDAQ.
 *
 * 라이브 polling
 *  - 평일 KST 09:00 ~ 15:30 사이에 5초마다 /api/marketmap fetch.
 *  - 장 시간 외엔 polling 정지, 마지막 데이터 또는 정적 /data/marketmap.json fallback.
 *
 * 색감
 *  - 상승: 강할수록 밝아짐 (빨강 L 32% → 62%)
 *  - 하락: 강할수록 어두워짐 (파랑 L 32% →  9%)
 *  - 보합(±0.1% 이내): 회색
 *
 * 면적 = market_cap (squarified treemap)
 * 클릭 = /stock/{ticker} 이동
 */
(function () {
    'use strict';

    // polling 주기 — 사용자 늘면 60000(60s) 로 조정 가능. ring 채워지는 속도도
    // 같이 따라감 (transition duration = POLL_MS / 1000 s).
    var POLL_MS = 15000;
    var KST_OFFSET = 9 * 60;            // 분 단위
    var OPEN_MIN = 9 * 60;              // 09:00
    var CLOSE_MIN = 15 * 60 + 30;       // 15:30
    var RING_CIRCUM = 2 * Math.PI * 9;  // 2πr (r=9) — SVG viewBox 24×24 기준

    var $stage = document.getElementById('tmapStage');
    var $svg = document.getElementById('tmapSvg');
    var $loading = document.getElementById('tmapLoading');
    var $message = document.getElementById('tmapMessage');
    var $clock = document.getElementById('tmapClock');
    var $date = document.getElementById('tmapDate');
    var $live = document.getElementById('tmapLive');
    var $liveLabel = document.getElementById('tmapLiveLabel');
    var $ringFg = document.querySelector('.tmap-live__ring-fg');
    var $tabs = document.querySelectorAll('.tmap-tab');

    var state = {
        items: [],         // 전체 200 종목 (KOSPI 100 + KOSDAQ 100)
        filter: 'ALL',     // 'ALL' / 'KOSPI' / 'KOSDAQ'
        date: '',
        marketStatus: 'CLOSE',
    };

    // ── 시간 ──────────────────────────────────────────
    function kstNow() {
        var n = new Date();
        return new Date(n.getTime() + (n.getTimezoneOffset() + KST_OFFSET) * 60000);
    }
    function isMarketOpen() {
        var k = kstNow();
        var day = k.getUTCDay();   // 위 kstNow 는 UTC 시각으로 KST 표현 → UTC getter 사용
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
        if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
        if (v >= 1e8) return Math.round(v / 1e8) + '억';
        return Math.round(v).toLocaleString();
    }

    // ── 색상 (HSL) ─────────────────────────────────────
    // 상승: 강할수록 L 증가 (밝아짐). 하락: 강할수록 L 감소 (어두워짐).
    function colorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) {
            return 'hsl(220, 5%, 28%)';
        }
        var r = Math.max(-5, Math.min(5, rate));
        var t = Math.abs(r) / 5;     // 0..1
        if (r > 0) {
            var l = 32 + t * 30;     // 32 → 62
            var s = 65 + t * 20;     // 65 → 85
            return 'hsl(0, ' + s + '%, ' + l + '%)';
        }
        var l2 = 32 - t * 23;        // 32 → 9
        var s2 = 55 + t * 25;        // 55 → 80
        return 'hsl(220, ' + s2 + '%, ' + l2 + '%)';
    }

    // ── 트리맵 렌더 ────────────────────────────────────
    function render() {
        if (!state.items.length) return;
        var w = $stage.clientWidth;
        var h = $stage.clientHeight;
        if (w < 80 || h < 80) return;

        var items = state.filter === 'ALL'
            ? state.items
            : state.items.filter(function (it) { return it.market === state.filter; });

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

        cell.each(function (d) {
            var cw = d.x1 - d.x0;
            var ch = d.y1 - d.y0;
            if (cw < 36 || ch < 28) return;
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

        cell.append('title').text(function (d) {
            return d.data.name + ' (' + d.data.ticker + ')\n'
                + d.data.market + (d.data.sector ? ' · ' + d.data.sector : '') + '\n'
                + '시총: ' + formatMcap(d.data.market_cap) + '\n'
                + formatRate(d.data.change_rate);
        });
    }

    // ── 라이브 ring 애니메이션 ─────────────────────────
    // 5초 동안 stroke-dashoffset RING_CIRCUM → 0 (채워짐). 매 fetch 시점에 리셋.
    function startRingFill() {
        if (!$ringFg) return;
        $ringFg.style.transition = 'none';
        $ringFg.style.strokeDashoffset = String(RING_CIRCUM);
        // reflow 후 transition 적용
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
            $liveLabel.textContent = 'CLOSED';
            stopRingFill();
        }
    }

    // ── 데이터 fetch ───────────────────────────────────
    function fetchLive() {
        return fetch('/api/marketmap', { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                if (!data || !data.items || !data.items.length) throw new Error('empty');
                state.items = data.items;
                state.date = data.date || state.date;
                state.marketStatus = data.market_status || state.marketStatus;
                $date.textContent = formatDate(state.date) + ' 기준';
                $loading.style.display = 'none';
                render();
            });
    }

    function fetchStatic() {
        return fetch('/data/marketmap.json', { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('정적 데이터 없음');
                return r.json();
            })
            .then(function (data) {
                state.items = (data && data.items) || [];
                state.date = (data && data.date) || '';
                $date.textContent = formatDate(state.date) + ' 기준';
                $loading.style.display = 'none';
                if (state.items.length) render();
            });
    }

    // ── 메인 loop ──────────────────────────────────────
    function tick() {
        $clock.textContent = formatClock();
        var open = isMarketOpen();
        // hidden 탭은 polling 건너뜀 (네트워크/Vercel 비용 절감)
        if (open && document.visibilityState !== 'hidden') {
            startRingFill();
            fetchLive().catch(function () { /* 실패 시 다음 cycle 재시도 */ });
            setLiveState(true);
        } else {
            setLiveState(false);
        }
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

        // 시계는 1초마다 (5초 polling 과 무관, 항상 흐름)
        $clock.textContent = formatClock();
        setInterval(function () { $clock.textContent = formatClock(); }, 1000);

        // 초기 로드: 장중이면 라이브, 아니면 정적 fallback
        var firstLoad;
        if (isMarketOpen()) {
            firstLoad = fetchLive().catch(fetchStatic);
        } else {
            firstLoad = fetchStatic().catch(fetchLive);
            setLiveState(false);
        }
        firstLoad.catch(function (err) {
            $loading.style.display = 'none';
            $message.style.display = '';
            $message.textContent = '데이터를 불러올 수 없습니다 — ' + (err && err.message ? err.message : err);
        });

        // 장중이면 5초 polling 시작
        if (isMarketOpen()) {
            startRingFill();
            setLiveState(true);
        }
        setInterval(tick, POLL_MS);

        // 탭이 다시 보이면 즉시 1회 갱신
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && isMarketOpen()) tick();
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
