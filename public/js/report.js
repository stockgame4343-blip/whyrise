/**
 * 리포트 페이지 — 일별 시황 (/report.html)
 *
 * stock-rise raw URL 일별 데이터(rankings + pullbacks) + whyrise 자체 cards/index.json.
 * 별점·메모는 localStorage `whyrise-ratings` + WhyRatingsSync 로 다른 페이지와 공유.
 */
var WhyReport = (function () {
    'use strict';

    var STORAGE_KEY = 'whyrise-ratings';
    var THEME_KEY = 'theme';
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    // 풀백 사용자 필터 임계값
    var PB_PEAK_MIN = 15;       // 피크 상승률 ≥15%
    var PB_DROP_MIN = 20;       // 고점 대비 낙폭 ≥20%
    var PB_BOUNCE_MIN = 15;     // 저점 대비 반등 ≥15%

    // 섹터·테마 카드 표시 수: Whyrise 리포트는 한 줄 4개를 기본 밀도로 사용.
    var CARDS_PER_PAGE_PC = 4;
    var CARDS_PER_PAGE_MOBILE = 4;
    var SECTOR_THEME_TOP_TICKERS = 2;

    var CARDS_TYPE_LABEL = { pre: '장전', leader: '주도주', closing: '장마감', close: '장마감' };

    var state = {
        dates: [],
        dateIndex: 0,
        day: null,           // { rankings, pullbacks, collected_at, ... }
        cardsIndex: null,
        cardsList: [],
        cardsModalIdx: 0,
        ratings: {},
        sectorPage: 0,
        themePage: 0,
    };

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmt(n) { return (n != null && !isNaN(n)) ? Number(n).toLocaleString('ko-KR') : '-'; }

    function pct(n) {
        if (n == null || isNaN(n)) return '-';
        return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
    }

    function fmtAmount(n) {
        if (n == null || n === 0) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8) + '억';
        if (n >= 1e4) return Math.round(n / 1e4) + '만';
        return n.toLocaleString('ko-KR');
    }

    function formatDate(yyyymmdd) {
        if (!yyyymmdd || String(yyyymmdd).length !== 8) return String(yyyymmdd || '-');
        var s = String(yyyymmdd);
        var y = s.slice(0, 4), m = parseInt(s.slice(4, 6), 10), d = parseInt(s.slice(6, 8), 10);
        var DAYS = ['일','월','화','수','목','금','토'];
        var dt = new Date(+y, m - 1, d);
        return y + '.' + s.slice(4, 6) + '.' + s.slice(6, 8) + ' (' + DAYS[dt.getDay()] + ')';
    }

    function formatTimestamp(value) {
        if (!value) return '';
        var s = String(value).trim();
        var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
        if (!m) return s.replace('T', ' ').substring(0, 16);
        return m[1] + '.' + m[2] + '.' + m[3] + ' ' + m[4] + ':' + m[5];
    }

    function setUpdatedAt(value) {
        var el = $('reportUpdatedAt');
        if (!el) return;
        el.textContent = formatTimestamp(value);
    }

    function screeningUrl(type, key) {
        var params = ['cnt=count_10', 'min=1'];
        if (type === 'sector') params.push('sector=' + encodeURIComponent(key));
        if (type === 'theme') params.push('theme=' + encodeURIComponent(key));
        return '/screening.html?' + params.join('&');
    }

    function shortDate(yyyymmdd) {
        if (!yyyymmdd || String(yyyymmdd).length !== 8) return '-';
        var s = String(yyyymmdd);
        return s.slice(4, 6) + '.' + s.slice(6, 8);
    }

    function themeOf(row) {
        if (!row) return '';
        if (row.theme_tag) return row.theme_tag;
        if (Array.isArray(row.theme_tags) && row.theme_tags.length) return row.theme_tags[0] || '';
        return '';
    }

    function reasonOf(row) {
        if (!row) return '';
        return row.rise_reason || row.reason || row.latest_reason || '';
    }

    function peakRateFromReason(reason) {
        var m = /\+(\d+(?:\.\d+)?)%/.exec(reason || '');
        return m ? parseFloat(m[1]) : 0;
    }

    function normalizedBouncePct(pb) {
        var raw = Number((pb && pb.bouncePct) || 0);
        return raw <= 1 ? raw * 100 : raw;
    }

    function isMobile() {
        return window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    }

    // ─── 별점·메모 ────────────────────────────────────

    function loadRatings() {
        try { state.ratings = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch (e) { state.ratings = {}; }
    }
    function saveRatings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.ratings)); }
        catch (e) {}
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(state.ratings);
    }

    function starRatingHtml(ticker) {
        var r = state.ratings[ticker] || {};
        var stars = r.stars || 0;
        var excluded = !!r.excluded;
        var hasMemo = !!r.memo;
        var t = esc(ticker);
        var html = '<span class="ctrl-wrap">';
        html += '<button class="ctrl-toggle" type="button" data-ticker="' + t + '" aria-label="평가">⋯</button>';
        html += '<div class="float-controls" data-ticker="' + t + '">';
        html += '<span class="star-rating" data-ticker="' + t + '">';
        for (var i = 1; i <= 5; i++) {
            html += '<span class="star' + (i <= stars ? ' star--active' : '') + '" data-star="' + i + '">★</span>';
        }
        html += '</span>';
        html += '<button class="exclude-btn' + (excluded ? ' exclude-btn--active' : '') + '" data-ticker="' + t + '" title="제외">✕</button>';
        html += '<button class="memo-btn' + (hasMemo ? ' memo-btn--has' : '') + '" data-ticker="' + t + '" title="메모">✎</button>';
        html += '</div></span>';
        return html;
    }

    function miniIndicatorsHtml(ticker) {
        var r = state.ratings[ticker] || {};
        var stars = r.stars || 0;
        var excluded = !!r.excluded;
        var hasMemo = !!r.memo;
        if (!(stars > 0 || excluded || hasMemo)) return '';
        var html = '<span class="mini-indicators">';
        if (stars > 0) html += '<span class="mini-star">★' + stars + '</span>';
        if (excluded) html += '<span class="mini-exclude">✕</span>';
        if (hasMemo) html += '<span class="mini-memo">✎</span>';
        html += '</span>';
        return html;
    }

    // ─── 데이터 derive ────────────────────────────────

    function deriveSummary(rankings) {
        var count = rankings.length;
        var sumRate = 0, limit = 0, volume = 0;
        for (var i = 0; i < rankings.length; i++) {
            var r = rankings[i];
            sumRate += Number(r.change_rate || 0);
            if (Number(r.change_rate || 0) >= 29.9) limit++;
            volume += Number(r.trading_value || 0);
        }
        return {
            count: count,
            avg_rate: count ? sumRate / count : 0,
            limit: limit,
            volume: volume,
        };
    }

    function deriveGroups(rankings, getKey) {
        var groups = {};
        for (var i = 0; i < rankings.length; i++) {
            var r = rankings[i];
            if (BLOCKED_TICKERS[r.ticker]) continue;
            var key = getKey(r);
            if (!key) continue;
            var rate = Number(r.change_rate || 0);
            if (!groups[key]) {
                groups[key] = { key: key, count: 0, sum_rate: 0, tickers: [] };
            }
            groups[key].count++;
            groups[key].sum_rate += rate;
            groups[key].tickers.push(r);
        }
        var out = Object.keys(groups).map(function (k) {
            var g = groups[k];
            // 상승률 desc 상위 3 종목
            g.tickers.sort(function (a, b) {
                return Number(b.change_rate || 0) - Number(a.change_rate || 0);
            });
            g.top = g.tickers.slice(0, SECTOR_THEME_TOP_TICKERS);
            g.avg_rate = g.count ? g.sum_rate / g.count : 0;
            return g;
        });
        out.sort(function (a, b) { return b.sum_rate - a.sum_rate || b.count - a.count; });
        return out;
    }

    function deriveSectors(rankings) {
        return deriveGroups(rankings, function (r) { return (r.sector || '').trim(); });
    }
    function deriveThemes(rankings) {
        return deriveGroups(rankings, function (r) {
            var t = (r.theme_tag || '').trim();
            if (t) return t;
            if (Array.isArray(r.theme_tags) && r.theme_tags.length) {
                return String(r.theme_tags[0] || '').trim();
            }
            return '';
        });
    }

    function deriveHigh52w(rankings, date) {
        var out = [];
        for (var i = 0; i < rankings.length; i++) {
            var r = rankings[i];
            if (!r || BLOCKED_TICKERS[r.ticker]) continue;
            var high52 = Number(r.high_52w || 0);
            var dayHigh = Number(r.high_price || r.close_price || 0);
            if (!high52 || !dayHigh) continue;
            if (!date || String(r.high_52w_date || '') !== String(date)) continue;
            out.push(Object.assign({}, r, {
                _high52GapPct: 0,
                _high52IsNew: true,
            }));
        }
        out.sort(function (a, b) {
            return Number(b.change_rate || 0) - Number(a.change_rate || 0);
        });
        return out;
    }

    function derivePullbacks(pullbacks) {
        if (!Array.isArray(pullbacks)) return [];
        return pullbacks.filter(function (pb) {
            if (!pb || BLOCKED_TICKERS[pb.ticker]) return false;
            if (pb.bounceBack !== true) return false;
            var dropPct = Number(pb.dropPct || 0);
            var bouncePct = Number(pb.bouncePct || 0);
            if (dropPct < PB_DROP_MIN) return false;
            if (bouncePct < PB_BOUNCE_MIN / 100 && bouncePct < PB_BOUNCE_MIN) {
                // bouncePct 는 0~1 (소수) 또는 0~100 (백분율) 두 형식 가능 — 양쪽 모두 컷
                return false;
            }
            var peakRate = peakRateFromReason(pb.reason);
            if (peakRate < PB_PEAK_MIN) return false;
            return true;
        }).sort(function (a, b) {
            return Number(b.bouncePct || 0) - Number(a.bouncePct || 0);
        });
    }

    // ─── 렌더 ────────────────────────────────────────

    function renderSummary(s) {
        if (!$('sumCount')) return;
        $('sumCount').textContent = fmt(s.count);
        $('sumAvgRate').textContent = pct(s.avg_rate);
        $('sumLimit').textContent = fmt(s.limit);
        $('sumVolume').textContent = fmtAmount(s.volume);
    }

    function getPageSize() {
        return isMobile() ? CARDS_PER_PAGE_MOBILE : CARDS_PER_PAGE_PC;
    }

    function renderGroupCards(groups, gridId, pagerId, pageKey, label, screeningType) {
        var $grid = $(gridId);
        var $pager = $(pagerId);
        if (!$grid) return;
        if (!groups.length) {
            $grid.innerHTML = '<div class="report-empty">' + label + ' 정보가 부족합니다.</div>';
            if ($pager) $pager.textContent = '';
            return;
        }
        var size = getPageSize();
        var totalPages = Math.max(1, Math.ceil(groups.length / size));
        var page = Math.min(state[pageKey] || 0, totalPages - 1);
        state[pageKey] = page;
        var slice = groups.slice(page * size, (page + 1) * size);

        var html = slice.map(function (g) {
            var topHtml = g.top.map(function (r) {
                var t = esc(r.ticker);
                return '<a class="report-card-stock" href="/stock/' + t + '" data-ticker="' + t + '">' +
                    '<span class="report-card-stock__name">' + esc(r.name) + '</span>' +
                    '<span class="report-card-stock__rate ' +
                    (Number(r.change_rate || 0) >= 0 ? 'cell-change--up' : 'cell-change--down') + '">' +
                    pct(r.change_rate) + '</span>' +
                    '</a>';
            }).join('');
            var url = screeningType ? screeningUrl(screeningType, g.key) : '';
            var nameHtml = url ?
                '<a class="report-card-group__name" href="' + esc(url) + '">' + esc(g.key) + '</a>' :
                '<span class="report-card-group__name">' + esc(g.key) + '</span>';
            return '<div class="report-card-group">' +
                '<div class="report-card-group__head">' +
                nameHtml +
                '<span class="report-card-group__stat">' +
                g.count + '종목 · ' + pct(g.avg_rate) +
                '</span></div>' +
                '<div class="report-card-group__list">' + topHtml + '</div>' +
                '</div>';
        }).join('');
        $grid.innerHTML = html;

        if ($pager) {
            if (totalPages <= 1) {
                $pager.innerHTML = '';
            } else {
                $pager.innerHTML =
                    '<button type="button" class="pager-btn" data-dir="prev" data-key="' + pageKey + '" aria-label="이전"' +
                    (page === 0 ? ' disabled' : '') + '>‹</button>' +
                    '<span class="pager-info">' + (page + 1) + ' / ' + totalPages + '</span>' +
                    '<button type="button" class="pager-btn" data-dir="next" data-key="' + pageKey + '" aria-label="다음"' +
                    (page >= totalPages - 1 ? ' disabled' : '') + '>›</button>';
            }
        }
    }

    function renderHigh52w(rows) {
        var $el = $('high52wList');
        if (!$el) return;
        if (!rows.length) {
            $el.innerHTML = '<li class="report-empty">그날 52주 고점을 돌파한 종목이 없습니다.</li>';
            return;
        }
        $el.innerHTML = rows.map(function (r) {
            var meta = [];
            var theme = themeOf(r);
            var reason = reasonOf(r);
            if (r.sector) meta.push(esc(r.sector));
            if (theme) meta.push(esc(theme));
            if (reason) meta.push(esc(reason));
            return stockRowHtml(r, {
                priceLabel: '고가 ' + fmt(r.high_price || r.close_price) + '원',
                rate: r.change_rate,
                sub: meta.join(' · '),
            });
        }).join('');
    }

    function renderPullbacks(rows) {
        var $el = $('pullbackList');
        if (!$el) return;
        if (!rows.length) {
            $el.innerHTML = '<li class="report-empty">조건에 맞는 급등→조정→반등 종목이 없습니다.</li>';
            return;
        }
        $el.innerHTML = rows.map(pullbackRowHtml).join('');
    }

    function pullbackRowHtml(pb) {
        var t = esc(pb.ticker);
        var bouncePctNum = normalizedBouncePct(pb);
        var dropPctNum = Number(pb.dropPct || 0);
        var peakRate = peakRateFromReason(pb.reason);
        var ratingObj = state.ratings[pb.ticker] || {};
        var rowCls = [];
        if (ratingObj.excluded) rowCls.push('row--excluded');
        if ((ratingObj.stars || 0) > 0) rowCls.push('row--starred');
        var meta = [];
        if (pb.market) meta.push(esc(pb.market));
        if (pb.sector) meta.push(esc(pb.sector));
        return '<li class="report-pullback-row' + (rowCls.length ? ' ' + rowCls.join(' ') : '') + '" data-ticker="' + t + '">' +
            '<div class="report-pullback-main">' +
                '<div class="report-stock-row__name-wrap cell-name__wrap">' +
                    '<a class="report-stock-row__name cell-name__link" href="/stock/' + t + '" data-ticker="' + t + '">' + esc(pb.name) + '</a>' +
                    miniIndicatorsHtml(pb.ticker) +
                    (pb.market ? '<span class="report-stock-row__market">' + esc(pb.market) + '</span>' : '') +
                    starRatingHtml(pb.ticker) +
                '</div>' +
                '<div class="report-pullback-sub">' + (meta.length ? meta.join(' · ') + ' · ' : '') + esc(pb.reason || '') + '</div>' +
            '</div>' +
            '<div class="report-pullback-metric">' +
                '<span>급등</span><strong class="cell-change--up">' + (peakRate ? pct(peakRate) : '-') + '</strong>' +
            '</div>' +
            '<div class="report-pullback-metric">' +
                '<span>낙폭</span><strong class="report-rate--down">-' + dropPctNum.toFixed(1) + '%</strong>' +
            '</div>' +
            '<div class="report-pullback-metric">' +
                '<span>반등</span><strong class="cell-change--up">' + pct(bouncePctNum) + '</strong>' +
            '</div>' +
            '<div class="report-pullback-price">' +
                '<span>고점 ' + shortDate(pb.peakDate) + ' ' + fmt(pb.peakPrice) + '원</span>' +
                '<span>현재 ' + fmt(pb.currentPrice) + '원</span>' +
            '</div>' +
            '</li>';
    }

    /** 종목 행 공통 마크업 — high52w / pullback 양쪽 사용. */
    function stockRowHtml(r, opts) {
        opts = opts || {};
        var t = esc(r.ticker);
        var rate = opts.rate;
        var rateCls = (rate >= 0) ? 'cell-change--up' : 'cell-change--down';
        var ratingObj = state.ratings[r.ticker] || {};
        var rowCls = [];
        if (ratingObj.excluded) rowCls.push('row--excluded');
        if ((ratingObj.stars || 0) > 0) rowCls.push('row--starred');

        return '<li class="report-stock-row' + (rowCls.length ? ' ' + rowCls.join(' ') : '') + '" data-ticker="' + t + '">' +
            '<div class="report-stock-row__name-wrap cell-name__wrap">' +
            '<a class="report-stock-row__name cell-name__link" href="/stock/' + t + '" data-ticker="' + t + '">' + esc(r.name) + '</a>' +
            miniIndicatorsHtml(r.ticker) +
            '<span class="report-stock-row__market">' + esc(r.market || '') + '</span>' +
            starRatingHtml(r.ticker) +
            '</div>' +
            '<div class="report-stock-row__price">' + (opts.priceLabel || '') + '</div>' +
            '<div class="report-stock-row__rate ' + rateCls + '">' +
                (opts.rateLabel ? '<small>' + esc(opts.rateLabel) + '</small> ' : '') +
                pct(rate) +
            '</div>' +
            '<div class="report-stock-row__sub">' +
                (opts.sub ? opts.sub : (opts.sector ? esc(opts.sector) : '')) +
            '</div>' +
            '</li>';
    }

    // ─── 카드뉴스 ─────────────────────────────────────

    function cardItemsFromStocks(rows, valueFn, subFn) {
        return rows.slice(0, 3).map(function (r) {
            return {
                name: r.name || r.ticker || '-',
                value: valueFn ? valueFn(r) : pct(r.change_rate),
                sub: subFn ? subFn(r) : (themeOf(r) || r.sector || ''),
            };
        });
    }

    function cardItemsFromGroups(groups) {
        return groups.slice(0, 3).map(function (g) {
            return {
                name: g.key,
                value: g.count + '종목',
                sub: pct(g.avg_rate),
            };
        });
    }

    function buildGeneratedCards(date, rankings, sectors, themes, highRows, pullbacks) {
        var summary = deriveSummary(rankings);
        var topStocks = rankings.slice().sort(function (a, b) {
            return Number(b.change_rate || 0) - Number(a.change_rate || 0);
        }).slice(0, 3);
        var cards = [];
        cards.push({
            type: 'close',
            tag: '마감',
            title: '오늘 시장',
            headline: formatDate(date),
            note: '급등 종목 ' + fmt(summary.count) + '개 · 평균 ' + pct(summary.avg_rate),
            items: cardItemsFromStocks(topStocks, function (r) { return pct(r.change_rate); }, function (r) { return reasonOf(r) || themeOf(r) || r.sector || ''; }),
        });
        if (sectors.length) {
            cards.push({
                type: 'sector',
                tag: '섹터',
                title: '주도 섹터',
                headline: sectors[0].key,
                note: sectors[0].count + '종목 · 평균 ' + pct(sectors[0].avg_rate),
                items: cardItemsFromGroups(sectors),
            });
        }
        if (themes.length) {
            cards.push({
                type: 'theme',
                tag: '테마',
                title: '핫 테마',
                headline: themes[0].key,
                note: themes[0].count + '종목 · 평균 ' + pct(themes[0].avg_rate),
                items: cardItemsFromGroups(themes),
            });
        }
        cards.push({
            type: 'high',
            tag: '52주',
            title: '52주 고점',
            headline: highRows.length ? highRows[0].name : '신규 돌파 없음',
            note: highRows.length ? highRows.length + '종목 돌파' : '그날 52주 고점 돌파 종목 없음',
            items: cardItemsFromStocks(highRows, function (r) { return pct(r.change_rate); }, function (r) { return '고가 ' + fmt(r.high_price || r.close_price) + '원'; }),
        });
        cards.push({
            type: 'pullback',
            tag: '반등',
            title: '급등 후 조정',
            headline: pullbacks.length ? pullbacks[0].name : '조건 종목 없음',
            note: pullbacks.length ? '낙폭 후 반등 ' + pullbacks.length + '종목' : '조건에 맞는 반등 종목 없음',
            items: pullbacks.slice(0, 3).map(function (pb) {
                return {
                    name: pb.name || pb.ticker || '-',
                    value: pct(normalizedBouncePct(pb)),
                    sub: '낙폭 -' + Number(pb.dropPct || 0).toFixed(1) + '%',
                };
            }),
        });
        return cards;
    }

    function generatedCardHtml(card, isModal) {
        var items = (card.items || []).map(function (item) {
            return '<span class="report-news-card__item">' +
                '<span class="report-news-card__item-name">' + esc(item.name) + '</span>' +
                '<span class="report-news-card__item-value">' + esc(item.value) + '</span>' +
                (item.sub ? '<span class="report-news-card__item-sub">' + esc(item.sub) + '</span>' : '') +
                '</span>';
        }).join('');
        return '<div class="report-news-card' + (isModal ? ' report-news-card--modal' : '') + ' report-news-card--' + esc(card.type || 'base') + '">' +
            '<span class="report-news-card__tag">' + esc(card.tag || '') + '</span>' +
            '<span class="report-news-card__title">' + esc(card.title || '') + '</span>' +
            '<strong class="report-news-card__headline">' + esc(card.headline || '') + '</strong>' +
            '<span class="report-news-card__note">' + esc(card.note || '') + '</span>' +
            '<span class="report-news-card__items">' + items + '</span>' +
            '</div>';
    }

    function renderCards(date, rankings, sectors, themes, highRows, pullbacks) {
        var $section = $('cardsSection');
        var $grid = $('cardsGrid');
        if (!$grid || !$section) return;
        $section.style.display = '';
        state.cardsList = buildGeneratedCards(date, rankings, sectors, themes, highRows, pullbacks);
        $grid.innerHTML = state.cardsList.map(function (c, i) {
            return '<button type="button" class="cards-cell" data-idx="' + i + '" aria-label="' + esc(c.title || c.tag || '') + '">' +
                generatedCardHtml(c, false) +
                '</button>';
        }).join('');
    }

    function openCardsModal(idx) {
        if (!state.cardsList.length) return;
        state.cardsModalIdx = idx;
        var modal = $('cardsModal');
        var c = state.cardsList[idx];
        var img = $('cardsModalImg');
        var generated = $('cardsModalGenerated');
        if (img) {
            img.style.display = 'none';
            img.removeAttribute('src');
            img.alt = '';
        }
        if (generated) {
            generated.style.display = 'block';
            generated.innerHTML = generatedCardHtml(c, true);
        }
        $('cardsModalTag').textContent = c.tag || CARDS_TYPE_LABEL[c.type] || c.type || '';
        $('cardsModalTitle').textContent = c.title || '';
        $('cardsModalCount').textContent = (idx + 1) + ' / ' + state.cardsList.length;
        modal.style.display = 'flex';
    }
    function moveCardsModal(delta) {
        if (!state.cardsList.length) return;
        var n = state.cardsList.length;
        state.cardsModalIdx = (state.cardsModalIdx + delta + n) % n;
        openCardsModal(state.cardsModalIdx);
    }
    function closeCardsModal() { $('cardsModal').style.display = 'none'; }

    // ─── 데이터 로드 + 렌더 트리거 ───────────────────

    function applyDay() {
        var d = state.day;
        if (!d) return;
        var date = state.dates[state.dateIndex] || '';
        var rankings = (d.rankings || []).filter(function (r) { return !BLOCKED_TICKERS[r.ticker]; });
        var sectors = deriveSectors(rankings);
        var themes = deriveThemes(rankings);
        var highRows = deriveHigh52w(rankings, date);
        var pullbacks = derivePullbacks(d.pullbacks || []);
        renderGroupCards(sectors, 'sectorCards', 'sectorPager', 'sectorPage', '주도 섹터', 'sector');
        renderGroupCards(themes, 'themeCards', 'themePager', 'themePage', '핫 테마', 'theme');
        renderCards(date, rankings, sectors, themes, highRows, pullbacks);
        renderHigh52w(highRows);
        renderPullbacks(pullbacks);
    }

    function showMessage(msg) {
        var $m = $('message');
        $m.style.display = msg ? 'block' : 'none';
        $m.textContent = msg || '';
    }

    function loadDate(date) {
        var $loading = $('loading');
        var $content = $('reportContent');
        if ($loading) $loading.style.display = 'block';
        if ($content) $content.style.display = 'none';
        showMessage('');
        return WhyAPI.getRankings(date).then(function (data) {
            state.day = data;
            state.sectorPage = 0;
            state.themePage = 0;
            setUpdatedAt(data.collected_at || '');
            applyDay();
            if ($loading) $loading.style.display = 'none';
            if ($content) $content.style.display = 'block';
        }).catch(function (err) {
            if ($loading) $loading.style.display = 'none';
            setUpdatedAt('');
            showMessage('리포트 로딩 실패: ' + (err && err.message ? err.message : err));
        });
    }

    function updateDateUI() {
        var date = state.dates[state.dateIndex] || '';
        $('dateDisplay').textContent = formatDate(date);
        var badge = $('dateBadge');
        if (badge) {
            badge.textContent = '';
            badge.style.display = 'none';
        }
    }

    // ─── 이벤트 ──────────────────────────────────────

    function bindDateNav() {
        var $prev = $('datePrev'), $next = $('dateNext'), $disp = $('dateDisplay');
        function jumpTo(date) {
            var i = state.dates.indexOf(date);
            if (i < 0) return;
            state.dateIndex = i;
            updateDateUI();
            loadDate(date);
        }
        $prev.addEventListener('click', function () {
            if (state.dateIndex < state.dates.length - 1) {
                state.dateIndex++;
                updateDateUI();
                loadDate(state.dates[state.dateIndex]);
            }
        });
        $next.addEventListener('click', function () {
            if (state.dateIndex > 0) {
                state.dateIndex--;
                updateDateUI();
                loadDate(state.dates[state.dateIndex]);
            }
        });
        $disp.addEventListener('click', function () {
            if (typeof DatePicker === 'undefined' || !DatePicker.open) return;
            DatePicker.open({
                trigger: $disp,
                dates: state.dates,
                current: state.dates[state.dateIndex],
                onSelect: jumpTo,
            });
        });
    }

    function bindPagerClicks() {
        document.addEventListener('click', function (e) {
            var btn = e.target.closest('.pager-btn');
            if (!btn || btn.disabled) return;
            var key = btn.getAttribute('data-key');
            var dir = btn.getAttribute('data-dir');
            state[key] = (state[key] || 0) + (dir === 'next' ? 1 : -1);
            if (state[key] < 0) state[key] = 0;
            applyDay();
        });
    }

    function bindRatingsEvents() {
        document.addEventListener('click', function (e) {
            // 카드뉴스 클릭
            var cell = e.target.closest('.cards-cell');
            if (cell) {
                var idx = parseInt(cell.getAttribute('data-idx'), 10);
                if (!isNaN(idx)) openCardsModal(idx);
                return;
            }
            // 별점
            var star = e.target.closest('.star');
            if (star) {
                var sw = star.closest('.star-rating');
                var ticker = sw && sw.getAttribute('data-ticker');
                var n = parseInt(star.getAttribute('data-star'), 10);
                if (!ticker || !n) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                state.ratings[ticker].stars = state.ratings[ticker].stars === n ? 0 : n;
                saveRatings();
                applyDay();
                return;
            }
            // 제외
            var ex = e.target.closest('.exclude-btn');
            if (ex) {
                var t2 = ex.getAttribute('data-ticker');
                if (!t2) return;
                state.ratings[t2] = state.ratings[t2] || {};
                state.ratings[t2].excluded = !state.ratings[t2].excluded;
                saveRatings();
                applyDay();
                return;
            }
            // 메모
            var memo = e.target.closest('.memo-btn');
            if (memo) {
                openMemo(memo.getAttribute('data-ticker'));
                return;
            }
            // 모바일 ⋯ 토글
            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                var wrap = toggle.closest('.ctrl-wrap');
                if (wrap) wrap.classList.toggle('is-open');
                return;
            }
        });
    }

    function openMemo(ticker) {
        var modal = $('memoModal');
        var title = $('memoModalTitle');
        var area = $('memoTextarea');
        if (!modal || !area) return;
        var r = state.ratings[ticker] || {};
        if (title) {
            var name = lookupName(ticker) || ticker;
            title.textContent = name + ' 메모';
        }
        area.value = r.memo || '';
        area.setAttribute('data-ticker', ticker);
        modal.style.display = 'flex';
        setTimeout(function () { area.focus(); }, 50);
    }

    function lookupName(ticker) {
        if (!state.day) return ticker;
        var rk = (state.day.rankings || []).find(function (r) { return r.ticker === ticker; });
        if (rk) return rk.name;
        var pb = (state.day.pullbacks || []).find(function (p) { return p.ticker === ticker; });
        if (pb) return pb.name;
        return ticker;
    }

    function bindMemoModal() {
        var modal = $('memoModal');
        if (!modal) return;
        $('memoModalClose').addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });
        $('memoSave').addEventListener('click', function () {
            var area = $('memoTextarea');
            var ticker = area.getAttribute('data-ticker');
            if (!ticker) return;
            state.ratings[ticker] = state.ratings[ticker] || {};
            state.ratings[ticker].memo = area.value.trim();
            saveRatings();
            applyDay();
            modal.style.display = 'none';
        });
        $('memoDelete').addEventListener('click', function () {
            var area = $('memoTextarea');
            var ticker = area.getAttribute('data-ticker');
            if (!ticker) return;
            if (state.ratings[ticker]) delete state.ratings[ticker].memo;
            saveRatings();
            applyDay();
            modal.style.display = 'none';
        });
    }

    function bindCardsModal() {
        var modal = $('cardsModal');
        if (!modal) return;
        $('cardsModalClose').addEventListener('click', closeCardsModal);
        modal.addEventListener('click', function (e) { if (e.target === modal) closeCardsModal(); });
        $('cardsModalPrev').addEventListener('click', function () { moveCardsModal(-1); });
        $('cardsModalNext').addEventListener('click', function () { moveCardsModal(1); });
        document.addEventListener('keydown', function (e) {
            if (modal.style.display !== 'flex') return;
            if (e.key === 'Escape') closeCardsModal();
            else if (e.key === 'ArrowLeft') moveCardsModal(-1);
            else if (e.key === 'ArrowRight') moveCardsModal(1);
        });
    }

    function bindThemeToggle() {
        var btn = $('themeToggle');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem(THEME_KEY, next);
        });
    }

    function bindResize() {
        var t = null;
        window.addEventListener('resize', function () {
            clearTimeout(t);
            t = setTimeout(function () { applyDay(); }, 150);
        });
    }

    function bindStorageSync() {
        window.addEventListener('storage', function (e) {
            if (e.key !== STORAGE_KEY) return;
            loadRatings();
            applyDay();
        });
    }

    function init() {
        loadRatings();
        bindThemeToggle();
        bindDateNav();
        bindPagerClicks();
        bindRatingsEvents();
        bindMemoModal();
        bindCardsModal();
        bindResize();
        bindStorageSync();

        WhyAPI.getDates().then(function (dates) {
            if (!Array.isArray(dates) || !dates.length) {
                showMessage('거래일 데이터 없음.');
                $('loading').style.display = 'none';
                return null;
            }
            state.dates = dates;
            state.dateIndex = 0;
            updateDateUI();
            return loadDate(dates[0]);
        }).then(function () {
            if (window.WhyRatingsSync) {
                window.WhyRatingsSync.pull().then(function (result) {
                    if (result && result.source === 'remote') {
                        loadRatings();
                        applyDay();
                    }
                });
            }
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', WhyReport.init);
