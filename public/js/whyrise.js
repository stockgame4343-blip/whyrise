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

    var state = {
        dates: [],
        currentDateIdx: 0,
        rankings: [],         // 원본 (필터 전)
        ratings: {},
        watchlistMode: false, // 별점 매긴 종목만 필터
    };

    function loadRatings() {
        try { state.ratings = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch (e) { state.ratings = {}; }
    }

    function saveRatings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.ratings)); }
        catch (e) {}
    }

    function formatDate(yyyymmdd) {
        if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
        var y = yyyymmdd.slice(0, 4);
        var m = parseInt(yyyymmdd.slice(4, 6), 10);
        var d = parseInt(yyyymmdd.slice(6, 8), 10);
        var DAYS = ['일','월','화','수','목','금','토'];
        var dt = new Date(parseInt(y,10), m - 1, d);
        return y + '. ' + m + '. ' + d + ' (' + DAYS[dt.getDay()] + ')';
    }

    function applyCutoffAndRender() {
        var filtered = (state.rankings || []).filter(function (r) {
            return r.change_rate != null && r.change_rate >= CUTOFF;
        });
        // 관심 모드: 별점 매긴 종목만
        if (state.watchlistMode) {
            filtered = filtered.filter(function (r) {
                var rt = state.ratings[r.ticker] || {};
                return (rt.stars || 0) > 0;
            });
        }
        // change_rate 내림차순 정렬, 1-base 랭킹 부여
        filtered.sort(function (a, b) { return (b.change_rate || 0) - (a.change_rate || 0); });
        filtered.forEach(function (r, i) { r._displayRank = i + 1; });

        var date = state.dates[state.currentDateIdx] || '';
        WhyTable.render(filtered, state.ratings, { date: date });

    }

    function loadDate(date) {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        if ($loading) $loading.style.display = 'block';
        if ($msg) $msg.style.display = 'none';

        return WhyAPI.getRankings(date).then(function (data) {
            state.rankings = data.rankings || [];
            applyCutoffAndRender();
            var $upd = document.getElementById('lastUpdated');
            if ($upd) $upd.textContent = data.collected_at ? data.collected_at.replace('T', ' ').slice(0, 16) + ' 수집' : '';
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
        $btn.addEventListener('click', function () {
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
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            state.ratings[ticker] = state.ratings[ticker] || {};
            state.ratings[ticker].memo = $area.value.trim();
            saveRatings();
            applyCutoffAndRender();
            $modal.style.display = 'none';
        });
        if ($del) $del.addEventListener('click', function () {
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

    function init() {
        loadRatings();
        bindThemeToggle();
        bindDateNav();
        bindWatchlistToggle();
        bindRatingsEvents();
        bindMemoModal();
        bindNewsModal();
        loadWidgetTopRecent();

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
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', WhyApp.init);
