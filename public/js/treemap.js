/**
 * 트리맵 — 한국 시총 TOP 100 KOSPI + 100 KOSDAQ.
 *
 * 모드/필터/기간
 *  - filter: ALL / KOSPI / KOSDAQ
 *  - period: 1d / 1w / 1m / 3m / 1y
 *  - zoomedSector: 섹터 박스 클릭 → 그 섹터만
 *  - currentDate: 오늘이면 라이브 (1d), 과거면 스냅샷
 *
 * 데이터 소스
 *  - /api/marketmap     (라이브, 1d만, 평일 KST 09:00~15:30)
 *  - /data/marketmap.json (정적 빌드 — sector + rates[1d/1w/1m/3m/1y])
 *  - /data/marketmap/{YYYYMMDD}.json (일별 스냅샷)
 *  - /data/marketmap/index.json (날짜 인덱스, 최신순)
 *
 * UI
 *  - LIVE ring (15s) / 시계 / 날짜 네비 < > / 시간 탭 / 시장 탭 / 저장
 *  - 섹터 그룹화는 ALL && 1d 모드에서만 활성. 다른 기간은 평면 (섹터 의미 약함)
 */
(function () {
    'use strict';

    var POLL_MS = 15000;
    var KST_OFFSET = 9 * 60;
    var OPEN_MIN = 9 * 60;
    var CLOSE_MIN = 15 * 60 + 30;
    var RING_CIRCUM = 2 * Math.PI * 9;
    var SECTOR_LABEL_HEIGHT = 22;

    // 시총 1·2위 (삼성전자·SK하이닉스) 만 면적 80% 로 축소 — 균형 잡힌 시각화
    var SIZE_SCALE_TICKERS = { '005930': 0.8, '000660': 0.8 };

    // 별도 "반도체" 그룹으로 분리 — 시총 큰 3종목.
    // 나머지 "반도체와반도체장비" 섹터 종목은 "반도체·장비" 그룹으로 유지.
    var SEMI_LEAD_GROUP = '반도체';
    var SEMI_LEAD_TICKERS = { '005930': true, '005935': true, '000660': true };
    // 차단 종목 — 모든 페이지에서 가려짐
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    var PERIOD_LABEL = { '1d': '1일', '1w': '1주', '1m': '1달', '3m': '3달', '1y': '1년' };
    var SORT_LABEL = { mcap: '시총', volume: '거래량', change: '상승률' };

    // 정렬 기준별 score. 상승률은 양수만 큰 순 — 음수(하락)는 자연 정렬로 뒤로 감.
    // change: 면적 상대성 강화를 위해 제곱 (5%~30% → 25~900 → 면적 비율 36:1).
    // 정렬 순위는 단조 변환이라 동일.
    function sortScore(it, sort) {
        if (sort === 'volume') return it.trading_value || 0;
        if (sort === 'change') {
            var r = it.change_rate;
            if (r == null || isNaN(r)) return -Infinity;
            return r > 0 ? r * r : r;
        }
        return it.market_cap || 0;
    }

    // 네이버 industry 원본은 띄어쓰기 없음 — 표시용 매핑
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
        '건강관리장비': '의료장비',
        '의약품·생물공학·생명과학': '제약·바이오',
        '의약품및생물공학': '제약·바이오',
        '운수창고업': '운수·창고',
        '종합금융': '종합금융',
        '기타금융': '기타 금융',
        '음식료품': '음식료',
        '비철금속': '비철금속',
        '전기·전자': '전기전자',
        '에너지': '에너지',
        '소재': '소재',
        '자본재': '자본재',
        '은행': '은행',
        '보험': '보험',
        '통신서비스': '통신',
        '유틸리티': '유틸리티',
        '운송': '운송',
        '소비자서비스': '소비자서비스',
        '부동산': '부동산',
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
    var $back = document.getElementById('tmapBack');
    var $backLabel = document.getElementById('tmapBackLabel');
    var $save = document.getElementById('tmapSave');
    var $datePrev = document.getElementById('tmapDatePrev');
    var $dateNext = document.getElementById('tmapDateNext');

    var state = {
        liveItems: [],         // 라이브 1d (오늘) — 시총·등락률 최신
        snapshotItems: [],     // 정적 (오늘 or 과거) — rates 포함
        sectorMap: {},         // ticker → sector
        filter: 'ALL',
        period: '1d',
        sort: 'mcap',          // mcap | volume | change
        zoomedSector: null,
        availableDates: [],    // 과거 스냅샷 일자 (최신순)
        dateIndex: 0,          // 0 = 오늘(또는 최신)
        currentDate: '',
        marketStatus: 'CLOSE',
    };

    // ── 시간 ──────────────────────────────────────────
    // KST = UTC + 9h. Date.now() 가 UTC epoch ms 이므로 사용자 시간대와 무관하게
    // 항상 KST 시각을 표현하는 Date 객체 반환. getUTC* 로 KST 값 추출.
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
        // marketValue 는 억원 단위 (네이버 m.stock 응답). 1만 억 = 1조.
        if (v >= 100 * 10000) return Math.round(v / 10000).toLocaleString() + '조'; // 100조↑ 정수
        if (v >= 10000) return (v / 10000).toFixed(1) + '조';                       // 1~100조 .1자리
        return Math.round(v).toLocaleString() + '억';                                // 1조 미만 억
    }
    // 거래대금 (원 단위)
    function formatTradingValue(v) {
        if (!v || v <= 0) return '-';
        if (v >= 1e12) return (v / 1e12).toFixed(1) + '조';
        if (v >= 1e8) return Math.round(v / 1e8).toLocaleString() + '억';
        if (v >= 1e4) return Math.round(v / 1e4).toLocaleString() + '만';
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
    function isLiveDate() {
        // 오늘(또는 최신 일자) 보고 있을 때만 라이브 polling 적용
        return state.dateIndex === 0;
    }

    function activeItems() {
        // 1d 라이브 (오늘 + 1d 모드) 이면 라이브 우선, 아니면 스냅샷
        var useLive = isLiveDate() && state.period === '1d' && state.liveItems.length;
        var base = useLive ? state.liveItems : state.snapshotItems;
        return base.map(function (it) {
            var copy = Object.assign({}, it);
            // sector 머지 (라이브엔 sector 없음)
            if (!copy.sector) copy.sector = state.sectorMap[copy.ticker] || '';
            // 삼성전자·우·SK하이닉스 만 별도 "반도체" 그룹으로 떼어냄
            if (SEMI_LEAD_TICKERS[copy.ticker]) copy.sector = SEMI_LEAD_GROUP;
            // 시간 모드 → change_rate 교체
            if (state.period !== '1d') {
                var rates = copy.rates || null;
                if (!rates) {
                    var snap = state.snapshotItems.find(function (s) { return s.ticker === copy.ticker; });
                    rates = snap && snap.rates ? snap.rates : null;
                }
                if (rates && rates[state.period] != null) {
                    copy.change_rate = rates[state.period];
                } else {
                    copy.change_rate = null;
                }
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
        // 상승률 모드: 음수(하락) 종목 제외 — 라벨 의미에 맞춤
        if (sort === 'change') {
            items = items.filter(function (it) {
                var r = it.change_rate;
                return r != null && !isNaN(r) && r > 0;
            });
        }
        items.sort(function (a, b) { return sortScore(b, sort) - sortScore(a, sort); });
        return items.slice(0, 100);
    }

    function isSectorGrouped() {
        // 시총 정렬 + 전체 모드일 때만 섹터 그룹화. 거래량·상승률은 평면 (섹터 의미 약함)
        return state.filter === 'ALL' && state.sort === 'mcap';
    }

    // 1d 상승률 면적 캡 — 한국 일일 상한 +30%. 신규상장만 +100/+300% 라 왜곡 → 1d 에서만 캡.
    // 1주/1달/3달/1년 누적은 +100%+ 정상이라 r*r 그대로.
    var CHANGE_SIZE_THRESHOLD = 30;
    var CHANGE_SIZE_CAP_SCORE = 30 * 30 * 1.3;
    function sizeOf(it) {
        var sort = state.sort;
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

    function buildHierarchyData(items) {
        if (!isSectorGrouped()) {
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
        sectors.sort(function (a, b) {
            var sa = a.children.reduce(function (s, x) { return s + sizeOf(x); }, 0);
            var sb = b.children.reduce(function (s, x) { return s + sizeOf(x); }, 0);
            return sb - sa;
        });
        // zoom 모드: 선택한 섹터만 hierarchy 에 — 박스 + 라벨 그대로 유지
        if (state.zoomedSector) {
            var picked = sectors.filter(function (s) { return s.name === state.zoomedSector; });
            return { children: picked.length ? picked : sectors };
        }
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

        var grouped = isSectorGrouped();
        var root = d3.hierarchy(buildHierarchyData(items))
            .sum(function (d) { return d.children ? 0 : sizeOf(d); })
            .sort(function (a, b) { return b.value - a.value; });

        d3.treemap()
            .size([w, h])
            .paddingOuter(grouped ? 4 : 0)
            .paddingTop(function (d) {
                if (!grouped) return 0;
                if (d.depth === 0) return 0;
                if (d.data && d.data.isSector) return SECTOR_LABEL_HEIGHT;
                return 0;
            })
            .paddingInner(grouped ? 5 : 2)
            .round(true)(root);

        var svg = d3.select($svg)
            .attr('width', w)
            .attr('height', h)
            .attr('viewBox', '0 0 ' + w + ' ' + h);

        svg.selectAll('*').remove();

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
                .attr('rx', 4);

            sectorG.append('text')
                .attr('class', 'tmap-sector__label')
                .attr('x', 8)
                .attr('y', 15)
                .text(function (d) {
                    var w = d.x1 - d.x0;
                    var name = displaySector(d.data.name || '기타');
                    var max = Math.max(2, Math.floor(w / 8));
                    if (name.length > max) name = name.slice(0, max - 1) + '…';
                    return name;
                });

            sectorG.append('title').text(function (d) {
                var sum = 0; (d.children || []).forEach(function (c) { sum += c.value; });
                return displaySector(d.data.name) + ' · ' + (d.children || []).length + '종목 · 합산시총 ' + formatMcap(sum);
            });
        }

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

        var showVolume = state.sort === 'volume';
        cell.each(function (d) {
            var cw = d.x1 - d.x0;
            var ch = d.y1 - d.y0;
            if (cw < 36 || ch < 28) return;
            var g = d3.select(this);
            var nameSize = Math.max(10, Math.min(20, cw / 8));
            var rateSize = Math.max(9, nameSize - 3);
            var mcapSize = Math.max(8, Math.min(13, nameSize - 5));
            var volSize = Math.max(8, Math.min(12, nameSize - 6));

            var name = d.data.name || '';
            var maxChars = Math.max(2, Math.floor(cw / (nameSize * 0.55)) - 1);
            if (name.length > maxChars) name = name.slice(0, maxChars - 1) + '…';

            // 셀 크기에 따라 4·3·2·1 줄 — 거래량 모드일 땐 4번째 줄에 거래대금
            var has4 = showVolume && ch >= 84 && cw >= 70;
            var has3 = ch >= 60 && cw >= 60;
            var has2 = ch >= 42;
            var mcapStr = formatMcap(d.data.market_cap);
            var rateStr = formatRate(d.data.change_rate);
            var volStr = formatTradingValue(d.data.trading_value);

            function line(cls, y, size, txt, opacity) {
                var t = g.append('text')
                    .attr('class', cls)
                    .attr('x', cw / 2)
                    .attr('y', y)
                    .attr('text-anchor', 'middle')
                    .attr('dominant-baseline', 'middle')
                    .style('font-size', size + 'px')
                    .text(txt);
                if (opacity != null) t.style('opacity', opacity);
                return t;
            }

            if (has4) {
                var g4 = 2;
                var totalH4 = nameSize + mcapSize + rateSize + volSize + g4 * 3;
                var topY4 = ch / 2 - totalH4 / 2 + nameSize / 2;
                line('tmap-name', topY4, nameSize, name);
                line('tmap-mcap', topY4 + nameSize / 2 + g4 + mcapSize / 2, mcapSize, mcapStr, 0.78);
                line('tmap-rate', topY4 + nameSize / 2 + g4 + mcapSize + g4 + rateSize / 2, rateSize, rateStr);
                line('tmap-vol', topY4 + nameSize / 2 + g4 + mcapSize + g4 + rateSize + g4 + volSize / 2, volSize, volStr, 0.7);
            } else if (has3) {
                var gap = 2;
                var totalH = nameSize + mcapSize + rateSize + gap * 2;
                var topY = ch / 2 - totalH / 2 + nameSize / 2;
                line('tmap-name', topY, nameSize, name);
                line('tmap-mcap', topY + nameSize / 2 + gap + mcapSize / 2, mcapSize, mcapStr, 0.78);
                line('tmap-rate', topY + nameSize / 2 + gap + mcapSize + gap + rateSize / 2, rateSize, rateStr);
            } else if (has2) {
                line('tmap-name', ch / 2 - rateSize / 2, nameSize, name);
                line('tmap-rate', ch / 2 + nameSize / 2 + 2, rateSize, rateStr);
            } else {
                line('tmap-name', ch / 2, nameSize, name);
            }
        });

        cell.append('title').text(function (d) {
            return d.data.name + ' (' + d.data.ticker + ')\n'
                + d.data.market + (d.data.sector ? ' · ' + displaySector(d.data.sector) : '') + '\n'
                + '시총: ' + formatMcap(d.data.market_cap) + '\n'
                + (PERIOD_LABEL[state.period] || state.period) + ' ' + formatRate(d.data.change_rate);
        });
    }

    function updateBackBtn() {
        if (state.zoomedSector) {
            $back.style.display = '';
            $backLabel.textContent = displaySector(state.zoomedSector);
        } else {
            $back.style.display = 'none';
        }
    }

    function updateDateNav() {
        var n = state.availableDates.length;
        var i = state.dateIndex;
        if ($datePrev) $datePrev.disabled = i >= n - 1;
        if ($dateNext) $dateNext.disabled = i <= 0;
        $date.textContent = formatDate(state.currentDate);
    }

    function openDatePicker() {
        if (!window.DatePicker || !state.availableDates || !state.availableDates.length) return;
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
            $liveLabel.textContent = '장 마감';
            stopRingFill();
        }
        updateLastUpdated();
    }
    function updateLastUpdated() {
        if (!$liveLabel) return;
        var iso = state.lastUpdated || '';
        if (!iso) return;
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

    // ── 데이터 fetch ───────────────────────────────────
    function fetchLive() {
        return fetch('/api/marketmap', { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                if (!data || !data.items || !data.items.length) throw new Error('empty');
                state.liveItems = data.items;
                state.marketStatus = data.market_status || state.marketStatus;
                state.lastUpdated = data.updated_at || state.lastUpdated;
                // 라이브 date 가 정적(어제) 보다 새로우면 화면 날짜도 갱신
                if (state.dateIndex === 0 && data.date && data.date > (state.currentDate || '')) {
                    state.currentDate = data.date;
                    if (state.availableDates && state.availableDates.indexOf(data.date) < 0) {
                        state.availableDates.unshift(data.date);
                    }
                    updateDateNav();
                }
                updateLastUpdated();
                $loading.style.display = 'none';
                if (state.dateIndex === 0 && state.period === '1d') {
                    render();
                }
            });
    }

    // 라이브 대기 중 정적 (어제) 표시 안 함 — 5s 후 fallback
    var _liveTimeout = false;
    function isWaitingLive() {
        return isMarketOpen() && state.period === '1d' && state.dateIndex === 0
            && !state.liveItems.length && !_liveTimeout;
    }

    function fetchSnapshot(dateStr) {
        // dateStr: YYYYMMDD or '' (= 최신)
        var url = dateStr ? ('/data/marketmap/' + dateStr + '.json') : '/data/marketmap.json';
        return fetch(url, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('스냅샷 없음: ' + url);
                return r.json();
            })
            .then(function (data) {
                var items = (data && data.items) || [];
                items.forEach(function (it) {
                    if (it.ticker && it.sector) state.sectorMap[it.ticker] = it.sector;
                });
                state.snapshotItems = items;
                state.currentDate = (data && data.date) || dateStr || '';
                if (data && data.updated_at && !state.lastUpdated) {
                    state.lastUpdated = data.updated_at;
                    updateLastUpdated();
                }
                updateDateNav();
                if (isWaitingLive()) return;   // 라이브 도착 대기 중이면 보류
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

    // ring transition 시간 = setTimeout = fetch 정확 동기화 (chain pattern)
    function liveCycle() {
        updateDateNav();
        var open = isMarketOpen();
        var live = isLiveDate() && state.period === '1d';
        if (!(live && open) || document.visibilityState === 'hidden') {
            setLiveState(false);
            setTimeout(liveCycle, 5000);
            return;
        }
        setLiveState(true);
        startRingFill();
        setTimeout(function () {
            fetchLive().catch(function () {}).then(function () { liveCycle(); });
        }, POLL_MS);
    }

    // ── 컨트롤 ────────────────────────────────────────
    function setFilter(f) {
        if (state.filter === f && !state.zoomedSector) return;
        state.filter = f;
        state.zoomedSector = null;
        $marketTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-filter') === f);
        });
        updateBackBtn();
        render();
    }
    function setPeriod(p) {
        if (state.period === p) return;
        state.period = p;
        state.zoomedSector = null;
        $periodTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-period') === p);
        });
        updateBackBtn();
        // 1d 가 아니면 라이브 의미 없음 — ring 정지
        setLiveState(p === '1d' && isLiveDate() && isMarketOpen());
        render();
    }
    function setSort(s) {
        if (state.sort === s) return;
        state.sort = s;
        state.zoomedSector = null;   // 섹터 그룹화가 사라질 수도 있으니 zoom 해제
        $sortTabs.forEach(function (b) {
            b.classList.toggle('is-active', b.getAttribute('data-sort') === s);
        });
        updateBackBtn();
        render();
    }
    function gotoDateIndex(idx) {
        if (idx < 0 || idx >= state.availableDates.length) return;
        state.dateIndex = idx;
        state.zoomedSector = null;
        updateBackBtn();
        var d = state.availableDates[idx];
        if (idx === 0) {
            // 최신 — 메인 marketmap.json
            fetchSnapshot('');
        } else {
            fetchSnapshot(d);
        }
        setLiveState(idx === 0 && state.period === '1d' && isMarketOpen());
    }

    // ── 다크/라이트 토글 ──────────────────────────────
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

    // ── 이미지 저장 (SVG → PNG with 워터마크 헤더만) ─────
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
        var sectorLabelFill = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(20,22,28,0.92)';
        var cellTextStrokeColor = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.45)';
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

        // 헤더 워터마크
        wrap.appendChild(mkText(20, HEAD_H - 16, '이거왜오름?', { size: 16, weight: 800, fill: fgColor }));
        wrap.appendChild(mkText(132, HEAD_H - 16, 'whyrise.vercel.app', { size: 11, weight: 600, fill: fgDim }));

        var modeText = state.filter === 'ALL' ? '전체' : (state.filter === 'KOSPI' ? '코스피' : '코스닥');
        if (state.zoomedSector) modeText += ' · ' + displaySector(state.zoomedSector);
        var sortText = SORT_LABEL[state.sort] || '시총';
        var ctxStr = (PERIOD_LABEL[state.period] || state.period) + ' · ' + modeText + ' · ' + sortText + '   ·   ' + formatDate(state.currentDate);
        wrap.appendChild(mkText(w - 20, HEAD_H - 16, ctxStr, { size: 13, weight: 700, fill: fgColor, anchor: 'end' }));

        // SVG 클론 — 외부 CSS 가 PNG 에 적용 안 되므로 fill/stroke 를 인라인
        // attribute 로 직접 설정 (인라인 <style> 보다 안정적)
        var clone = svgEl.cloneNode(true);
        var sectorBoxFill = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.035)';
        var sectorBoxStroke = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.16)';
        clone.querySelectorAll('.tmap-sector__box').forEach(function (el) {
            el.setAttribute('fill', sectorBoxFill);
            el.setAttribute('stroke', sectorBoxStroke);
            el.setAttribute('stroke-width', '1');
        });
        clone.querySelectorAll('.tmap-sector__label').forEach(function (el) {
            el.setAttribute('fill', sectorLabelFill);
            el.setAttribute('font-family', fontStack);
            el.setAttribute('font-size', '12');
            el.setAttribute('font-weight', '800');
            el.setAttribute('letter-spacing', '-0.2');
        });
        clone.querySelectorAll('.tmap-cell text').forEach(function (el) {
            el.setAttribute('fill', '#fff');
            el.setAttribute('font-family', fontStack);
            el.setAttribute('paint-order', 'stroke');
            el.setAttribute('stroke', cellTextStrokeColor);
            el.setAttribute('stroke-width', '0.6');
        });
        clone.querySelectorAll('.tmap-cell .tmap-name').forEach(function (el) {
            el.setAttribute('font-weight', '700');
        });
        clone.querySelectorAll('.tmap-cell .tmap-mcap').forEach(function (el) {
            el.setAttribute('font-weight', '500');
            el.setAttribute('opacity', '0.78');
        });
        clone.querySelectorAll('.tmap-cell .tmap-rate').forEach(function (el) {
            el.setAttribute('font-weight', '600');
        });
        clone.querySelectorAll('.tmap-cell .tmap-vol').forEach(function (el) {
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
                var stamp = (state.currentDate || '').replace(/[^0-9]/g, '') || 'live';
                var modeStamp = state.filter.toLowerCase() + '-' + state.period + '-' + state.sort;
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
        if ($back) {
            $back.addEventListener('click', function () {
                state.zoomedSector = null;
                updateBackBtn();
                render();
            });
        }
        if ($save) $save.addEventListener('click', savePNG);
        if ($datePrev) $datePrev.addEventListener('click', function () { gotoDateIndex(state.dateIndex + 1); });
        if ($dateNext) $dateNext.addEventListener('click', function () { gotoDateIndex(state.dateIndex - 1); });
        if ($date) $date.addEventListener('click', openDatePicker);

        // 시계 element 제거 — LIVE 라벨의 마지막 업데이트 시각만 표시

        // 1) 정적 latest marketmap.json → sectorMap + 첫 렌더
        // 2) 일별 index 로딩
        // 3) 장중이면 라이브 시도
        // 5s 안에 라이브 도착 안 하면 정적으로 fallback
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
