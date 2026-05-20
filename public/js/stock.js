/**
 * 종목 페이지 — /stock/{ticker} (rewrite 로 ?ticker=... 도착)
 *
 * 인덱스 (public/data/stock-history/{ticker}.json) 에서 events 읽어 타임라인 렌더.
 * 관리자 모드일 때 각 event 카드 우측에 ✏️ 편집 버튼.
 */
(function () {
    /** HTML 이스케이프 — XSS 방어. 사용자/3rd-party 텍스트는 항상 통과시킴. */
    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function getTicker() {
        var qs = new URLSearchParams(window.location.search);
        var t = qs.get('ticker');
        // 6자리 숫자 or 알파/숫자 (KRX 신코드) 만 허용. XSS 방어.
        if (t && /^[0-9A-Z]{6}$/i.test(t)) return t;
        // /stock/008420 직접 접근 (rewrite 미동작) 백업
        var m = window.location.pathname.match(/\/stock\/([0-9A-Z]{6})/i);
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

    function topByFreq(items, getKey) {
        var count = {};
        items.forEach(function (it) {
            var k = getKey(it);
            if (!k) return;
            count[k] = (count[k] || 0) + 1;
        });
        var keys = Object.keys(count);
        if (!keys.length) return null;
        keys.sort(function (a, b) { return count[b] - count[a]; });
        return { key: keys[0], count: count[keys[0]] };
    }

    function buildSummary(events) {
        if (!events || !events.length) return '';
        // 가장 빈번한 theme_tag (filled 사건 위주, fallback 전체)
        var filledEvents = events.filter(function (e) {
            return e.reason_status === 'filled' || e.reason_status === 'edited';
        });
        var sourceEvents = filledEvents.length ? filledEvents : events;
        var topTheme = topByFreq(sourceEvents, function (e) { return e.theme_tag || ''; });
        // 가장 빈번한 reason (missing / "52주 신고가 도달" 같은 placeholder 제외)
        var GENERIC = ['52주 신고가 도달', '상한가 — 사유 미수집', '-', ''];
        var topReason = topByFreq(filledEvents, function (e) {
            var r = e.rise_reason || '';
            if (GENERIC.indexOf(r) >= 0) return '';
            return r;
        });

        var parts = [];
        if (topTheme && topTheme.key) parts.push(topTheme.key);
        if (topReason && topReason.key) parts.push(topReason.key);
        if (!parts.length) {
            // 둘 다 없으면 sector 기반 폴백
            var topSector = topByFreq(events, function (e) { return e.sector || ''; });
            if (topSector && topSector.key) parts.push(topSector.key);
        }
        return parts.join(' · ');
    }

    function renderHeader(name, market, stats) {
        var $title = document.getElementById('stockTitle');
        var $market = document.getElementById('stockMarket');
        var $stats = document.getElementById('stockStats');
        var pageTitle = name + ' 왜 오름? — 이거왜오름?';
        var pageDesc = name + ' 이 최근 1년간 +15% 이상 오른 ' + (stats.count_15 || 0) + '회의 날짜와 이유·뉴스.';
        document.getElementById('pageTitle').textContent = pageTitle;
        document.getElementById('pageDesc').setAttribute('content', pageDesc);
        var ticker = getTicker() || '';
        var $can = document.getElementById('pageCanonical');
        if ($can && ticker) $can.setAttribute('href', 'https://whyrise.vercel.app/stock/' + ticker);
        var $ogT = document.getElementById('pageOgTitle');
        if ($ogT) $ogT.setAttribute('content', pageTitle);
        var $ogD = document.getElementById('pageOgDesc');
        if ($ogD) $ogD.setAttribute('content', pageDesc);

        $title.innerHTML = '<strong>' + esc(name) + '</strong> 왜 오름?';
        if (market) $market.textContent = market;
        _stockName = name;

        // 네이버 증권 바로가기 (PC 버전 finance.naver.com)
        var $naver = document.getElementById('stockNaverLink');
        if ($naver && ticker) {
            $naver.href = 'https://finance.naver.com/item/main.naver?code=' + ticker;
            $naver.style.display = '';
        }

        // 관심 별점 표시 (whyrise-ratings localStorage 와 동기화)
        if (ticker) renderHeaderRating(ticker);

        if (!stats) { $stats.innerHTML = ''; return; }
        var html = '';
        // 핵심 지표 우선 — count_10 (1년 총 횟수), count_15, count_recent (최근 30일)
        if (stats.count_10 != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">+10% 이상 (1년)</span>' +
                '<span class="stock-header__stat-value">' + stats.count_10 + '회</span></div>';
        }
        html += '<div class="stock-header__stat">' +
            '<span class="stock-header__stat-label">+15% 이상</span>' +
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
        if (stats.count_recent != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">최근 30일</span>' +
                '<span class="stock-header__stat-value">' + stats.count_recent + '회</span></div>';
        }
        if (stats.avg_rate != null) {
            html += '<div class="stock-header__stat">' +
                '<span class="stock-header__stat-label">평균 상승률</span>' +
                '<span class="stock-header__stat-value stock-header__stat-value--rise">+' +
                stats.avg_rate.toFixed(1) + '%</span></div>';
        }
        $stats.innerHTML = html;
    }

    function sourceBadge(source, confidence) {
        // reason_source: stockrise | admin | news | naver | theme | pattern | dart
        var labels = {
            'stockrise': { text: '검증', cls: 'badge--filled' },
            'admin':     { text: '관리자', cls: 'badge--admin' },
            'news':      { text: '뉴스', cls: 'badge--news' },
            'naver':     { text: '뉴스', cls: 'badge--news' },
            'theme':     { text: '테마', cls: 'badge--theme' },
            'pattern':   { text: '패턴', cls: 'badge--pattern' },
        };
        var info = labels[source];
        if (!info) return '';
        return '<span class="event-card__source-badge ' + info.cls + '">' + info.text + '</span>';
    }

    function reasonClass(status, confidence) {
        if (status === 'edited') return 'event-card__reason event-card__reason--edited';
        if (status === 'missing') return 'event-card__reason event-card__reason--missing';
        if (confidence === 'low') return 'event-card__reason event-card__reason--low';
        if (confidence === 'mid') return 'event-card__reason event-card__reason--mid';
        return 'event-card__reason event-card__reason--high';
    }

    function groupByYear(events) {
        // 50건 이상이면 연도별 그루핑, 아니면 단일 그룹
        if (!events.length) return [];
        if (events.length < 50) return [{ year: null, events: events }];
        var grouped = {};
        events.forEach(function (ev) {
            var y = (ev.date || '').slice(0, 4);
            if (!grouped[y]) grouped[y] = [];
            grouped[y].push(ev);
        });
        return Object.keys(grouped).sort().reverse().map(function (y) {
            return { year: y, events: grouped[y] };
        });
    }

    function safeLink(href) {
        // javascript:/data: 스킴 차단
        if (!href) return '';
        var s = String(href).trim();
        if (/^(javascript|data|vbscript):/i.test(s)) return '';
        return esc(s);
    }

    function renderEventCard(ev, ticker) {
        var newsHtml = '';
        if (ev.news && ev.news.length) {
            newsHtml += '<div class="event-card__news">';
            ev.news.slice(0, 5).forEach(function (n) {
                newsHtml += '<a href="' + safeLink(n.link) + '" target="_blank" rel="noopener noreferrer">' +
                    '<span>' + esc(n.title) + '</span>' +
                    (n.source ? '<span class="news-source">' + esc(n.source) + '</span>' : '') +
                    '</a>';
            });
            newsHtml += '</div>';
        }
        var rowClass = '';
        if (ev.reason_status === 'edited') rowClass = ' row--edited';
        else if (ev.reason_status === 'missing') rowClass = ' row--missing';
        var rate = (ev.change_rate || 0);
        var rateLabel = (rate >= 29.9) ? '<span class="event-card__limit">상한가</span>' : '';
        var hi52w = ev.is_52w_high ? '<span class="event-card__highflag">52주 신고가</span>' : '';
        var reasonText = ev.rise_reason || (ev.reason_status === 'missing'
            ? '이유 미수집 — 관리자가 채울 수 있습니다'
            : '-');

        return '<article class="event-card' + rowClass + '">' +
            '<div class="event-card__top">' +
            '<span class="event-card__date">' + formatDate(ev.date) + '</span>' +
            '<span class="event-card__rate">+' + rate.toFixed(2) + '%</span>' +
            rateLabel +
            hi52w +
            '<span class="event-card__price">종가 ' +
            (ev.close_price ? ev.close_price.toLocaleString('ko-KR') : '-') +
            '원</span>' +
            (ev.theme_tag ? '<span class="event-card__theme">' + esc(ev.theme_tag) + '</span>' : '') +
            sourceBadge(ev.reason_source, ev.reason_confidence) +
            '<button class="admin-edit-btn event-card__edit" data-action="admin-edit" data-ticker="' +
            esc(ticker) + '" data-date="' + esc(ev.date) + '" title="이유 편집">✏️ 편집</button>' +
            '</div>' +
            '<div class="' + reasonClass(ev.reason_status, ev.reason_confidence) + '">' +
            esc(reasonText) + '</div>' +
            newsHtml +
            '</article>';
    }

    function renderEvents(events, ticker) {
        var $tl = document.getElementById('timeline');
        if (!events || !events.length) {
            $tl.innerHTML = '<div class="event-empty">최근 1년간 +10% 이상 기록이 없습니다.</div>';
            return;
        }
        var groups = groupByYear(events);
        var html = '';
        groups.forEach(function (g) {
            if (g.year) {
                html += '<h2 class="timeline__year">' + g.year + '년 — ' + g.events.length + '건</h2>';
            }
            g.events.forEach(function (ev) {
                html += renderEventCard(ev, ticker);
            });
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

    // 관심 별점 + 메모 — localStorage 키는 메인(index.html) 의 whyrise.js 와 공유.
    var RATINGS_KEY = 'whyrise-ratings';
    var _stockName = '';

    function loadRatings() {
        try { return JSON.parse(localStorage.getItem(RATINGS_KEY) || '{}'); }
        catch (e) { return {}; }
    }
    function saveRatings(r) {
        try { localStorage.setItem(RATINGS_KEY, JSON.stringify(r)); } catch (e) {}
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(r);
    }

    function renderHeaderRating(ticker) {
        var $wrap = document.getElementById('stockHeaderRating');
        var $stars = document.getElementById('stockHeaderStars');
        var $memo = document.getElementById('stockHeaderMemoBtn');
        var $excl = document.getElementById('stockHeaderExcludeBtn');
        if (!$wrap || !$stars || !$memo || !$excl) return;
        var ratings = loadRatings();
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var hasMemo = !!(rating.memo && rating.memo.trim());
        var excluded = !!rating.excluded;
        var html = '';
        for (var i = 1; i <= 5; i++) {
            html += '<span class="star' + (i <= stars ? ' star--active' : '') + '" data-star="' + i + '" role="button" aria-label="별 ' + i + '점">★</span>';
        }
        $stars.innerHTML = html;
        $stars.setAttribute('data-ticker', ticker);
        $memo.setAttribute('data-ticker', ticker);
        $memo.classList.toggle('stock-header__rating-memo--has', hasMemo);
        $excl.setAttribute('data-ticker', ticker);
        $excl.classList.toggle('stock-header__rating-exclude--active', excluded);
        $wrap.removeAttribute('hidden');
    }

    function bindHeaderRating() {
        var $wrap = document.getElementById('stockHeaderRating');
        var $stars = document.getElementById('stockHeaderStars');
        var $memo = document.getElementById('stockHeaderMemoBtn');
        var $excl = document.getElementById('stockHeaderExcludeBtn');
        var $title = document.getElementById('stockTitle');
        if ($stars) {
            $stars.addEventListener('click', function (e) {
                var $s = e.target.closest('.star');
                if (!$s) return;
                var ticker = $stars.getAttribute('data-ticker');
                if (!ticker) return;
                var n = parseInt($s.getAttribute('data-star'), 10);
                var ratings = loadRatings();
                ratings[ticker] = ratings[ticker] || {};
                if (ratings[ticker].stars === n) ratings[ticker].stars = 0;
                else ratings[ticker].stars = n;
                saveRatings(ratings);
                renderHeaderRating(ticker);
            });
        }
        if ($excl) {
            $excl.addEventListener('click', function () {
                var ticker = $excl.getAttribute('data-ticker');
                if (!ticker) return;
                var ratings = loadRatings();
                ratings[ticker] = ratings[ticker] || {};
                ratings[ticker].excluded = !ratings[ticker].excluded;
                saveRatings(ratings);
                renderHeaderRating(ticker);
            });
        }
        if ($memo) {
            $memo.addEventListener('click', function () {
                var ticker = $memo.getAttribute('data-ticker');
                if (ticker) openMemo(ticker);
            });
        }
        // 모바일: 제목 탭하면 rating 토글 (CSS .is-open 매칭). 데스크톱은 항상 노출이라 무영향.
        if ($title && $wrap) {
            $title.addEventListener('click', function () {
                $wrap.classList.toggle('is-open');
            });
        }
    }

    function openMemo(ticker) {
        var $modal = document.getElementById('memoModal');
        var $title = document.getElementById('memoModalTitle');
        var $area = document.getElementById('memoTextarea');
        if (!$modal || !$area) return;
        var ratings = loadRatings();
        var rating = ratings[ticker] || {};
        if ($title) $title.textContent = (_stockName || ticker) + ' 메모';
        $area.value = rating.memo || '';
        $area.setAttribute('data-ticker', ticker);
        $modal.style.display = 'flex';
        setTimeout(function () { $area.focus(); }, 50);
    }

    function bindMemoModal() {
        var $modal = document.getElementById('memoModal');
        if (!$modal) return;
        var $close = document.getElementById('memoModalClose');
        var $save = document.getElementById('memoSave');
        var $del = document.getElementById('memoDelete');
        var $area = document.getElementById('memoTextarea');
        if ($close) $close.addEventListener('click', function () { $modal.style.display = 'none'; });
        $modal.addEventListener('click', function (e) { if (e.target === $modal) $modal.style.display = 'none'; });
        if ($save) $save.addEventListener('click', function () {
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            var ratings = loadRatings();
            ratings[ticker] = ratings[ticker] || {};
            ratings[ticker].memo = $area.value.trim();
            saveRatings(ratings);
            renderHeaderRating(ticker);
            $modal.style.display = 'none';
        });
        if ($del) $del.addEventListener('click', function () {
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            var ratings = loadRatings();
            if (ratings[ticker]) delete ratings[ticker].memo;
            saveRatings(ratings);
            renderHeaderRating(ticker);
            $modal.style.display = 'none';
        });
    }

    function init() {
        bindThemeToggle();
        bindNewsModal();
        bindHeaderRating();
        bindMemoModal();

        var ticker = getTicker();
        if (!ticker) {
            document.getElementById('stockTitle').textContent = '종목 코드가 없습니다';
            return;
        }

        // 서버 별점 동기화 — KV pull 후 머지되면 별점 다시 그림.
        if (window.WhyRatingsSync) {
            window.WhyRatingsSync.pull().then(function (result) {
                if (result && result.source === 'remote') renderHeaderRating(ticker);
            });
        }

        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'block';

        WhyAPI.getStockHistory(ticker).then(function (history) {
            $loading.style.display = 'none';
            if (!history) {
                // stock-history 미빌드 (1년간 +10% 미달 등) — 네이버 메타 즉석 fetch fallback
                fetch('/api/current-price?ticker=' + encodeURIComponent(ticker))
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (meta) {
                        var name = (meta && meta.name) || ticker;
                        var market = (meta && meta.market) || '';
                        renderHeader(name, market, {});
                        renderEvents([], ticker);
                        $msg.textContent = '최근 1년간 +10% 이상 급등 기록이 없는 종목입니다.';
                        $msg.style.display = 'block';
                    })
                    .catch(function () {
                        document.getElementById('stockTitle').innerHTML = '<strong>' + esc(ticker) + '</strong> 왜 오름?';
                        $msg.textContent = '종목 정보를 불러올 수 없습니다.';
                        $msg.style.display = 'block';
                    });
                return;
            }
            renderHeader(history.name || ticker, history.market || '', history.stats || {});
            var $sum = document.getElementById('stockSummary');
            if ($sum) {
                var summary = buildSummary(history.events || []);
                $sum.textContent = summary || '';
                $sum.style.display = summary ? 'block' : 'none';
            }
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
