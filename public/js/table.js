/**
 * 테이블 렌더링 — whyrise 변형 (이유를 hero 컬럼으로, 점수 제거).
 *
 * stock-rise table.js 를 베이스로:
 *  - reason 을 첫 번째 컨텐츠 컬럼(종목명 다음)에 hero 스타일로
 *  - 시가총액 컬럼 제거 (공간 확보)
 *  - 대장점수 컬럼 제거
 *  - localStorage 키 (간접) — ratings 는 whyrise.js 가 관리
 *  - 관리자 모드(✏️) 행 우측 표시 — admin.js 가 활성화
 */
var WhyTable = (function () {

    var _currentData = [];
    var _lastRatings = {};
    var _lastOpts = {};
    /** 정렬 상태 — key: 'change'|'volume'|'cap'|'sector'|'reason', dir: 'asc'|'desc'. 기본: change desc (서버 순서) */
    var _sort = { key: null, dir: 'desc' };

    /** 정렬 적용 — _currentData 를 정렬한 사본 반환. key=null 이면 원본 순서. */
    function applySort(rows) {
        if (!_sort.key) return rows.slice();
        var key = _sort.key;
        var arr = rows.slice();
        // name 키 — dir: 'asc' 가나다 / 'desc' 가나다 역 / 'market-asc' KOSPI 먼저+가나다 / 'market-desc' KOSDAQ 먼저+가나다
        if (key === 'name') {
            var marketSort = (_sort.dir === 'market-asc' || _sort.dir === 'market-desc');
            var marketDir = (_sort.dir === 'market-asc') ? 1 : -1;
            arr.sort(function (a, b) {
                if (marketSort) {
                    var ma = (a.market === 'KOSPI') ? 0 : 1;
                    var mb = (b.market === 'KOSPI') ? 0 : 1;
                    if (ma !== mb) return (ma - mb) * marketDir;
                }
                var na = (a.name || '').trim();
                var nb = (b.name || '').trim();
                if (na === nb) return 0;
                var nameDir = (_sort.dir === 'desc') ? -1 : 1;
                return (na.localeCompare(nb, 'ko-KR')) * nameDir;
            });
            return arr;
        }
        var dir = _sort.dir === 'asc' ? 1 : -1;
        arr.sort(function (a, b) {
            var va, vb;
            if (key === 'change')      { va = a.change_rate;  vb = b.change_rate; }
            else if (key === 'volume') { va = a.trading_value; vb = b.trading_value; }
            else if (key === 'cap')    { va = a.market_cap;   vb = b.market_cap; }
            else if (key === 'sector') {
                va = (a.sector || '').trim();
                vb = (b.sector || '').trim();
                if (va < vb) return -1 * dir;
                if (va > vb) return  1 * dir;
                return (b.change_rate || 0) - (a.change_rate || 0);
            }
            else if (key === 'reason') {
                // 태그(theme_tag) 우선, 동률은 rise_reason 알파벳 순
                var ta = (a.theme_tag || '').trim();
                var tb = (b.theme_tag || '').trim();
                if (ta !== tb) {
                    // 빈 태그는 항상 뒤로
                    if (!ta) return 1;
                    if (!tb) return -1;
                    return (ta < tb ? -1 : 1) * dir;
                }
                var ra = (a.rise_reason || '').trim();
                var rb = (b.rise_reason || '').trim();
                if (ra !== rb) {
                    if (!ra) return 1;
                    if (!rb) return -1;
                    return (ra < rb ? -1 : 1) * dir;
                }
                return 0;
            }
            else { va = 0; vb = 0; }
            va = (va == null) ? -Infinity : va;
            vb = (vb == null) ? -Infinity : vb;
            return (va - vb) * dir;
        });
        return arr;
    }

    function shortenTheme(name, maxLen) {
        if (!name) return name;
        maxLen = maxLen || 14;
        var short = name.replace(/\(.*?\)/g, '').trim();
        if (!short) return name;
        if (short.length > maxLen) short = short.substring(0, maxLen) + '…';
        return short;
    }

    function formatNumber(n) {
        if (n == null) return '-';
        return n.toLocaleString('ko-KR');
    }

    function formatAmount(n) {
        if (n == null || n === 0) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8) + '억';
        if (n >= 1e4) return Math.round(n / 1e4) + '만';
        return formatNumber(n);
    }

    function formatChangeRate(rate) {
        if (rate == null) return '-';
        var sign = rate >= 0 ? '+' : '';
        var arrow = rate >= 0 ? '▲' : '▼';
        var cls = rate >= 0 ? 'cell-change--up' : 'cell-change--down';
        return '<span class="' + cls + '">' + arrow + sign + rate.toFixed(2) + '%</span>';
    }

    function starRatingHtml(ticker, ratings) {
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var excluded = rating.excluded || false;
        var hasMemo = rating.memo ? true : false;

        var html = '<span class="ctrl-wrap">';
        html += '<button class="ctrl-toggle" type="button" data-ticker="' +
            ticker + '" aria-label="평가">⋯</button>';
        html += '<div class="float-controls" data-ticker="' + ticker + '">';
        html += '<span class="star-rating" data-ticker="' + ticker + '">';
        for (var i = 1; i <= 5; i++) {
            html += '<span class="star' + (i <= stars ? ' star--active' : '') +
                '" data-star="' + i + '">★</span>';
        }
        html += '</span>';
        html += '<button class="exclude-btn' + (excluded ? ' exclude-btn--active' : '') +
            '" data-ticker="' + ticker + '" title="제외">✕</button>';
        html += '<button class="memo-btn' + (hasMemo ? ' memo-btn--has' : '') +
            '" data-ticker="' + ticker + '" title="메모">✎</button>';
        html += '</div></span>';
        return html;
    }

    function miniIndicatorsHtml(ticker, ratings) {
        var rating = ratings[ticker] || {};
        var stars = rating.stars || 0;
        var excluded = rating.excluded || false;
        var hasMemo = rating.memo ? true : false;
        if (!(stars > 0 || excluded || hasMemo)) return '';
        var html = '<span class="mini-indicators">';
        if (stars > 0) html += '<span class="mini-star">★' + stars + '</span>';
        if (excluded) html += '<span class="mini-exclude">✕</span>';
        if (hasMemo) html += '<span class="mini-memo">✎</span>';
        html += '</span>';
        return html;
    }

    function openNews(ticker) {
        var stock = null;
        for (var i = 0; i < _currentData.length; i++) {
            if (_currentData[i].ticker === ticker) { stock = _currentData[i]; break; }
        }
        var $modal = document.getElementById('newsModal');
        var $title = document.getElementById('newsModalTitle');
        var $body = document.getElementById('newsModalBody');
        if (!$modal || !$title || !$body) return;
        $title.textContent = (stock ? stock.name : ticker) + ' 관련 뉴스';
        if (!stock || !stock.news || stock.news.length === 0) {
            $body.innerHTML = '<div class="news-empty">관련 뉴스가 없습니다</div>';
        } else {
            var html = '';
            stock.news.forEach(function (n) {
                html += '<div class="news-item">' +
                    '<a class="news-item__title" href="' + n.link + '" target="_blank" rel="noopener">' + n.title + '</a>' +
                    '<span class="news-item__meta">' +
                    (n.source ? '<span class="news-item__source">' + n.source + '</span>' : '') +
                    (n.date ? '<span class="news-item__date">' + n.date + '</span>' : '') +
                    '</span></div>';
            });
            $body.innerHTML = html;
        }
        $modal.style.display = 'flex';
    }

    function closeNews() {
        var $modal = document.getElementById('newsModal');
        if ($modal) $modal.style.display = 'none';
    }

    function render(rankings, ratings, opts) {
        var tbody = document.getElementById('rankingBody');
        if (!tbody) return;
        _currentData = rankings;
        _lastRatings = ratings || {};
        _lastOpts = opts || {};
        ratings = _lastRatings;
        opts = _lastOpts;
        var date = opts.date || '';

        // 정렬 헤더 인디케이터 갱신
        updateSortIndicators();

        if (!rankings || rankings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:60px;color:var(--text-muted);">' +
                '오늘 +15% 이상 오른 종목이 없습니다.</td></tr>';
            return;
        }

        var sortedRows = applySort(rankings);
        var html = '';
        sortedRows.forEach(function (r) {
            var detailUrl = '/stock/' + r.ticker;
            var ratingData = ratings[r.ticker] || {};
            var isExcluded = ratingData.excluded || false;
            var isStarred = (ratingData.stars || 0) > 0;
            var isLimitUp = (r.change_rate != null && r.change_rate >= 29.9);
            var isEdited = r._edited || false;
            var rowClasses = [];
            if (isExcluded) rowClasses.push('row--excluded');
            if (isStarred) rowClasses.push('row--starred');
            if (isLimitUp) rowClasses.push('row--limit-up');
            if (isEdited) rowClasses.push('row--edited');

            html += '<tr' + (rowClasses.length ? ' class="' + rowClasses.join(' ') + '"' : '') + ' data-ticker="' + r.ticker + '">';
            // # rank
            html += '<td class="cell-rank">' + (r._displayRank != null ? r._displayRank : '') + '</td>';
            // 종목명
            html += '<td class="cell-name"><div class="cell-name__wrap">' +
                '<a href="' + detailUrl + '" class="cell-name__link" data-ticker="' + r.ticker + '">' + r.name + '</a>' +
                miniIndicatorsHtml(r.ticker, ratings) +
                '<span class="cell-name__market">' + r.market + '</span>' +
                starRatingHtml(r.ticker, ratings) +
                '</div></td>';
            // 이유 (hero) — 태그·이유·편집 모두 한 줄에
            var rawTag = r.theme_tag || '';
            var displayTag = shortenTheme(rawTag);
            var reason = r.rise_reason || '-';
            var editBtn = '<button class="admin-edit-btn" data-action="admin-edit" data-ticker="' + r.ticker +
                '" data-date="' + date + '" title="이유 편집">✏️</button>';
            html += '<td class="cell-reason">' +
                '<div class="cell-reason__inline">' +
                (displayTag ? '<span class="theme-tag">' + displayTag + '</span>' : '') +
                '<span class="cell-reason__text">' + reason + '</span>' +
                editBtn +
                '</div></td>';
            // 상승률
            html += '<td class="cell-change">' + formatChangeRate(r.change_rate) + '</td>';
            // 거래대금
            html += '<td class="cell-volume">' + formatAmount(r.trading_value) + '</td>';
            // 시가총액
            html += '<td class="cell-cap">' + formatAmount(r.market_cap) + '</td>';
            // 섹터
            html += '<td class="cell-sector">' + (r.sector || '-') + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    /** 헤더 인디케이터(▲▼) 업데이트 — 활성 컬럼만 표시. */
    function updateSortIndicators() {
        var ths = document.querySelectorAll('th.th-sort');
        for (var i = 0; i < ths.length; i++) {
            var th = ths[i];
            var key = th.getAttribute('data-sort-key');
            var ind = th.querySelector('.sort-ind');
            if (key === _sort.key) {
                th.classList.add('th-sort--active');
                if (ind) ind.textContent = indicatorText(key, _sort.dir);
            } else {
                th.classList.remove('th-sort--active');
                if (ind) ind.textContent = '';
            }
        }
    }

    function indicatorText(key, dir) {
        if (key === 'name') {
            if (dir === 'asc') return '가↑';
            if (dir === 'desc') return '가↓';
            if (dir === 'market-asc') return 'K↑';
            if (dir === 'market-desc') return 'D↑';
        }
        return dir === 'asc' ? '▲' : '▼';
    }

    /** name 키 4-state cycle: asc → desc → market-asc → market-desc → asc. */
    function nextNameDir(cur) {
        if (cur === 'asc') return 'desc';
        if (cur === 'desc') return 'market-asc';
        if (cur === 'market-asc') return 'market-desc';
        return 'asc';
    }

    /** 헤더 클릭 → 정렬 키 토글 + 리렌더. */
    function bindHeaderSort() {
        var table = document.getElementById('rankingTable');
        if (!table) return;
        var thead = table.querySelector('thead');
        if (!thead) return;
        thead.addEventListener('click', function (e) {
            // # 컬럼 클릭 — 정렬 초기화 (원래 1,2,3 순)
            var resetTh = e.target.closest('th.th-rank-reset');
            if (resetTh) {
                _sort.key = null;
                _sort.dir = 'desc';
                render(_currentData, _lastRatings, _lastOpts);
                return;
            }
            var th = e.target.closest('th.th-sort');
            if (!th) return;
            var key = th.getAttribute('data-sort-key');
            if (!key) return;
            if (_sort.key === key) {
                if (key === 'name') _sort.dir = nextNameDir(_sort.dir);
                else _sort.dir = _sort.dir === 'desc' ? 'asc' : 'desc';
            } else {
                _sort.key = key;
                if (key === 'name') _sort.dir = 'asc';
                else if (key === 'sector' || key === 'reason') _sort.dir = 'asc';
                else _sort.dir = 'desc';
            }
            render(_currentData, _lastRatings, _lastOpts);
        });
    }
    document.addEventListener('DOMContentLoaded', bindHeaderSort);

    return {
        render: render,
        openNews: openNews,
        closeNews: closeNews,
        formatAmount: formatAmount,
        formatChangeRate: formatChangeRate,
    };
})();
