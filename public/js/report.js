/**
 * 리포트 페이지 - Whyrise compact report.
 *
 * 기준:
 * - 주도 섹터/핫 테마: 그날 +15% 이상 종목 중 3종목 이상 그룹만 표시
 * - 오늘의 대장주: stock-rise score_detail 우선, 없으면 등락/거래/그룹 밀집도로 1종목 선정
 * - 52주 신고가: +10% 이상 상승하면서 해당 날짜에 52주 신고가를 기록한 종목
 * - 급등 후 조정 후 반등: +15% 이상 급등 후 고점 대비 -20% 이상, 저점 대비 +15% 이상 재상승
 */
var WhyReport = (function () {
    'use strict';

    var STORAGE_KEY = 'whyrise-ratings';
    var THEME_KEY = 'theme';
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    var RISE_CUTOFF = 15;
    var HIGH52_CUTOFF = 10;
    var GROUP_MIN = 3;
    var GROUP_TOP_STOCKS = 4;
    var PB_PEAK_MIN = 15;
    var PB_DROP_MIN = 20;
    var PB_BOUNCE_MIN = 15;

    var state = {
        dates: [],
        dateIndex: 0,
        day: null,
        ratings: {},
    };

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function num(v, fallback) {
        var n = Number(v);
        return isFinite(n) ? n : (fallback == null ? 0 : fallback);
    }

    function firstNum(obj, keys) {
        if (!obj) return 0;
        for (var i = 0; i < keys.length; i++) {
            var n = Number(obj[keys[i]]);
            if (isFinite(n) && n > 0) return n;
        }
        return 0;
    }

    function fmt(n) {
        if (n == null || isNaN(n)) return '-';
        return Number(n).toLocaleString('ko-KR');
    }

    function fmtPrice(n) {
        if (!n || isNaN(n)) return '-';
        return Number(n).toLocaleString('ko-KR');
    }

    function fmtAmount(n) {
        n = Number(n || 0);
        if (!n) return '-';
        if (n >= 1e12) return (n / 1e12).toFixed(1) + '조';
        if (n >= 1e8) return Math.round(n / 1e8).toLocaleString('ko-KR') + '억';
        if (n >= 1e4) return Math.round(n / 1e4).toLocaleString('ko-KR') + '만';
        return n.toLocaleString('ko-KR');
    }

    function pct(n, digits) {
        if (n == null || isNaN(n)) return '-';
        digits = digits == null ? 2 : digits;
        n = Number(n);
        return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%';
    }

    function pctDown(n) {
        if (n == null || isNaN(n)) return '-';
        n = Math.abs(Number(n));
        return '-' + n.toFixed(1) + '%';
    }

    function formatDate(yyyymmdd) {
        var s = String(yyyymmdd || '');
        if (s.length !== 8) return s || '-';
        var days = ['일', '월', '화', '수', '목', '금', '토'];
        var d = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
        return s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6, 8) + ' (' + days[d.getDay()] + ')';
    }

    function formatTimestamp(value) {
        if (!value) return '';
        var s = String(value).trim();
        var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
        if (m) return m[1] + '.' + m[2] + '.' + m[3] + ' ' + m[4] + ':' + m[5];
        return s.replace('T', ' ').substring(0, 16);
    }

    function setUpdatedAt(value) {
        var el = $('reportUpdatedAt');
        if (el) el.textContent = formatTimestamp(value);
    }

    function themeTags(row) {
        var out = [];
        var seen = {};
        function add(v) {
            v = String(v || '').trim();
            if (!v || seen[v]) return;
            seen[v] = 1;
            out.push(v);
        }
        if (Array.isArray(row && row.theme_tags)) {
            row.theme_tags.forEach(add);
        }
        add(row && row.theme_tag);
        return out;
    }

    function themeOf(row) {
        var tags = themeTags(row);
        return tags.length ? tags[0] : '';
    }

    function reasonOf(row) {
        return (row && (row.rise_reason || row.reason || row.latest_reason)) || '';
    }

    function stockUrl(ticker) {
        return '/stock/' + encodeURIComponent(ticker);
    }

    function screeningUrl(type, key) {
        var params = ['cnt=count_15', 'min=1'];
        if (type === 'sector') params.push('sector=' + encodeURIComponent(key));
        if (type === 'theme') params.push('theme=' + encodeURIComponent(key));
        return '/screening.html?' + params.join('&');
    }

    function loadRatings() {
        try { state.ratings = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch (e) { state.ratings = {}; }
    }

    function saveRatings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.ratings)); }
        catch (e) {}
        if (window.WhyRatingsSync) window.WhyRatingsSync.push(state.ratings);
    }

    function ratingClass(ticker) {
        var r = state.ratings[ticker] || {};
        var cls = [];
        if (r.excluded) cls.push('row--excluded');
        if ((r.stars || 0) > 0) cls.push('row--starred');
        return cls.join(' ');
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

    function isActiveRow(row, cutoff) {
        if (!row || !row.ticker || BLOCKED_TICKERS[row.ticker]) return false;
        return num(row.change_rate) >= cutoff;
    }

    function activeRiseRows(rankings) {
        return (rankings || []).filter(function (row) {
            return isActiveRow(row, RISE_CUTOFF);
        });
    }

    function buildGroups(rows, type) {
        var by = {};
        rows.forEach(function (row) {
            var keys = type === 'theme' ? themeTags(row) : [String(row.sector || '').trim()];
            var rowSeen = {};
            keys.forEach(function (key) {
                if (!key || rowSeen[key]) return;
                rowSeen[key] = 1;
                if (!by[key]) {
                    by[key] = {
                        key: key,
                        type: type,
                        count: 0,
                        sumRate: 0,
                        totalVolume: 0,
                        stocks: [],
                        _tickers: {},
                    };
                }
                if (by[key]._tickers[row.ticker]) return;
                by[key]._tickers[row.ticker] = 1;
                by[key].count += 1;
                by[key].sumRate += num(row.change_rate);
                by[key].totalVolume += num(row.trading_value);
                by[key].stocks.push(row);
            });
        });

        return Object.keys(by).map(function (key) {
            var g = by[key];
            g.avgRate = g.count ? g.sumRate / g.count : 0;
            g.stocks.sort(function (a, b) {
                return num(b.change_rate) - num(a.change_rate) ||
                    num(b.trading_value) - num(a.trading_value);
            });
            delete g._tickers;
            return g;
        }).filter(function (g) {
            return g.count >= GROUP_MIN;
        }).sort(function (a, b) {
            return b.count - a.count ||
                b.avgRate - a.avgRate ||
                b.totalVolume - a.totalVolume;
        });
    }

    function groupMaps(sectors, themes) {
        var sectorMap = {};
        var themeMap = {};
        sectors.forEach(function (g) { sectorMap[g.key] = g; });
        themes.forEach(function (g) { themeMap[g.key] = g; });
        return { sector: sectorMap, theme: themeMap };
    }

    function leaderScore(row, maps) {
        var detail = row.score_detail || {};
        var baseScore = num(row.score) * 0.45;
        var tl = num(detail.tl);
        var tp = num(detail.tp);
        var ti = num(detail.ti);
        var sectorCount = maps.sector[row.sector] ? maps.sector[row.sector].count : 1;
        var bestThemeCount = 1;
        themeTags(row).forEach(function (tag) {
            if (maps.theme[tag]) bestThemeCount = Math.max(bestThemeCount, maps.theme[tag].count);
        });
        var volumeBonus = row.trading_value ? Math.min(10, Math.max(0, Math.log(num(row.trading_value)) / Math.LN10 - 8)) : 0;
        return baseScore +
            num(row.change_rate) * 0.32 +
            tl * 0.75 +
            tp * 0.25 +
            ti * 0.35 +
            Math.min(12, sectorCount * 1.7) +
            Math.min(10, bestThemeCount * 1.4) +
            volumeBonus;
    }

    function pickLeader(rows, sectors, themes) {
        if (!rows.length) return null;
        var maps = groupMaps(sectors, themes);
        var sorted = rows.slice().sort(function (a, b) {
            return leaderScore(b, maps) - leaderScore(a, maps) ||
                num(b.change_rate) - num(a.change_rate) ||
                num(b.trading_value) - num(a.trading_value);
        });
        var leader = Object.assign({}, sorted[0]);
        leader._leaderScore = leaderScore(sorted[0], maps);
        leader._sectorCount = maps.sector[leader.sector] ? maps.sector[leader.sector].count : 1;
        leader._themeCount = 1;
        themeTags(leader).forEach(function (tag) {
            if (maps.theme[tag]) leader._themeCount = Math.max(leader._themeCount, maps.theme[tag].count);
        });
        return leader;
    }

    function deriveHigh52w(rankings, date) {
        return (rankings || []).filter(function (row) {
            if (!isActiveRow(row, HIGH52_CUTOFF)) return false;
            if (String(row.high_52w_date || '') !== String(date)) return false;
            var high52 = num(row.high_52w);
            var dayHigh = num(row.high_price || row.close_price);
            return high52 > 0 && dayHigh >= high52 * 0.999;
        }).sort(function (a, b) {
            return num(b.change_rate) - num(a.change_rate) ||
                num(b.trading_value) - num(a.trading_value);
        });
    }

    function peakRateFromPullback(pb) {
        var direct = firstNum(pb, ['peakRate', 'peak_rate', 'peakChangeRate', 'peak_change_rate']);
        if (direct) return direct;
        var m = /\+(\d+(?:\.\d+)?)%/.exec(String((pb && pb.reason) || ''));
        return m ? Number(m[1]) : 0;
    }

    function normalizedBouncePct(pb) {
        var raw = Number((pb && pb.bouncePct) || 0);
        if (!isFinite(raw)) return 0;
        return raw > 0 && raw <= 1 ? raw * 100 : raw;
    }

    function pullbackPrices(pb) {
        var peak = firstNum(pb, ['peakPrice', 'peak_price', 'highPrice', 'high_price']);
        var current = firstNum(pb, ['currentPrice', 'current_price', 'closePrice', 'close_price', 'price']);
        var low = firstNum(pb, ['postPeakLow', 'lowPrice', 'low_price', 'troughPrice', 'bottomPrice', 'low']);
        var bounce = normalizedBouncePct(pb);
        if (!low && current && bounce > 0) low = Math.round(current / (1 + bounce / 100));
        return { peak: peak, low: low, current: current };
    }

    function currentDrawdownPct(pb) {
        var p = pullbackPrices(pb);
        if (p.peak && p.current) return ((p.current - p.peak) / p.peak) * 100;
        return -Math.abs(num(pb && pb.dropPct));
    }

    function derivePullbacks(pullbacks) {
        return (pullbacks || []).filter(function (pb) {
            if (!pb || !pb.ticker || BLOCKED_TICKERS[pb.ticker]) return false;
            if (pb.bounceBack !== true) return false;
            if (peakRateFromPullback(pb) < PB_PEAK_MIN) return false;
            if (Math.abs(num(pb.dropPct)) < PB_DROP_MIN) return false;
            if (normalizedBouncePct(pb) < PB_BOUNCE_MIN) return false;
            var prices = pullbackPrices(pb);
            return prices.peak > 0 && prices.current > 0;
        }).sort(function (a, b) {
            return normalizedBouncePct(b) - normalizedBouncePct(a) ||
                Math.abs(currentDrawdownPct(b)) - Math.abs(currentDrawdownPct(a));
        });
    }

    function stockNameHtml(row, className) {
        var ticker = esc(row.ticker);
        var market = row.market ? '<span class="report-stock-market">' + esc(row.market) + '</span>' : '';
        return '<span class="' + className + ' cell-name__wrap">' +
            '<a class="report-stock-name cell-name__link" href="' + stockUrl(row.ticker) + '" data-ticker="' + ticker + '">' + esc(row.name || row.ticker) + '</a>' +
            miniIndicatorsHtml(row.ticker) +
            market +
            starRatingHtml(row.ticker) +
            '</span>';
    }

    function renderLeader(row) {
        var el = $('leaderCard');
        if (!el) return;
        if (!row) {
            el.innerHTML = '<div class="report-empty">오늘 기준에 맞는 대장주가 없습니다.</div>';
            return;
        }
        var theme = themeOf(row);
        var reason = reasonOf(row);
        var detail = row.score_detail || {};
        var chips = [];
        if (row.sector) chips.push('<span>섹터 ' + esc(row.sector) + ' ' + row._sectorCount + '종목</span>');
        if (theme) chips.push('<span>테마 ' + esc(theme) + ' ' + row._themeCount + '종목</span>');
        if (detail.tl != null) chips.push('<span>대장성 ' + esc(detail.tl) + '</span>');
        if (detail.tp != null) chips.push('<span>테마강도 ' + esc(detail.tp) + '</span>');
        if (row.trading_value) chips.push('<span>거래대금 ' + fmtAmount(row.trading_value) + '</span>');

        el.innerHTML = '<article class="report-leader-card ' + ratingClass(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' +
            '<div class="report-leader-card__main">' +
                '<div class="report-leader-card__stock">' +
                    stockNameHtml(row, 'report-leader-card__name') +
                    '<p class="report-leader-card__reason">' + esc(reason || '등락률, 거래대금, 섹터/테마 밀집도 기준') + '</p>' +
                '</div>' +
                '<div class="report-leader-card__rate">' +
                    '<strong class="cell-change--up">' + pct(row.change_rate) + '</strong>' +
                    '<span>시총 ' + fmtAmount(row.market_cap) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="report-leader-card__chips">' + chips.join('') + '</div>' +
        '</article>';
    }

    function stockChipHtml(row) {
        return '<span class="report-stock-chip ' + ratingClass(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' +
            '<a href="' + stockUrl(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' + esc(row.name || row.ticker) + '</a>' +
            '<strong class="cell-change--up">' + pct(row.change_rate, 1) + '</strong>' +
            starRatingHtml(row.ticker) +
        '</span>';
    }

    function renderGroups(groups, id, type, emptyText) {
        var el = $(id);
        if (!el) return;
        if (!groups.length) {
            el.innerHTML = '<div class="report-empty">' + esc(emptyText) + '</div>';
            return;
        }
        el.innerHTML = groups.map(function (g, i) {
            var stocks = g.stocks.slice(0, GROUP_TOP_STOCKS).map(stockChipHtml).join('');
            var more = g.count > GROUP_TOP_STOCKS ? '<span class="report-group-row__more">외 ' + (g.count - GROUP_TOP_STOCKS) + '</span>' : '';
            return '<article class="report-group-row" data-group="' + esc(g.key) + '">' +
                '<div class="report-group-row__rank">' + (i + 1) + '</div>' +
                '<div class="report-group-row__main">' +
                    '<a class="report-group-row__name" href="' + esc(screeningUrl(type, g.key)) + '">' + esc(g.key) + '</a>' +
                    '<span class="report-group-row__count">' + g.count + '종목</span>' +
                '</div>' +
                '<div class="report-group-row__stat"><span>평균</span><strong class="cell-change--up">' + pct(g.avgRate) + '</strong></div>' +
                '<div class="report-group-row__stat"><span>거래</span><strong>' + fmtAmount(g.totalVolume) + '</strong></div>' +
                '<div class="report-group-row__stocks">' + stocks + more + '</div>' +
            '</article>';
        }).join('');
    }

    function renderHigh52w(rows) {
        var el = $('high52wList');
        if (!el) return;
        if (!rows.length) {
            el.innerHTML = '<li class="report-empty">오늘 52주 신고가를 돌파한 종목이 없습니다.</li>';
            return;
        }
        el.innerHTML = rows.map(function (row) {
            var high = row.high_price || row.high_52w || row.close_price;
            return '<li class="report-simple-row ' + ratingClass(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' +
                stockNameHtml(row, 'report-simple-row__name') +
                '<span class="report-simple-row__price">고가 ' + fmtPrice(high) + '</span>' +
                '<strong class="report-simple-row__rate cell-change--up">' + pct(row.change_rate) + '</strong>' +
            '</li>';
        }).join('');
    }

    function renderPullbacks(rows) {
        var el = $('pullbackList');
        if (!el) return;
        if (!rows.length) {
            el.innerHTML = '<li class="report-empty">조건에 맞는 급등 후 조정 후 반등 종목이 없습니다.</li>';
            return;
        }
        el.innerHTML = rows.map(function (pb) {
            var p = pullbackPrices(pb);
            var drawdown = currentDrawdownPct(pb);
            var bounce = normalizedBouncePct(pb);
            var row = {
                ticker: pb.ticker,
                name: pb.name,
                market: pb.market,
            };
            return '<li class="report-move-row ' + ratingClass(pb.ticker) + '" data-ticker="' + esc(pb.ticker) + '">' +
                '<div class="report-move-row__stock">' + stockNameHtml(row, 'report-move-row__name') + '</div>' +
                '<div class="report-move-row__metrics">' +
                    '<span>고점 <strong>' + fmtPrice(p.peak) + '</strong></span>' +
                    '<span>저점 <strong>' + fmtPrice(p.low) + '</strong></span>' +
                    '<span>현재 <strong>' + fmtPrice(p.current) + '</strong></span>' +
                '</div>' +
                '<div class="report-move-row__rates">' +
                    '<strong class="report-rate--down">' + pctDown(drawdown) + '</strong>' +
                    '<strong class="cell-change--up">저점 대비 ' + pct(bounce, 1) + '</strong>' +
                '</div>' +
            '</li>';
        }).join('');
    }

    function applyDay() {
        var day = state.day;
        if (!day) return;
        var date = state.dates[state.dateIndex] || '';
        var riseRows = activeRiseRows(day.rankings || []);
        var sectors = buildGroups(riseRows, 'sector');
        var themes = buildGroups(riseRows, 'theme');
        var leader = pickLeader(riseRows, sectors, themes);
        var highRows = deriveHigh52w(day.rankings || [], date);
        var pullbacks = derivePullbacks(day.pullbacks || []);

        renderLeader(leader);
        renderGroups(sectors, 'sectorGroups', 'sector', '3종목 이상 몰린 주도 섹터가 없습니다.');
        renderGroups(themes, 'themeGroups', 'theme', '3종목 이상 몰린 핫 테마가 없습니다.');
        renderHigh52w(highRows);
        renderPullbacks(pullbacks);
    }

    function showMessage(msg) {
        var el = $('message');
        if (!el) return;
        el.style.display = msg ? 'block' : 'none';
        el.textContent = msg || '';
    }

    function updateDateUI() {
        var date = state.dates[state.dateIndex] || '';
        var display = $('dateDisplay');
        var badge = $('dateBadge');
        if (display) display.textContent = formatDate(date);
        if (badge) {
            badge.textContent = '';
            badge.style.display = 'none';
        }
        var prev = $('datePrev');
        var next = $('dateNext');
        if (prev) prev.disabled = state.dateIndex >= state.dates.length - 1;
        if (next) next.disabled = state.dateIndex <= 0;
    }

    function loadDate(date) {
        var loading = $('loading');
        var content = $('reportContent');
        if (loading) loading.style.display = 'block';
        if (content) content.style.display = 'none';
        showMessage('');
        return WhyAPI.getRankings(date).then(function (data) {
            state.day = data || {};
            setUpdatedAt(data && data.collected_at);
            applyDay();
            if (loading) loading.style.display = 'none';
            if (content) content.style.display = 'block';
        }).catch(function (err) {
            if (loading) loading.style.display = 'none';
            setUpdatedAt('');
            showMessage('리포트 로딩 실패: ' + (err && err.message ? err.message : err));
        });
    }

    function jumpToDate(date) {
        var i = state.dates.indexOf(date);
        if (i < 0) return;
        state.dateIndex = i;
        updateDateUI();
        loadDate(date);
    }

    function bindDateNav() {
        var prev = $('datePrev');
        var next = $('dateNext');
        var display = $('dateDisplay');
        if (prev) {
            prev.addEventListener('click', function () {
                if (state.dateIndex >= state.dates.length - 1) return;
                state.dateIndex++;
                updateDateUI();
                loadDate(state.dates[state.dateIndex]);
            });
        }
        if (next) {
            next.addEventListener('click', function () {
                if (state.dateIndex <= 0) return;
                state.dateIndex--;
                updateDateUI();
                loadDate(state.dates[state.dateIndex]);
            });
        }
        if (display) {
            display.addEventListener('click', function () {
                if (typeof DatePicker === 'undefined' || !DatePicker.open) return;
                DatePicker.open({
                    trigger: display,
                    dates: state.dates,
                    current: state.dates[state.dateIndex],
                    onSelect: jumpToDate,
                });
            });
        }
    }

    function lookupName(ticker) {
        var day = state.day || {};
        var rows = (day.rankings || []).concat(day.pullbacks || []);
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].ticker === ticker) return rows[i].name || ticker;
        }
        return ticker;
    }

    function openMemo(ticker) {
        var modal = $('memoModal');
        var title = $('memoModalTitle');
        var area = $('memoTextarea');
        if (!modal || !area || !ticker) return;
        var r = state.ratings[ticker] || {};
        if (title) title.textContent = lookupName(ticker) + ' 메모';
        area.value = r.memo || '';
        area.setAttribute('data-ticker', ticker);
        modal.style.display = 'flex';
        setTimeout(function () { area.focus(); }, 50);
    }

    function bindRatingsEvents() {
        document.addEventListener('click', function (e) {
            var star = e.target.closest('.star');
            if (star) {
                e.preventDefault();
                e.stopPropagation();
                var wrap = star.closest('.star-rating');
                var ticker = wrap && wrap.getAttribute('data-ticker');
                var value = parseInt(star.getAttribute('data-star'), 10);
                if (!ticker || !value) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                state.ratings[ticker].stars = state.ratings[ticker].stars === value ? 0 : value;
                saveRatings();
                applyDay();
                return;
            }

            var exclude = e.target.closest('.exclude-btn');
            if (exclude) {
                e.preventDefault();
                e.stopPropagation();
                var t1 = exclude.getAttribute('data-ticker');
                if (!t1) return;
                state.ratings[t1] = state.ratings[t1] || {};
                state.ratings[t1].excluded = !state.ratings[t1].excluded;
                saveRatings();
                applyDay();
                return;
            }

            var memo = e.target.closest('.memo-btn');
            if (memo) {
                e.preventDefault();
                e.stopPropagation();
                openMemo(memo.getAttribute('data-ticker'));
                return;
            }

            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                e.preventDefault();
                e.stopPropagation();
                var ctrl = toggle.closest('.ctrl-wrap');
                if (ctrl) ctrl.classList.toggle('is-open');
            }
        });
    }

    function bindMemoModal() {
        var modal = $('memoModal');
        var close = $('memoModalClose');
        var save = $('memoSave');
        var del = $('memoDelete');
        var area = $('memoTextarea');
        if (!modal || !area) return;

        if (close) close.addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) {
            if (e.target === modal) modal.style.display = 'none';
        });
        if (save) {
            save.addEventListener('click', function () {
                var ticker = area.getAttribute('data-ticker');
                if (!ticker) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                state.ratings[ticker].memo = area.value.trim();
                saveRatings();
                applyDay();
                modal.style.display = 'none';
            });
        }
        if (del) {
            del.addEventListener('click', function () {
                var ticker = area.getAttribute('data-ticker');
                if (!ticker) return;
                if (state.ratings[ticker]) delete state.ratings[ticker].memo;
                saveRatings();
                applyDay();
                modal.style.display = 'none';
            });
        }
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
        bindRatingsEvents();
        bindMemoModal();
        bindStorageSync();

        WhyAPI.getDates().then(function (dates) {
            if (!Array.isArray(dates) || !dates.length) {
                showMessage('거래일 데이터 없음.');
                var loading = $('loading');
                if (loading) loading.style.display = 'none';
                return null;
            }
            state.dates = dates;
            state.dateIndex = 0;
            updateDateUI();
            return loadDate(dates[0]);
        }).then(function () {
            if (window.WhyRatingsSync) {
                return window.WhyRatingsSync.pull().then(function (result) {
                    if (result && result.source === 'remote') {
                        loadRatings();
                        applyDay();
                    }
                    return null;
                });
            }
            return null;
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', WhyReport.init);
