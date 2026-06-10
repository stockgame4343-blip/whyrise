/**
 * 종목 페이지 — /stock/{ticker} (rewrite 로 ?ticker=... 도착)
 *
 * 인덱스 (public/data/stock-history/{ticker}.json) 에서 events 읽어 타임라인 렌더.
 * 관리자 모드일 때 각 event 카드 우측에 ✏️ 편집 버튼.
 */
(function () {
    // 현재가 라이브 — 장중 60초 폴링 (단일 종목 /api/current-price, marketmap 미포함 종목도 커버)
    var PRICE_POLL_MS = 60 * 1000;
    var KST_OFFSET = 9 * 60, OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 30;
    function isMarketOpenKST() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }

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
        var pageTitle = name + ' 왜 오름? - ORNO';
        var pageDesc = name + '의 최근 1년 급등 날짜와 이유·뉴스.';
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

    // 현재가·오늘 등락률 스탯 — stats 그리드 맨 앞에 삽입/갱신. '왜 오름?' 페이지에 '지금 얼마' 제공.
    function renderPriceStat(meta) {
        if (!meta || meta.price == null) return;
        var $stats = document.getElementById('stockStats');
        if (!$stats) return;
        var el = document.getElementById('stockPriceStat');
        if (!el) {
            el = document.createElement('div');
            el.className = 'stock-header__stat';
            el.id = 'stockPriceStat';
            $stats.insertBefore(el, $stats.firstChild);
        }
        var rate = Number(meta.change_rate || 0);
        var sign = rate > 0 ? '+' : '';
        var cls = rate > 0 ? ' stock-header__stat-value--rise' : '';
        el.innerHTML = '<span class="stock-header__stat-label">현재가' + (isMarketOpenKST() ? ' (라이브)' : '') + '</span>' +
            '<span class="stock-header__stat-value' + cls + '">' +
            Number(meta.price).toLocaleString('ko-KR') + '원 ' + sign + rate.toFixed(2) + '%</span>';
    }

    // 장중엔 60초 폴링, 마감 후엔 1회(=종가)로 종료. 탭 숨김 동안은 fetch 스킵.
    function startPricePolling(ticker) {
        function tick() {
            if (document.visibilityState === 'hidden') {
                setTimeout(tick, PRICE_POLL_MS);
                return;
            }
            WhyAPI.getCurrentPrice(ticker).then(function (meta) {
                renderPriceStat(meta);
            }).catch(function () {}).then(function () {
                if (isMarketOpenKST()) setTimeout(tick, PRICE_POLL_MS);
            });
        }
        tick();
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

    // 모바일에서 finance.naver.com/item/news_read.naver?... 는 네이버가 m.stock.naver.com 404
    // 페이지로 리다이렉트시킴. 모바일 UA 일 때만 n.news.naver.com/mnews/article 형식으로 변환.
    // PC 는 기존 finance.naver.com 페이지 그대로.
    function normalizeNewsLink(s) {
        if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return s;
        if (s.indexOf('finance.naver.com/item/news_read') < 0) return s;
        var a = /[?&]article_id=([0-9]+)/.exec(s);
        var o = /[?&]office_id=([0-9]+)/.exec(s);
        if (!a || !o) return s;
        return 'https://n.news.naver.com/mnews/article/' + o[1] + '/' + a[1];
    }
    function safeLink(href) {
        // javascript:/data: 스킴 차단
        if (!href) return '';
        var s = String(href).trim();
        if (/^(javascript|data|vbscript):/i.test(s)) return '';
        return esc(normalizeNewsLink(s));
    }

    var _newsDecodeBox = null;
    function cleanNewsText(s) {
        var text = String(s || '').trim();
        if (text.indexOf('&') >= 0 && typeof document !== 'undefined' && document.createElement) {
            _newsDecodeBox = _newsDecodeBox || document.createElement('textarea');
            _newsDecodeBox.innerHTML = text;
            text = _newsDecodeBox.value;
        }
        return text.replace(/\s+/g, ' ').trim();
    }

    function formatDateCompact(yyyymmdd) {
        var s = String(yyyymmdd || '');
        if (s.length !== 8) return s;
        return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6, 8);
    }

    function newsKeys(n) {
        var link = String((n && n.link) || '').trim().split('#')[0].split('?')[0].toLowerCase();
        var title = cleanNewsText((n && n.title) || '').toLowerCase().replace(/\s+/g, ' ');
        return { link: link, title: title };
    }

    function importantTokens() {
        var source = Array.prototype.slice.call(arguments).join(' ');
        return cleanNewsText(source).split(/[\s,·()"'“”‘’\[\]{}<>:;|/\\]+/).filter(function (token) {
            if (!token || token.length < 2) return false;
            if (/^[0-9.]+%?$/.test(token)) return false;
            return ['관련', '기대', '소식', '상승', '급등', '상한가', '특징주', '실시간', '거래량', '코스피', '코스닥'].indexOf(token) < 0;
        }).slice(0, 8);
    }

    function collectMajorNews(events, ticker) {
        var seen = {};
        var items = [];
        var name = cleanNewsText(_stockName || '').toLowerCase();
        (events || []).forEach(function (ev, eventIndex) {
            var tokens = importantTokens(ev.theme_tag, ev.sector, ev.rise_reason);
            (ev.news || []).forEach(function (n) {
                var keys = newsKeys(n);
                if ((!keys.link && !keys.title) || seen[keys.link] || seen[keys.title]) return;
                var title = cleanNewsText(n.title);
                var href = safeLink(n.link);
                if (!title || !href) return;
                var lowerTitle = title.toLowerCase();
                var score = Math.max(0, 200 - eventIndex) / 1000;
                var matched = false;
                if (name && lowerTitle.indexOf(name) >= 0) { score += 5; matched = true; }
                if (ticker && lowerTitle.indexOf(String(ticker).toLowerCase()) >= 0) { score += 3; matched = true; }
                tokens.forEach(function (token) {
                    if (token && lowerTitle.indexOf(token.toLowerCase()) >= 0) {
                        score += 1.5;
                        matched = true;
                    }
                });
                if (matched && (ev.reason_source === 'news' || ev.reason_source === 'naver')) score += 1;
                if (!matched || score < 3) return;
                if (keys.link) seen[keys.link] = true;
                if (keys.title) seen[keys.title] = true;
                items.push({
                    title: title,
                    href: href,
                    source: cleanNewsText(n.source),
                    date: ev.date || '',
                    score: score,
                });
            });
        });
        items.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return String(b.date).localeCompare(String(a.date));
        });
        return items.slice(0, 10);
    }

    function renderMajorNews(events, ticker) {
        var $panel = document.getElementById('stockNewsPanel');
        if (!$panel) return;
        var items = collectMajorNews(events, ticker);
        if (!items.length) {
            $panel.innerHTML = '';
            $panel.style.display = 'none';
            return;
        }
        var html = '<div class="stock-news-panel__head">' +
            '<h2>주요 기사</h2>' +
            '<span>핵심 기사만</span>' +
            '</div><div class="stock-news-list">';
        items.forEach(function (item) {
            html += '<a class="stock-news-item" href="' + item.href + '" target="_blank" rel="noopener noreferrer">' +
                '<span class="stock-news-item__meta">' +
                '<span>' + esc(formatDateCompact(item.date)) + '</span>' +
                (item.source ? '<span>' + esc(item.source) + '</span>' : '') +
                '</span>' +
                '<span class="stock-news-item__title">' + esc(item.title) + '</span>' +
                '</a>';
        });
        html += '</div>';
        $panel.innerHTML = html;
        $panel.style.display = 'block';
    }

    function renderEventCard(ev, ticker) {
        var rowClass = '';
        if (ev.reason_status === 'edited') rowClass = ' row--edited';
        else if (ev.reason_status === 'missing') rowClass = ' row--missing';
        var rate = (ev.change_rate || 0);
        var rateLabel = (rate >= 29.9) ? '<span class="event-card__limit">상한가</span>' : '';
        var hi52w = ev.is_52w_high ? '<span class="event-card__highflag">52주 신고가</span>' : '';
        var reasonText = (ev.reason_status === 'missing') ? '' : (ev.rise_reason || '');
        var reasonHtml = reasonText
            ? '<div class="' + reasonClass(ev.reason_status, ev.reason_confidence) + '">' + esc(reasonText) + '</div>'
            : '';

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
            reasonHtml +
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
    var _ratings = {};
    var _headerRatingSuppressTimer = null;

    function loadRatings() {
        _ratings = window.WhyRatingsSync ? window.WhyRatingsSync.getCached() : _ratings;
        return _ratings || {};
    }
    function saveRatings(r) {
        _ratings = r || {};
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(_ratings);
    }
    function requirePersonal(feature) {
        if (!window.WhyAuth || window.WhyAuth.personalAllowed()) return true;
        window.WhyAuth.requireLogin(feature);
        return false;
    }

    function suppressHeaderRatingHover() {
        var $mount = document.getElementById('stockHeaderRating');
        if (!$mount) return;
        var wrap = $mount.querySelector('.ctrl-wrap');
        if (!wrap) return;
        var row = $mount.closest('.stock-header__title-row');
        wrap.classList.add('ctrl-wrap--just-acted');
        if (_headerRatingSuppressTimer) clearTimeout(_headerRatingSuppressTimer);
        var release = function () {
            wrap.classList.remove('ctrl-wrap--just-acted');
        };
        _headerRatingSuppressTimer = setTimeout(release, 2000);
        if (row) row.addEventListener('mouseleave', release, { once: true });
    }

    /** 메인 홈(table.js starRatingHtml) 과 동일한 HTML 구조 — 호버/탭 동작 메인과 통일. */
    function renderHeaderRating(ticker) {
        var $mount = document.getElementById('stockHeaderRating');
        if (!$mount) return;
        var ratings = loadRatings();
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var hasMemo = !!(rating.memo && rating.memo.trim());
        var excluded = !!rating.excluded;
        var html = '<span class="ctrl-wrap">';
        html += '<button class="ctrl-toggle" type="button" data-ticker="' + ticker + '" aria-label="평가">⋯</button>';
        html += '<div class="float-controls" data-ticker="' + ticker + '">';
        html += '<span class="star-rating" data-ticker="' + ticker + '">';
        for (var i = 1; i <= 5; i++) {
            html += '<span class="star' + (i <= stars ? ' star--active' : '') + '" data-star="' + i + '">★</span>';
        }
        html += '</span>';
        html += '<button class="exclude-btn' + (excluded ? ' exclude-btn--active' : '') + '" data-ticker="' + ticker + '" title="제외">✕</button>';
        html += '<button class="memo-btn' + (hasMemo ? ' memo-btn--has' : '') + '" data-ticker="' + ticker + '" title="메모">✎</button>';
        html += '</div></span>';
        $mount.innerHTML = html;
        $mount.removeAttribute('hidden');
    }

    /** 마운트 안에서 메인 whyrise.js bindRatingsEvents 와 동일한 이벤트 위임. */
    function bindHeaderRating() {
        var $mount = document.getElementById('stockHeaderRating');
        if (!$mount) return;
        $mount.addEventListener('click', function (e) {
            var ticker = getTicker();
            if (!ticker) return;
            // 별점
            var star = e.target.closest('.star');
            if (star) {
                e.preventDefault();
                e.stopPropagation();
                if (!requirePersonal('interest')) {
                    suppressHeaderRatingHover();
                    return;
                }
                var n = parseInt(star.getAttribute('data-star'), 10);
                if (!n) return;
                var ratings = loadRatings();
                ratings[ticker] = ratings[ticker] || {};
                if (ratings[ticker].stars === n) ratings[ticker].stars = 0;
                else ratings[ticker].stars = n;
                saveRatings(ratings);
                renderHeaderRating(ticker);
                suppressHeaderRatingHover();
                return;
            }
            // 제외
            var ex = e.target.closest('.exclude-btn');
            if (ex) {
                e.preventDefault();
                e.stopPropagation();
                if (!requirePersonal('exclude')) {
                    suppressHeaderRatingHover();
                    return;
                }
                var r2 = loadRatings();
                r2[ticker] = r2[ticker] || {};
                r2[ticker].excluded = !r2[ticker].excluded;
                saveRatings(r2);
                renderHeaderRating(ticker);
                suppressHeaderRatingHover();
                return;
            }
            // 메모
            var memo = e.target.closest('.memo-btn');
            if (memo) {
                e.preventDefault();
                e.stopPropagation();
                suppressHeaderRatingHover();
                if (!requirePersonal('memo')) return;
                openMemo(ticker);
                return;
            }
            // 모바일 ⋯ 토글
            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                e.preventDefault();
                e.stopPropagation();
                var wrap = toggle.closest('.ctrl-wrap');
                if (!wrap) return;
                wrap.classList.toggle('is-open');
                return;
            }
        });
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
            if (!requirePersonal('memo')) return;
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
            if (!requirePersonal('memo')) return;
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
        window.addEventListener('whyrise:ratings-updated', function (e) {
            _ratings = (e.detail && e.detail.ratings) || {};
            var current = getTicker();
            if (current) renderHeaderRating(current);
        });

        var ticker = getTicker();
        if (!ticker) {
            document.getElementById('stockTitle').textContent = '종목 코드가 없습니다';
            return;
        }

        // 서버 별점 동기화 — KV pull 후 머지되면 별점 다시 그림.
        if (window.WhyRatingsSync) {
            window.WhyRatingsSync.pull().then(function (result) {
                if (result && result.ratings) {
                    _ratings = result.ratings;
                    renderHeaderRating(ticker);
                }
            });
        }

        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        $loading.style.display = 'block';

        WhyAPI.getStockHistory(ticker).then(function (history) {
            $loading.style.display = 'none';
            if (!history) {
                // stock-history 미빌드 (1년간 +10% 미달 등) — 네이버 메타 즉석 fetch fallback
                WhyAPI.getCurrentPrice(ticker)
                    .then(function (meta) {
                        var name = (meta && meta.name) || ticker;
                        var market = (meta && meta.market) || '';
                        // stats 는 null — '+15% 0회' 한 줄만 덩그러니 렌더되는 것 방지
                        renderHeader(name, market, null);
                        renderEvents([], ticker);
                        // 이미 받아온 라이브 시세를 그대로 표시 + 장중이면 폴링 지속
                        renderPriceStat(meta);
                        if (isMarketOpenKST()) startPricePolling(ticker);
                        $msg.textContent = '최근 1년간 +10% 이상 급등 기록이 없는 종목입니다.';
                        $msg.style.display = 'block';
                    })
                    .catch(function () {
                        // API 실패는 '기록 없음' 과 구분 — 정상 종목을 기록 없음으로 오인시키지 않음
                        document.getElementById('stockTitle').innerHTML = '<strong>' + esc(ticker) + '</strong> 왜 오름?';
                        $msg.textContent = '종목 정보를 불러오지 못했습니다. 잠시 후 새로고침 해주세요.';
                        $msg.style.display = 'block';
                    });
                return;
            }
            renderHeader(history.name || ticker, history.market || '', history.stats || {});
            startPricePolling(ticker);   // 현재가 스탯 — 장중 60초 폴링, 마감 후 1회(종가)
            renderMajorNews(history.events || [], ticker);
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
