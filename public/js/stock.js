/**
 * 종목 페이지 — /stock/{ticker} (rewrite 로 ?ticker=... 도착)
 *
 * 인덱스 (public/data/stock-history/{ticker}.json) 에서 events 읽어 타임라인 렌더.
 * 관리자 모드일 때 각 event 카드 우측에 ✏️ 편집 버튼.
 */
(function () {
    function getTicker() {
        var qs = new URLSearchParams(window.location.search);
        var t = qs.get('ticker');
        if (t) return t;
        // /stock/008420 직접 접근 (rewrite 미동작) 백업
        var m = window.location.pathname.match(/\/stock\/(\d{6})/);
        return m ? m[1] : null;
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

    function renderHeader(name, market, stats) {
        var $title = document.getElementById('stockTitle');
        var $market = document.getElementById('stockMarket');
        var $stats = document.getElementById('stockStats');
        document.getElementById('pageTitle').textContent = name + ' 왜 오름? — 이거왜오름?';
        document.getElementById('pageDesc').setAttribute('content',
            name + ' 이 +15% 이상 오른 모든 날짜와 이유. 최근 1년 ' + (stats.count_15 || 0) + '회.');

        $title.innerHTML = '<strong>' + name + '</strong> 왜 오름?';
        if (market) $market.textContent = market;

        if (!stats) { $stats.innerHTML = ''; return; }
        var html = '';
        html += '<div class="stock-header__stat">' +
            '<span class="stock-header__stat-label">+15% 이상 (1년)</span>' +
            '<span class="stock-header__stat-value">' + (stats.count_15 || 0) + '회</span></div>';
        if (stats.count_20 != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">+20% 이상</span>' +
                '<span class="stock-header__stat-value">' + stats.count_20 + '회</span></div>';
        }
        if (stats.count_limit != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">상한가</span>' +
                '<span class="stock-header__stat-value">' + stats.count_limit + '회</span></div>';
        }
        if (stats.avg_rate != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">평균 상승률</span>' +
                '<span class="stock-header__stat-value stock-header__stat-value--rise">+' +
                stats.avg_rate.toFixed(1) + '%</span></div>';
        }
        $stats.innerHTML = html;
    }

    function renderEvents(events, ticker) {
        var $tl = document.getElementById('timeline');
        if (!events || !events.length) {
            $tl.innerHTML = '<div class="event-empty">최근 1년간 +15% 이상 기록이 없습니다.</div>';
            return;
        }
        var html = '';
        events.forEach(function (ev) {
            var newsHtml = '';
            if (ev.news && ev.news.length) {
                newsHtml += '<div class="event-card__news">';
                ev.news.slice(0, 5).forEach(function (n) {
                    newsHtml += '<a href="' + n.link + '" target="_blank" rel="noopener">' +
                        '<span>' + n.title + '</span>' +
                        (n.source ? '<span class="news-source">' + n.source + '</span>' : '') +
                        '</a>';
                });
                newsHtml += '</div>';
            }
            var editClass = ev._edited ? ' row--edited' : '';
            html += '<article class="event-card' + editClass + '">' +
                '<div class="event-card__top">' +
                '<span class="event-card__date">' + formatDate(ev.date) + '</span>' +
                '<span class="event-card__rate">+' + ev.change_rate.toFixed(2) + '%</span>' +
                '<span class="event-card__price">종가 ' + (ev.close_price ? ev.close_price.toLocaleString('ko-KR') : '-') + '원</span>' +
                (ev.theme_tag ? '<span class="event-card__theme">' + ev.theme_tag + '</span>' : '') +
                '<button class="admin-edit-btn event-card__edit" data-action="admin-edit" data-ticker="' + ticker +
                    '" data-date="' + ev.date + '" title="이유 편집">✏️ 편집</button>' +
                '</div>' +
                '<div class="event-card__reason">' + (ev.rise_reason || '-') + '</div>' +
                newsHtml +
                '</article>';
        });
        $tl.innerHTML = html;
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

    function bindAdminEdit(history) {
        var modal = Admin.bindEditModal(function () {
            // 편집 후: 페이지 새로고침이 가장 단순 (인덱스 재빌드 후 반영되는 구조)
            // overrides 는 즉시 반영되지만 stock-history 인덱스는 cron 후 갱신.
            // 일단 단순히 reload — 다음 인덱스 빌드까지는 일자별 페이지에서만 보임.
            location.reload();
        });
        document.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-action="admin-edit"]');
            if (!btn) return;
            e.preventDefault();
            var ticker = btn.getAttribute('data-ticker');
            var date = btn.getAttribute('data-date');
            var ev = (history.events || []).find(function (x) { return x.date === date; }) || {};
            modal.open({
                date: date,
                ticker: ticker,
                name: history.name || ticker,
                reason: ev.rise_reason || '',
                theme_tag: ev.theme_tag || '',
                note: ev.note || '',
            });
        });
    }

    function bindNewsModal() {
        var $modal = document.getElementById('newsModal');
        var $close = document.getElementById('newsModalClose');
        if ($close) $close.addEventListener('click', function () { $modal.style.display = 'none'; });
        if ($modal) $modal.addEventListener('click', function (e) {
            if (e.target === $modal) $modal.style.display = 'none';
        });
    }

    function init() {
        bindThemeToggle();
        bindNewsModal();

        var ticker = getTicker();
        if (!ticker) {
            document.getElementById('stockTitle').textContent = '종목 코드가 없습니다';
            return;
        }

        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'block';

        WhyAPI.getStockHistory(ticker).then(function (history) {
            $loading.style.display = 'none';
            if (!history) {
                $msg.textContent = '이 종목의 인덱스가 없습니다 (아직 빌드 전이거나, 최근 1년간 +15% 이상 기록 없음).';
                $msg.style.display = 'block';
                document.getElementById('stockTitle').innerHTML = '<strong>' + ticker + '</strong> 왜 오름?';
                return;
            }
            renderHeader(history.name || ticker, history.market || '', history.stats || {});
            renderEvents(history.events || [], ticker);
            bindAdminEdit(history);
        }).catch(function (err) {
            $loading.style.display = 'none';
            $msg.textContent = '로딩 실패: ' + err.message;
            $msg.style.display = 'block';
        });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
