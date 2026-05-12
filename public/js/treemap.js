/**
 * 트리맵 — 한국 시총 TOP 100 KOSPI + 100 KOSDAQ.
 *
 * 모드
 *  - ALL    : 섹터별로 nested treemap (FinViz/kospd 스타일)
 *  - KOSPI  : 코스피 100 평면
 *  - KOSDAQ : 코스닥 100 평면
 *  - ALL 모드에서 섹터 박스 클릭 → zoom (그 섹터 종목만 평면)
 *
 * 라이브 polling (15초)
 *  - 평일 KST 09:00 ~ 15:30 사이만. /api/marketmap (라이브 — sector 없음)
 *  - sector 는 /data/marketmap.json (정적 빌드) 의 ticker→sector 매핑을 클라
 *    측에서 머지.
 *
 * 이미지 저장
 *  - SVG 클론 + 인라인 <style> 임베드 → Canvas 렌더 → PNG 다운로드 (retina 2×).
 *
 * 색감 (HSL)
 *  - 상승 강할수록 밝게 (L 32→62%), 하락 강할수록 어둡게 (L 32→9%).
 *
 * 면적 = market_cap, 클릭 = /stock/{ticker}.
 */
(function () {
    'use strict';

    var POLL_MS = 15000;
    var KST_OFFSET = 9 * 60;
    var OPEN_MIN = 9 * 60;
    var CLOSE_MIN = 15 * 60 + 30;
    var RING_CIRCUM = 2 * Math.PI * 9;
    var SECTOR_LABEL_HEIGHT = 18;

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
    var $back = document.getElementById('tmapBack');
    var $backLabel = document.getElementById('tmapBackLabel');
    var $save = document.getElementById('tmapSave');

    var state = {
        items: [],         // 라이브 또는 정적. KOSPI 100 + KOSDAQ 100 = 200.
        sectorMap: {},     // ticker → sector (정적 빌드에서 캐싱)
        filter: 'ALL',
        zoomedSector: null,
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
        if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
        if (v >= 1e8) return Math.round(v / 1e8) + '억';
        return Math.round(v).toLocaleString();
    }

    // ── 색상 (HSL) ─────────────────────────────────────
    function colorFor(rate) {
        if (rate == null || isNaN(rate) || Math.abs(rate) < 0.1) {
            return 'hsl(220, 5%, 28%)';
        }
        var r = Math.max(-5, Math.min(5, rate));
        var t = Math.abs(r) / 5;
        if (r > 0) {
            var l = 32 + t * 30;
            var s = 65 + t * 20;
            return 'hsl(0, ' + s + '%, ' + l + '%)';
        }
        var l2 = 32 - t * 23;
        var s2 = 55 + t * 25;
        return 'hsl(220, ' + s2 + '%, ' + l2 + '%)';
    }

    // ── 데이터 가공 ────────────────────────────────────
    function ensureSector(items) {
        // 라이브 응답에 sector 없으면 sectorMap 으로 채워줌
        return items.map(function (it) {
            if (it.sector) return it;
            var sec = state.sectorMap[it.ticker] || '';
            return Object.assign({}, it, { sector: sec });
        });
    }

    function visibleItems() {
        var items = state.items;
        if (state.filter === 'KOSPI' || state.filter === 'KOSDAQ') {
            return items.filter(function (it) { return it.market === state.filter; });
        }
        if (state.zoomedSector) {
            return items.filter(function (it) {
                return (it.sector || '기타') === state.zoomedSector;
            });
        }
        return items;
    }

    function isGrouped() {
        // 전체 모드 + zoom 안 한 상태 = 섹터 그룹 hierarchy
        return state.filter === 'ALL' && !state.zoomedSector;
    }

    function buildHierarchyData(items) {
        if (!isGrouped()) {
            return { children: items };
        }
        var bySector = {};
        items.forEach(function (it) {
            var sec = it.sector || '기타';
            (bySector[sec] = bySector[sec] || []).push(it);
        });
        var sectors = Object.keys(bySector).map(function (sec) {
            return { name: sec, isSector: true, children: bySector[sec] };
        });
        // 섹터 합계 시총 내림차순
        sectors.sort(function (a, b) {
            var sa = a.children.reduce(function (s, x) { return s + (x.market_cap || 0); }, 0);
            var sb = b.children.reduce(function (s, x) { return s + (x.market_cap || 0); }, 0);
            return sb - sa;
        });
        return { children: sectors };
    }

    // ── 트리맵 렌더 ────────────────────────────────────
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

        var grouped = isGrouped();
        var root = d3.hierarchy(buildHierarchyData(items))
            .sum(function (d) { return d.children ? 0 : Math.max(d.market_cap || 0, 1); })
            .sort(function (a, b) { return b.value - a.value; });

        d3.treemap()
            .size([w, h])
            .paddingOuter(grouped ? 1 : 0)
            .paddingTop(function (d) { return grouped && d.depth === 0 ? 0 : (grouped && d.data && d.data.isSector ? SECTOR_LABEL_HEIGHT : 0); })
            .paddingInner(grouped ? 1.5 : 2)
            .round(true)(root);

        var svg = d3.select($svg)
            .attr('width', w)
            .attr('height', h)
            .attr('viewBox', '0 0 ' + w + ' ' + h);

        svg.selectAll('*').remove();

        // ── 섹터 박스 (grouped 모드만) ──
        if (grouped) {
            var sectorG = svg.selectAll('g.tmap-sector')
                .data(root.children || [])
                .enter()
                .append('g')
                .attr('class', 'tmap-sector')
                .attr('transform', function (d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; })
                .style('cursor', 'pointer')
                .on('click', function (e, d) {
                    state.zoomedSector = d.data.name;
                    updateBackBtn();
                    render();
                });

            sectorG.append('rect')
                .attr('class', 'tmap-sector__box')
                .attr('width', function (d) { return Math.max(0, d.x1 - d.x0); })
                .attr('height', function (d) { return Math.max(0, d.y1 - d.y0); })
                .attr('fill', 'rgba(255,255,255,0.04)')
                .attr('stroke', 'rgba(255,255,255,0.10)')
                .attr('stroke-width', 1)
                .attr('rx', 3);

            sectorG.append('text')
                .attr('class', 'tmap-sector__label')
                .attr('x', 6)
                .attr('y', 13)
                .text(function (d) {
                    var w = d.x1 - d.x0;
                    var name = d.data.name || '기타';
                    var max = Math.max(2, Math.floor(w / 7));
                    if (name.length > max) name = name.slice(0, max - 1) + '…';
                    var sum = 0; (d.children || []).forEach(function (c) { sum += c.value; });
                    var cnt = (d.children || []).length;
                    return name + '  ' + cnt;
                });

            sectorG.append('title').text(function (d) {
                var sum = 0; (d.children || []).forEach(function (c) { sum += c.value; });
                return d.data.name + ' · ' + (d.children || []).length + '종목 · 합산시총 ' + formatMcap(sum);
            });
        }

        // ── 종목 셀 ──
        var cell = svg.selectAll('g.tmap-cell')
            .data(root.leaves())
            .enter()
            .append('g')
            .attr('class', 'tmap-cell')
            .attr('transform', function (d) { return 'translate(' + d.x0 + ',' + d.y0 + ')'; })
            .attr('data-ticker', function (d) { return d.data.ticker; })
            .style('cursor', 'pointer')
            .on('click', function (e, d) {
                e.stopPropagation();
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

    function updateBackBtn() {
        if (state.zoomedSector) {
            $back.style.display = '';
            $backLabel.textContent = state.zoomedSector;
        } else {
            $back.style.display = 'none';
        }
    }

    // ── 라이브 ring 애니메이션 ─────────────────────────
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
                state.items = ensureSector(data.items);
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
                var items = (data && data.items) || [];
                // sectorMap 캐시 — 이후 라이브 데이터 머지에 사용
                items.forEach(function (it) {
                    if (it.ticker && it.sector) state.sectorMap[it.ticker] = it.sector;
                });
                state.items = items;
                state.date = (data && data.date) || '';
                $date.textContent = formatDate(state.date) + ' 기준';
                $loading.style.display = 'none';
                if (state.items.length) render();
            });
    }

    function tick() {
        $clock.textContent = formatClock();
        var open = isMarketOpen();
        if (open && document.visibilityState !== 'hidden') {
            startRingFill();
            fetchLive().catch(function () {});
            setLiveState(true);
        } else {
            setLiveState(false);
        }
    }

    function setFilter(f) {
        if (state.filter === f && !state.zoomedSector) return;
        state.filter = f;
        state.zoomedSector = null;
        $tabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-filter') === f);
        });
        updateBackBtn();
        render();
    }

    // ── 이미지 저장 (SVG → PNG with 워터마크 헤더/푸터) ────
    function savePNG() {
        var svgEl = $svg;
        var w = svgEl.clientWidth;
        var h = svgEl.clientHeight;
        if (w < 80 || h < 80) return;

        var HEAD_H = 44;
        var FOOT_H = 26;
        var totalH = h + HEAD_H + FOOT_H;
        var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
        var bgColor = isDark ? '#0a0b0f' : '#ffffff';
        var fgColor = isDark ? '#ffffff' : '#0a0b0f';
        var fgDim = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(10,11,15,0.55)';
        var fontStack = '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Noto Sans KR", sans-serif';
        var ns = 'http://www.w3.org/2000/svg';

        function mkText(x, y, txt, opts) {
            opts = opts || {};
            var t = document.createElementNS(ns, 'text');
            t.setAttribute('x', String(x));
            t.setAttribute('y', String(y));
            t.setAttribute('fill', opts.fill || fgColor);
            t.setAttribute('font-size', String(opts.size || 12));
            t.setAttribute('font-weight', String(opts.weight || 600));
            t.setAttribute('font-family', fontStack);
            if (opts.anchor) t.setAttribute('text-anchor', opts.anchor);
            t.textContent = txt;
            return t;
        }

        // 새 컨테이너
        var wrap = document.createElementNS(ns, 'svg');
        wrap.setAttribute('xmlns', ns);
        wrap.setAttribute('width', String(w));
        wrap.setAttribute('height', String(totalH));
        wrap.setAttribute('viewBox', '0 0 ' + w + ' ' + totalH);

        // 인라인 스타일 (외부 CSS 는 PNG 에 반영 안 됨)
        var styleEl = document.createElementNS(ns, 'style');
        styleEl.textContent = '\n'
            + '.tmap-cell text { fill: #fff; pointer-events: none; user-select: none; font-family: ' + fontStack + '; paint-order: stroke; stroke: rgba(0,0,0,.4); stroke-width: 0.6px; }\n'
            + '.tmap-cell .tmap-name { font-weight: 700; letter-spacing: -.3px; }\n'
            + '.tmap-cell .tmap-rate { font-weight: 600; font-feature-settings: "tnum"; opacity: .94; }\n'
            + '.tmap-sector__label { fill: rgba(255,255,255,0.88); font-size: 11px; font-weight: 800; letter-spacing: -.2px; font-family: ' + fontStack + '; }\n';
        wrap.appendChild(styleEl);

        // 배경
        var bg = document.createElementNS(ns, 'rect');
        bg.setAttribute('width', String(w));
        bg.setAttribute('height', String(totalH));
        bg.setAttribute('fill', bgColor);
        wrap.appendChild(bg);

        // 헤더: 좌측 로고·도메인, 우측 모드·날짜
        var brand = mkText(20, HEAD_H - 16, '이거왜오름?', { size: 16, weight: 800, fill: fgColor });
        wrap.appendChild(brand);
        var domain = mkText(132, HEAD_H - 16, 'whyrise.vercel.app', { size: 11, weight: 600, fill: fgDim });
        wrap.appendChild(domain);

        var modeText = state.filter === 'ALL' ? '전체' : (state.filter === 'KOSPI' ? '코스피 100' : '코스닥 100');
        if (state.zoomedSector) modeText += ' · ' + state.zoomedSector;
        var ctxStr = modeText + '   ·   ' + formatDate(state.date) + ' 기준';
        wrap.appendChild(mkText(w - 20, HEAD_H - 16, ctxStr, { size: 13, weight: 700, fill: fgColor, anchor: 'end' }));

        // 트리맵 클론 → translate(0, HEAD_H) 그룹
        var clone = svgEl.cloneNode(true);
        var mapG = document.createElementNS(ns, 'g');
        mapG.setAttribute('transform', 'translate(0, ' + HEAD_H + ')');
        while (clone.firstChild) mapG.appendChild(clone.firstChild);
        wrap.appendChild(mapG);

        // 푸터: 좌측 안내, 우측 도메인 워터마크
        wrap.appendChild(mkText(20, totalH - 10, '면적 = 시가총액 · 색 = 등락률 · 한국 시총 TOP 200', { size: 10, weight: 600, fill: fgDim }));
        wrap.appendChild(mkText(w - 20, totalH - 10, 'whyrise.vercel.app', { size: 10, weight: 700, fill: fgDim, anchor: 'end' }));

        // SVG → PNG
        var svgStr = new XMLSerializer().serializeToString(wrap);
        var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);

        var img = new Image();
        img.onload = function () {
            var scale = 2;
            var canvas = document.createElement('canvas');
            canvas.width = w * scale;
            canvas.height = totalH * scale;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);

            canvas.toBlob(function (b) {
                if (!b) return;
                var dl = URL.createObjectURL(b);
                var a = document.createElement('a');
                var stamp = (state.date || '').replace(/[^0-9]/g, '') || 'live';
                var modeStamp = state.filter.toLowerCase();
                if (state.zoomedSector) modeStamp += '-' + state.zoomedSector;
                var fname = 'whyrise-treemap-' + stamp + '-' + modeStamp + '.png';
                a.href = dl;
                a.download = fname;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(dl);
            }, 'image/png');
        };
        img.onerror = function () {
            URL.revokeObjectURL(url);
            $message.style.display = '';
            $message.textContent = '이미지 변환 실패 — 다시 시도해주세요.';
            setTimeout(function () { $message.style.display = 'none'; }, 2000);
        };
        img.src = url;
    }

    // ── 초기화 ─────────────────────────────────────────
    function init() {
        $tabs.forEach(function (b) {
            b.addEventListener('click', function () { setFilter(b.getAttribute('data-filter')); });
        });
        if ($back) {
            $back.addEventListener('click', function () {
                state.zoomedSector = null;
                updateBackBtn();
                render();
            });
        }
        if ($save) $save.addEventListener('click', savePNG);

        $clock.textContent = formatClock();
        setInterval(function () { $clock.textContent = formatClock(); }, 1000);

        // 정적 marketmap.json 을 먼저 받아 sectorMap 채운 뒤, 장중이면 라이브 덮어씀.
        fetchStatic()
            .catch(function () { /* 정적 없어도 일단 라이브 시도 */ })
            .then(function () {
                if (isMarketOpen()) return fetchLive().catch(function () {});
            })
            .catch(function (err) {
                $loading.style.display = 'none';
                $message.style.display = '';
                $message.textContent = '데이터를 불러올 수 없습니다 — ' + (err && err.message ? err.message : err);
            });

        if (isMarketOpen()) {
            startRingFill();
            setLiveState(true);
        }
        setInterval(tick, POLL_MS);

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
