/**
 * 메인 — 컷오프 토글 + 일별 종목 표시 + 위젯 + 호버 메뉴 이벤트.
 *
 * stock-rise app.js 의 핵심을 가벼운 형태로 이식:
 *  - localStorage key 'whyrise-ratings' (stock-rise 와 분리)
 *  - 컷오프 toggle [+10/+15/+20/29.9]
 *  - 위젯: 최근 30일 동안 +15% 이상 친 종목 TOP 10 (인덱스 기반)
 */
var WhyApp = (function () {

    var STORAGE_KEY = 'whyrise-ratings';
    var WATCHLIST_KEY = 'whyrise-watchlist-mode';
    var THEME_KEY = 'theme';
    var CUTOFF = 15;   // 고정
    // 모든 메뉴에서 가려야 할 종목 — 에이프로젠바이오로직스, 졸스, 에이프로젠
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };
    // 라이브 polling — 버블맵과 동일 15s (stock-rise backend 는 5분 주기 갱신이라
    // 실제 데이터 변경은 5분마다, ring 만 자주 채워짐)
    var POLL_MS = 15 * 1000;
    var KST_OFFSET = 9 * 60;
    var OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 30;
    var RING_CIRCUM = 2 * Math.PI * 9;
    function isMarketOpenKST() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }
    // ── LIVE ring / chain pattern (버블맵·트리맵과 동일) ──
    function $ringFg() { return document.querySelector('#homeLive .tmap-live__ring-fg'); }
    function startRingFill() {
        var el = $ringFg(); if (!el) return;
        el.style.transition = 'none';
        el.style.strokeDashoffset = String(RING_CIRCUM);
        void el.getBoundingClientRect();
        el.style.transition = 'stroke-dashoffset ' + (POLL_MS / 1000) + 's linear';
        el.style.strokeDashoffset = '0';
    }
    function stopRingFill() {
        var el = $ringFg(); if (!el) return;
        el.style.transition = 'none';
        el.style.strokeDashoffset = String(RING_CIRCUM);
    }
    function _dateStrKST() {
        var d = state.dates[state.currentDateIdx] || '';
        if (d.length !== 8) return '';
        return d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8);
    }
    function _composeLabel() {
        // 'LIVE' 글자 없이 날짜·시간만 — 회색 텍스트 + ring 만으로 라이브 표현
        var ds = _dateStrKST();
        var hhmm = (state.collectedAt || '').slice(11, 16);
        return [ds, hhmm].filter(Boolean).join(' ');
    }
    function setLiveState(open) {
        var live = document.getElementById('homeLive');
        var lab = document.getElementById('homeLiveLabel');
        if (!live || !lab) return;
        if (open) live.classList.remove('tmap-live--idle');
        else { live.classList.add('tmap-live--idle'); stopRingFill(); }
        lab.textContent = _composeLabel();
    }
    function refreshLiveLabel() {
        var lab = document.getElementById('homeLiveLabel');
        if (!lab) return;
        lab.textContent = _composeLabel();
    }
    function liveCycle() {
        var isLatest = state.currentDateIdx === 0;
        var open = isMarketOpenKST();
        if (!isLatest || !open || document.visibilityState === 'hidden') {
            setLiveState(false);
            setTimeout(liveCycle, 5000);
            return;
        }
        setLiveState(true);
        startRingFill();
        setTimeout(function () {
            var p = loadDate(state.dates[0]);
            (p && p.then ? p : Promise.resolve()).then(function () { liveCycle(); });
        }, POLL_MS);
    }

    var state = {
        dates: [],
        currentDateIdx: 0,
        rankings: [],         // 원본 (필터 전)
        ratings: {},
        watchlistMode: false, // 별점 매긴 종목만 필터
        // 관심 모드 fallback: 그 날 랭킹에 없는 별표 종목을 stock-history events[0] 로 채우기 위한 캐시
        // ticker → {ticker,name,market,date,change_rate,close_price,rise_reason,theme_tag,sector,news}
        latestEvent: {},
        // history fetch 진행 중 ticker 집합 — 중복 fetch 방지
        _historyInFlight: {},
        tickerMeta: {},
    };

    function loadRatings() {
        state.ratings = window.WhyRatingsSync ? window.WhyRatingsSync.getCached() : {};
    }

    function saveRatings() {
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(state.ratings);
    }

    function requirePersonal(feature) {
        if (!window.WhyAuth || window.WhyAuth.personalAllowed()) return true;
        window.WhyAuth.requireLogin(feature);
        return false;
    }

    function formatDate(yyyymmdd) {
        if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
        var y = yyyymmdd.slice(0, 4);
        var m = yyyymmdd.slice(4, 6);
        var d = yyyymmdd.slice(6, 8);
        var DAYS = ['일','월','화','수','목','금','토'];
        var dt = new Date(+y, +m - 1, +d);
        return y + '.' + m + '.' + d + ' (' + DAYS[dt.getDay()] + ')';
    }

    /**
     * stock-history fetch — 별표 종목 중 그 날 랭킹에 없고 캐시에도 없는 ticker.
     * events[0] (가장 최근 +15% 친 날) 을 state.latestEvent 에 저장.
     * 모두 끝나면 onDone(changed) 호출 — true 일 때만 재렌더 트리거.
     *
     * 중요: 실패·404·이벤트 없는 ticker 도 latestEvent[ticker]=null 로 마킹.
     * 이 sentinel 이 없으면 호출자 가드가 매번 다시 fetch 트리거 → 무한 루프.
     * 가드는 hasOwnProperty 로 — null 도 "시도했음" 으로 인정.
     */
    function prefetchLatestEvents(tickers, onDone) {
        var todo = tickers.filter(function (t) {
            return !state.latestEvent.hasOwnProperty(t) && !state._historyInFlight[t];
        });
        if (!todo.length) { if (onDone) onDone(false); return; }
        todo.forEach(function (t) { state._historyInFlight[t] = true; });
        var promises = todo.map(function (ticker) {
            return WhyAPI.getStockHistory(ticker).then(function (hist) {
                if (hist && hist.events && hist.events.length) {
                    var ev = hist.events[0];
                    var entry = {
                        ticker: ticker,
                        name: hist.name || ticker,
                        market: hist.market || '',
                        date: ev.date || '',
                        change_rate: ev.change_rate,
                        close_price: ev.close_price,
                        trading_value: ev.trading_value || null,
                        market_cap: ev.market_cap || null,
                        rise_reason: ev.rise_reason || '',
                        theme_tag: ev.theme_tag || '',
                        sector: ev.sector || '',
                        news: ev.news || [],
                    };
                    state.latestEvent[ticker] = entry;
                    if (ev.date) {
                        return WhyAPI.getRankings(ev.date).then(function (daily) {
                            var rankings = (daily && daily.rankings) || [];
                            for (var i = 0; i < rankings.length; i++) {
                                if (rankings[i].ticker === ticker) {
                                    var row = rankings[i];
                                    entry.trading_value = row.trading_value || entry.trading_value || null;
                                    entry.market_cap = row.market_cap || entry.market_cap || null;
                                    entry.market = entry.market || row.market || '';
                                    entry.sector = entry.sector || row.sector || '';
                                    break;
                                }
                            }
                        }).catch(function () {});
                    }
                } else {
                    state.latestEvent[ticker] = null;   // 시도했지만 events 없음
                }
            }).catch(function () {
                state.latestEvent[ticker] = null;        // 404 등 — 재시도 막기 위한 sentinel
            }).then(function () { delete state._historyInFlight[ticker]; });
        });
        Promise.all(promises).then(function () { if (onDone) onDone(true); });
    }

    function applyCutoffAndRender() {
        var date = state.dates[state.currentDateIdx] || '';
        var filtered;
        var emptyMsg;

        if (state.watchlistMode) {
            // 관심 모드 — 날짜 무관, 별표 단 모든 종목을 stock-history events[0]
            // (각 종목의 가장 최근 +15% 친 날) 으로 통일. 사용자: "관심은 날자랑 상관없는거야".
            var starred = [];
            for (var t in state.ratings) {
                if (state.ratings[t] && (state.ratings[t].stars || 0) > 0) starred.push(t);
            }

            // 모든 별표 종목 prefetch — 한 번도 시도 안 한 ticker 만.
            // 가드는 hasOwnProperty — null sentinel(=시도 후 history 없음) 도 재시도 안 함.
            var needPrefetch = starred.filter(function (tk) {
                return !state.latestEvent.hasOwnProperty(tk);
            });
            if (needPrefetch.length) {
                prefetchLatestEvents(needPrefetch, function (changed) {
                    if (changed && state.watchlistMode) applyCutoffAndRender();
                });
            }

            filtered = starred.map(function (ticker) {
                var ev = state.latestEvent[ticker];
                if (ev) {
                    return {
                        ticker: ticker,
                        name: ev.name || ticker,
                        market: ev.market || '',
                        change_rate: ev.change_rate,
                        trading_value: ev.trading_value || null,
                        market_cap: ev.market_cap || null,
                        sector: ev.sector || '',
                        theme_tag: ev.theme_tag || '',
                        rise_reason: ev.rise_reason || '',
                        news: ev.news || [],
                        _fromHistory: true,
                        _historyDate: ev.date || '',
                    };
                }
                // history 도 없으면 인덱스 메타로 최소 dummy
                var meta = (state.tickerMeta || {})[ticker] || {};
                return {
                    ticker: ticker,
                    name: meta.name || ticker,
                    market: meta.market || '',
                    change_rate: null,
                    trading_value: null,
                    market_cap: null,
                    sector: '',
                    theme_tag: '',
                    rise_reason: '',
                    news: [],
                };
            });
            // 정렬: 최근 등장일(_historyDate) 최신순, 없으면 뒤로
            filtered.sort(function (a, b) {
                var ad = a._historyDate || '';
                var bd = b._historyDate || '';
                if (ad !== bd) return ad < bd ? 1 : -1;
                return (b.change_rate || -Infinity) - (a.change_rate || -Infinity);
            });
            emptyMsg = '관심 종목이 없습니다.';
        } else {
            filtered = (state.rankings || []).filter(function (r) {
                return r.change_rate != null && r.change_rate >= CUTOFF;
            });
            filtered.sort(function (a, b) { return (b.change_rate || 0) - (a.change_rate || 0); });
        }
        filtered.forEach(function (r, i) { r._displayRank = i + 1; });

        WhyTable.render(filtered, state.ratings, {
            date: date,
            emptyMsg: emptyMsg,
            watchlistMode: state.watchlistMode,
        });
    }

    function loadDate(date) {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        if ($loading) $loading.style.display = 'block';
        if ($msg) $msg.style.display = 'none';

        return WhyAPI.getRankings(date).then(function (data) {
            state.rankings = (data.rankings || []).filter(function (r) {
                return !BLOCKED_TICKERS[r.ticker];
            });
            state.collectedAt = data.collected_at || '';
            applyCutoffAndRender();
            refreshLiveLabel();
        }).catch(function (err) {
            if ($msg) {
                $msg.textContent = '데이터 로딩 실패: ' + err.message;
                $msg.style.display = 'block';
            }
        }).finally(function () {
            if ($loading) $loading.style.display = 'none';
        });
    }

    function updateDateUI() {
        var $disp = document.getElementById('dateDisplay');
        var date = state.dates[state.currentDateIdx];
        if ($disp) $disp.textContent = formatDate(date);
        refreshLiveLabel();   // LIVE 라벨에도 같은 날짜 동기화
    }

    function bindDateNav() {
        var $prev = document.getElementById('datePrev');
        var $next = document.getElementById('dateNext');
        var $disp = document.getElementById('dateDisplay');

        function jumpTo(date) {
            var idx = state.dates.indexOf(date);
            if (idx < 0) return;
            state.currentDateIdx = idx;
            updateDateUI();
            loadDate(date);
        }

        if ($prev) $prev.addEventListener('click', function () {
            if (state.currentDateIdx < state.dates.length - 1) {
                state.currentDateIdx++;
                updateDateUI();
                loadDate(state.dates[state.currentDateIdx]);
            }
        });
        if ($next) $next.addEventListener('click', function () {
            if (state.currentDateIdx > 0) {
                state.currentDateIdx--;
                updateDateUI();
                loadDate(state.dates[state.currentDateIdx]);
            }
        });

        // dateDisplay 클릭 → 캘린더 팝오버 (date-picker.js 가 글로벌 DatePicker 제공)
        function openPicker(trigger) {
            if (typeof DatePicker === 'undefined' || !DatePicker.open) return;
            DatePicker.open({
                trigger: trigger,
                dates: state.dates,
                current: state.dates[state.currentDateIdx],
                onSelect: jumpTo,
            });
        }
        if ($disp) $disp.addEventListener('click', function () { openPicker($disp); });
    }

    function bindWatchlistToggle() {
        var $btn = document.getElementById('watchlistBtn');
        if (!$btn) return;
        // 초기 복원
        try {
            state.watchlistMode = localStorage.getItem(WATCHLIST_KEY) === '1';
        } catch (e) {}
        $btn.classList.toggle('active', state.watchlistMode);
        window.addEventListener('whyrise:auth', function () {
            if (window.WhyAuth && !window.WhyAuth.personalAllowed() && state.watchlistMode) {
                state.watchlistMode = false;
                $btn.classList.remove('active');
                try { localStorage.setItem(WATCHLIST_KEY, '0'); } catch (e) {}
                applyCutoffAndRender();
            }
        });
        $btn.addEventListener('click', function () {
            if (!requirePersonal('watchlist')) return;
            state.watchlistMode = !state.watchlistMode;
            $btn.classList.toggle('active', state.watchlistMode);
            try { localStorage.setItem(WATCHLIST_KEY, state.watchlistMode ? '1' : '0'); }
            catch (e) {}
            applyCutoffAndRender();
        });
    }

    function bindThemeToggle() {
        var $btn = document.getElementById('themeToggle');
        if (!$btn) return;
        $btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem(THEME_KEY, next);
        });
    }

    function bindRatingsEvents() {
        var $body = document.getElementById('rankingBody');
        if (!$body) return;

        $body.addEventListener('click', function (e) {
            // 별점
            var star = e.target.closest('.star');
            if (star) {
                if (!requirePersonal('interest')) return;
                var ticker = star.parentNode.getAttribute('data-ticker');
                var n = parseInt(star.getAttribute('data-star'), 10);
                if (!ticker || !n) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                if (state.ratings[ticker].stars === n) state.ratings[ticker].stars = 0;
                else state.ratings[ticker].stars = n;
                saveRatings();
                applyCutoffAndRender();
                return;
            }
            // 제외
            var ex = e.target.closest('.exclude-btn');
            if (ex) {
                if (!requirePersonal('exclude')) return;
                var ticker2 = ex.getAttribute('data-ticker');
                state.ratings[ticker2] = state.ratings[ticker2] || {};
                state.ratings[ticker2].excluded = !state.ratings[ticker2].excluded;
                saveRatings();
                applyCutoffAndRender();
                return;
            }
            // 메모
            var memo = e.target.closest('.memo-btn');
            if (memo) {
                if (!requirePersonal('memo')) return;
                var ticker3 = memo.getAttribute('data-ticker');
                openMemo(ticker3);
                return;
            }
            // 컨트롤 토글 (모바일)
            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                var wrap = toggle.parentNode;
                wrap.classList.toggle('is-open');
                return;
            }
            // 관리자 편집 ✏️
            var adminBtn = e.target.closest('[data-action="admin-edit"]');
            if (adminBtn) {
                e.preventDefault();
                e.stopPropagation();
                var ticker4 = adminBtn.getAttribute('data-ticker');
                var date4 = adminBtn.getAttribute('data-date');
                openAdminEdit(ticker4, date4);
                return;
            }
        });
    }

    var _adminModal = null;
    function openAdminEdit(ticker, date) {
        if (!_adminModal) {
            _adminModal = Admin.bindEditModal(function () {
                // 저장 후 다시 fetch
                loadDate(state.dates[state.currentDateIdx]);
            });
        }
        if (!_adminModal) return;
        var stock = state.rankings.find(function (r) { return r.ticker === ticker; });
        _adminModal.open({
            date: date,
            ticker: ticker,
            name: stock ? stock.name : ticker,
            reason: stock ? stock.rise_reason : '',
            theme_tag: stock ? stock.theme_tag : '',
            note: stock ? (stock._edit_note || '') : '',
        });
    }

    function openMemo(ticker) {
        var $modal = document.getElementById('memoModal');
        var $title = document.getElementById('memoModalTitle');
        var $area = document.getElementById('memoTextarea');
        if (!$modal || !$area) return;
        var stock = state.rankings.find(function (r) { return r.ticker === ticker; });
        $title.textContent = (stock ? stock.name : ticker) + ' 메모';
        var rating = state.ratings[ticker] || {};
        $area.value = rating.memo || '';
        $area.setAttribute('data-ticker', ticker);
        $modal.style.display = 'flex';
        setTimeout(function () { $area.focus(); }, 50);
    }

    function bindMemoModal() {
        var $modal = document.getElementById('memoModal');
        var $close = document.getElementById('memoModalClose');
        var $save = document.getElementById('memoSave');
        var $del = document.getElementById('memoDelete');
        var $area = document.getElementById('memoTextarea');
        if (!$modal) return;
        if ($close) $close.addEventListener('click', function () { $modal.style.display = 'none'; });
        $modal.addEventListener('click', function (e) { if (e.target === $modal) $modal.style.display = 'none'; });
        if ($save) $save.addEventListener('click', function () {
            if (!requirePersonal('memo')) return;
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            state.ratings[ticker] = state.ratings[ticker] || {};
            state.ratings[ticker].memo = $area.value.trim();
            saveRatings();
            applyCutoffAndRender();
            $modal.style.display = 'none';
        });
        if ($del) $del.addEventListener('click', function () {
            if (!requirePersonal('memo')) return;
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            if (state.ratings[ticker]) delete state.ratings[ticker].memo;
            saveRatings();
            applyCutoffAndRender();
            $modal.style.display = 'none';
        });
    }

    function bindNewsModal() {
        var $modal = document.getElementById('newsModal');
        var $close = document.getElementById('newsModalClose');
        if ($close) $close.addEventListener('click', WhyTable.closeNews);
        if ($modal) $modal.addEventListener('click', function (e) {
            if (e.target === $modal) WhyTable.closeNews();
        });
    }

    function loadWidgetTopRecent() {
        var $list = document.getElementById('widgetTopRecentList');
        if (!$list) return;
        WhyAPI.getStockIndex().then(function (idx) {
            // index.json: { ticker: { name, count, ... } } 또는 { ticker: name } 단순형
            var rows = [];
            Object.keys(idx || {}).forEach(function (ticker) {
                var entry = idx[ticker];
                if (typeof entry === 'object' && entry.count_recent != null) {
                    rows.push({ ticker: ticker, name: entry.name, count: entry.count_recent });
                } else if (typeof entry === 'object' && entry.count != null) {
                    rows.push({ ticker: ticker, name: entry.name, count: entry.count });
                }
            });
            rows.sort(function (a, b) { return b.count - a.count; });
            rows = rows.slice(0, 10);
            if (!rows.length) {
                $list.innerHTML = '<li class="widget__empty">데이터 빌드 대기 중</li>';
                return;
            }
            var html = '';
            rows.forEach(function (r) {
                html += '<li><a href="/stock/' + r.ticker + '">' + r.name + '</a>' +
                    '<span class="count">' + r.count + '회</span></li>';
            });
            $list.innerHTML = html;
        }).catch(function () {
            $list.innerHTML = '<li class="widget__empty">인덱스 없음</li>';
        });
    }

    function loadTickerMeta() {
        // stock-history/index.json — 1177 종목의 name/count 메타.  관심 모드용.
        return fetch('/data/stock-history/index.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (m) { state.tickerMeta = m || {}; })
            .catch(function () { state.tickerMeta = {}; });
    }

    function init() {
        loadRatings();
        bindThemeToggle();
        bindDateNav();
        bindWatchlistToggle();
        bindRatingsEvents();
        bindMemoModal();
        bindNewsModal();
        loadTickerMeta();

        WhyAPI.getDates().then(function (dates) {
            if (!Array.isArray(dates) || !dates.length) {
                document.getElementById('message').textContent = '거래일 데이터 없음.';
                document.getElementById('message').style.display = 'block';
                return;
            }
            state.dates = dates;
            state.currentDateIdx = 0;
            updateDateUI();
            return loadDate(dates[0]);
        }).then(function () {
            liveCycle();   // chain pattern (ring transition = setTimeout = fetch 정확 동기화)
            // 서버 별점 동기화 — KV pull 후 머지되면 다시 그림. 실패해도 로컬 모드로 작동.
            if (window.WhyRatingsSync) {
                window.WhyRatingsSync.pull().then(function (result) {
                    if (result && result.ratings) {
                        state.ratings = result.ratings;
                        applyCutoffAndRender();
                    }
                });
            }
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', WhyApp.init);
