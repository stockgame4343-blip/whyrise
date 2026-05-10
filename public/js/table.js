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
        ratings = ratings || {};
        opts = opts || {};
        var date = opts.date || '';

        if (!rankings || rankings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:60px;color:var(--text-muted);">' +
                '오늘 컷오프 이상 오른 종목이 없습니다 — 컷을 낮춰보세요.</td></tr>';
            return;
        }

        var html = '';
        rankings.forEach(function (r) {
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
            // # rank — change_rate 정렬 후 1-base 인덱스
            html += '<td class="cell-rank">' + (r._displayRank != null ? r._displayRank : '') + '</td>';
            // 종목명
            html += '<td class="cell-name"><div class="cell-name__wrap">' +
                '<a href="' + detailUrl + '" class="cell-name__link" data-ticker="' + r.ticker + '">' + r.name + '</a>' +
                miniIndicatorsHtml(r.ticker, ratings) +
                '<span class="cell-name__market">' + r.market + '</span>' +
                starRatingHtml(r.ticker, ratings) +
                '</div></td>';
            // 이유 (hero)
            var rawTag = r.theme_tag || '';
            var displayTag = shortenTheme(rawTag);
            var reason = r.rise_reason || '-';
            var editBtn = '<button class="admin-edit-btn" data-action="admin-edit" data-ticker="' + r.ticker +
                '" data-date="' + date + '" title="이유 편집">✏️ 편집</button>';
            html += '<td class="cell-reason">' +
                (displayTag ? '<span class="theme-tag">' + displayTag + '</span>' : '') +
                '<span class="cell-reason__text">' + reason + '</span>' +
                editBtn +
                '</td>';
            // 상승률
            html += '<td class="cell-change">' + formatChangeRate(r.change_rate) + '</td>';
            // 거래대금
            html += '<td class="cell-volume">' + formatAmount(r.trading_value) + '</td>';
            // 섹터
            html += '<td class="cell-sector">' + (r.sector || '-') + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    return {
        render: render,
        openNews: openNews,
        closeNews: closeNews,
        formatAmount: formatAmount,
        formatChangeRate: formatChangeRate,
    };
})();
