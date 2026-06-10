/**
 * 리포트 페이지 - Whyrise compact report.
 *
 * 기준:
 * - 주도 섹터/핫 테마: 그날 +15% 이상 종목 중 3종목 이상 그룹만 표시
 * - 오늘의 대장: +20% 이상 상승 종목 중 거래대금 우선, 비슷하면 상승률까지 종합
 * - 52주 신고가: +10% 이상 상승하면서 해당 날짜에 52주 신고가를 기록한 종목
 * - 조정 후 반등 시도: +15% 이상 급등 후 저점 -20% 이상, 저점 대비 현재가 +15% 이상, 이전 고점 미회복
 */
var WhyReport = (function () {
    'use strict';

    var STORAGE_KEY = 'whyrise-ratings';
    var THEME_KEY = 'theme';
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    var RISE_CUTOFF = 15;
    var LEADER_CUTOFF = 20;
    var HIGH52_CUTOFF = 10;
    var GROUP_MIN = 3;
    var GROUP_TOP_STOCKS = 4;
    var PB_PEAK_MIN = 15;
    var PB_DROP_MIN = 20;
    var PB_BOUNCE_MIN = 15;

    // 라이브 숫자 오버레이 — 15s 주기(home 과 동일). /api/marketmap 병렬화로 ~3s 응답이라 단축.
    var LIVE_POLL_MS = 15 * 1000;
    var IDLE_RECHECK_MS = 5000;            // 비라이브 상태 재확인 주기
    var STATUS_RECHECK_MS = 5 * 60 * 1000; // 서버 CLOSE(공휴일/오판) 재확인 주기
    var CLOSE_SETTLE_MS = 90 * 1000;       // 마감 후 확정 종가 fetch 지연 (동시호가 체결 대기)
    // 급등 신규 — 빌드(stock-rise 일자 rankings)에 아직 없는데 라이브 union 에서 +N% 인 종목.
    // 오버레이는 기존 행 숫자만 갱신 → 새 종목은 못 잡으므로 별도 슬롯에 '시세만' 노출(이유 분석 대기중).
    var NEW_CUTOFF = 15;
    var NEW_TOP = 12;
    var KST_OFFSET = 9 * 60, OPEN_MIN = 9 * 60, CLOSE_MIN = 15 * 60 + 30;
    function isMarketOpen() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }

    var state = {
        dates: [],
        dateIndex: 0,
        day: null,
        ratings: {},
        live: null,        // /api/marketmap ticker→숫자 맵 (라이브 오버레이용)
        liveTimer: null,   // 단일 라이브 사이클 타이머
        liveOnce: false,   // 최신일 '실제 종가' 1회 확보 여부 — 장 마감·장전에도 최소 1회는 라이브 fetch
        marketStatus: '',  // ''=미확인(로컬 시계 신뢰) | 'OPEN' | 'CLOSE' (서버 판정 — 공휴일 포함)
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

    function formatChangeRate(rate) {
        if (rate == null || isNaN(rate)) return '-';
        var sign = rate >= 0 ? '+' : '';
        var arrow = rate >= 0 ? '▲' : '▼';
        var cls = rate >= 0 ? 'cell-change--up' : 'cell-change--down';
        return '<span class="' + cls + '">' + arrow + sign + Number(rate).toFixed(2) + '%</span>';
    }

    function shortenTheme(name, maxLen) {
        if (!name) return name;
        maxLen = maxLen || 14;
        var short = String(name).replace(/\(.*?\)/g, '').trim();
        if (!short) return name;
        if (short.length > maxLen) short = short.substring(0, maxLen) + '…';
        return short;
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

    function pickLeader(rows, sectors, themes) {
        var candidates = (rows || []).filter(function (row) {
            return num(row.change_rate) >= LEADER_CUTOFF && num(row.trading_value) > 0;
        });
        if (!candidates.length) return null;
        var maps = groupMaps(sectors, themes);
        var maxVolume = Math.max.apply(null, candidates.map(function (row) { return num(row.trading_value); }));
        var volumePeers = candidates.filter(function (row) {
            return num(row.trading_value) >= maxVolume * 0.7;
        });
        var maxChange = Math.max.apply(null, volumePeers.map(function (row) { return num(row.change_rate); }));
        function score(row) {
            var volumeScore = maxVolume > 0 ? num(row.trading_value) / maxVolume : 0;
            var changeScore = maxChange > 0 ? num(row.change_rate) / maxChange : 0;
            return volumeScore * 70 + changeScore * 30;
        }
        var sorted = volumePeers.slice().sort(function (a, b) {
            return score(b) - score(a) ||
                num(b.trading_value) - num(a.trading_value) ||
                num(b.change_rate) - num(a.change_rate);
        });
        var leader = Object.assign({}, sorted[0]);
        leader._leaderScore = score(sorted[0]);
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
        var current = firstNum(pb, ['currentPrice', 'current_price', 'closePrice', 'close_price', 'price']);
        var low = firstNum(pb, ['postPeakLow', 'lowPrice', 'low_price', 'troughPrice', 'bottomPrice', 'low']);
        if (current > 0 && low > 0) return ((current - low) / low) * 100;
        var raw = Number((pb && pb.bouncePct) || 0);
        return isFinite(raw) ? raw : 0;
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

    function lowDrawdownPct(pb) {
        var p = pullbackPrices(pb);
        if (p.peak && p.low) return ((p.peak - p.low) / p.peak) * 100;
        return Math.abs(num(pb && pb.dropPct));
    }

    function derivePullbacks(pullbacks) {
        return (pullbacks || []).filter(function (pb) {
            if (!pb || !pb.ticker || BLOCKED_TICKERS[pb.ticker]) return false;
            if (peakRateFromPullback(pb) < PB_PEAK_MIN) return false;
            if (lowDrawdownPct(pb) < PB_DROP_MIN) return false;
            if (normalizedBouncePct(pb) < PB_BOUNCE_MIN) return false;
            var prices = pullbackPrices(pb);
            if (!(prices.peak > 0 && prices.current > 0)) return false;
            return prices.current < prices.peak;
        }).sort(function (a, b) {
            return normalizedBouncePct(b) - normalizedBouncePct(a) ||
                lowDrawdownPct(b) - lowDrawdownPct(a);
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

    function leaderGroupTile(group, type, label, emptyText) {
        if (!group) {
            return '<article class="report-leader-tile report-leader-tile--empty">' +
                '<span class="report-leader-tile__label">' + esc(label) + '</span>' +
                '<strong>' + esc(emptyText) + '</strong>' +
            '</article>';
        }
        var top = group.stocks && group.stocks[0];
        var topText = top ? esc(top.name || top.ticker) + ' ' + pct(top.change_rate, 1) : '';
        return '<article class="report-leader-tile">' +
            '<span class="report-leader-tile__label">' + esc(label) + '</span>' +
            '<a class="report-leader-tile__name" href="' + esc(screeningUrl(type, group.key)) + '">' + esc(group.key) + '</a>' +
            '<span class="report-leader-tile__meta">' + group.count + '종목 · 평균 ' + pct(group.avgRate, 1) + ' · 거래 ' + fmtAmount(group.totalVolume) + '</span>' +
            (topText ? '<span class="report-leader-tile__sub">' + topText + '</span>' : '') +
        '</article>';
    }

    function renderLeader(row, sectorGroup, themeGroup) {
        var el = $('leaderCard');
        if (!el) return;
        if (!row) {
            el.innerHTML = '<div class="report-empty">오늘 기준에 맞는 대장이 없습니다.</div>';
            return;
        }
        var theme = themeOf(row);
        var reason = reasonOf(row);
        var sectorTheme = [row.sector, theme].filter(Boolean).join(' · ');
        var detailTag = theme || row.sector || '대장';
        var detailText = '[' + detailTag + '] ' + (reason || sectorTheme || '거래대금 상위 종목');

        el.innerHTML = '<article class="report-leader-card ' + ratingClass(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' +
            '<div class="report-leader-grid">' +
                '<section class="report-leader-tile report-leader-tile--stock">' +
                    '<span class="report-leader-tile__label">대장주</span>' +
                    stockNameHtml(row, 'report-leader-card__name') +
                    '<span class="report-leader-tile__meta"><strong class="cell-change--up">' + pct(row.change_rate) + '</strong> · 거래 ' + fmtAmount(row.trading_value) + '</span>' +
                    '<span class="report-leader-tile__sub">' + esc(detailText) + '</span>' +
                '</section>' +
                leaderGroupTile(sectorGroup, 'sector', '대장섹터', '주도 섹터 없음') +
                leaderGroupTile(themeGroup, 'theme', '대장테마', '핫 테마 없음') +
            '</div>' +
        '</article>';
    }

    function groupStockHtml(row) {
        return '<span class="report-group-stock ' + ratingClass(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' +
            '<span class="report-group-stock__name cell-name__wrap">' +
                '<a href="' + stockUrl(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' + esc(row.name || row.ticker) + '</a>' +
                miniIndicatorsHtml(row.ticker) +
                starRatingHtml(row.ticker) +
            '</span>' +
            '<span class="report-group-stock__meta">' +
                '<strong class="cell-change--up">' + pct(row.change_rate, 1) + '</strong>' +
                '<span>거래 ' + fmtAmount(row.trading_value) + '</span>' +
            '</span>' +
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
            var stocks = g.stocks.slice(0, GROUP_TOP_STOCKS).map(groupStockHtml).join('');
            return '<article class="report-group-row" data-group="' + esc(g.key) + '">' +
                '<div class="report-group-row__rank">' + (i + 1) + '</div>' +
                '<div class="report-group-row__main">' +
                    '<div class="report-group-row__titleline">' +
                        '<a class="report-group-row__name" href="' + esc(screeningUrl(type, g.key)) + '">' + esc(g.key) + '</a>' +
                        '<span class="report-group-row__count">' + g.count + '종목</span>' +
                    '</div>' +
                    '<div class="report-group-row__meta">' +
                        '<span>평균 <strong class="cell-change--up">' + pct(g.avgRate) + '</strong></span>' +
                        '<span>거래 <strong>' + fmtAmount(g.totalVolume) + '</strong></span>' +
                    '</div>' +
                '</div>' +
                '<div class="report-group-row__stocks">' + stocks + '</div>' +
            '</article>';
        }).join('');
    }

    // 급등 신규 — 라이브 union 중 오늘 빌드 rankings 에 없는 +NEW_CUTOFF% 종목 (시세만, 이유 미정).
    function deriveNewcomers(rankings) {
        if (state.dateIndex !== 0 || !state.live) return [];
        var have = {};
        (rankings || []).forEach(function (r) { if (r && r.ticker) have[r.ticker] = 1; });
        var out = [];
        Object.keys(state.live).forEach(function (tk) {
            if (have[tk] || BLOCKED_TICKERS[tk]) return;
            var lv = state.live[tk] || {};
            if (num(lv.change_rate) < NEW_CUTOFF) return;
            out.push({
                ticker: tk,
                name: lv.name || tk,
                market: lv.market || '',
                change_rate: num(lv.change_rate),
                trading_value: num(lv.trading_value),
            });
        });
        out.sort(function (a, b) {
            return b.change_rate - a.change_rate || b.trading_value - a.trading_value;
        });
        return out.slice(0, NEW_TOP);
    }

    function renderNewcomers(rows) {
        var section = $('newcomerSection');
        var el = $('newcomerList');
        if (!el) return;
        if (!rows.length) {
            if (section) section.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        if (section) section.style.display = '';
        el.innerHTML = rows.map(function (row) {
            return '<span class="report-group-stock ' + ratingClass(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' +
                '<span class="report-group-stock__name cell-name__wrap">' +
                    '<a href="' + stockUrl(row.ticker) + '" data-ticker="' + esc(row.ticker) + '">' + esc(row.name) + '</a>' +
                    (row.market ? '<span class="report-stock-market">' + esc(row.market) + '</span>' : '') +
                '</span>' +
                '<span class="report-group-stock__meta">' +
                    '<strong class="cell-change--up">' + pct(row.change_rate, 1) + '</strong>' +
                    '<span>거래 ' + fmtAmount(row.trading_value) + '</span>' +
                    '<span class="theme-tag">이유 분석 대기중</span>' +
                '</span>' +
            '</span>';
        }).join('');
    }

    function renderHigh52w(rows) {
        var el = $('high52wList');
        if (!el) return;
        if (!rows.length) {
            el.innerHTML = '<tr><td colspan="7" class="report-empty">오늘 52주 신고가를 돌파한 종목이 없습니다.</td></tr>';
            return;
        }
        el.innerHTML = rows.map(function (row, i) {
            var tEsc = esc(row.ticker);
            var rowClasses = [ratingClass(row.ticker)];
            if (num(row.change_rate) >= 29.9) rowClasses.push('row--limit-up');
            var theme = shortenTheme(themeOf(row));
            var reason = reasonOf(row);
            var meta = [];
            if (row.market) meta.push(esc(row.market));
            if (row.sector) meta.push(esc(row.sector));
            if (row.market_cap) meta.push('시총 ' + fmtAmount(row.market_cap));
            if (row.trading_value) meta.push('거래 ' + fmtAmount(row.trading_value));
            return '<tr class="' + rowClasses.join(' ').trim() + '" data-ticker="' + tEsc + '">' +
                '<td class="cell-rank">' + (i + 1) + '</td>' +
                '<td class="cell-name"><div class="cell-name__wrap">' +
                    '<a href="' + stockUrl(row.ticker) + '" class="cell-name__link" data-ticker="' + tEsc + '">' + esc(row.name || row.ticker) + '</a>' +
                    miniIndicatorsHtml(row.ticker) +
                    '<span class="cell-name__market">' + esc(row.market || '-') + '</span>' +
                    starRatingHtml(row.ticker) +
                '</div></td>' +
                '<td class="cell-reason"><div class="cell-reason__inline">' +
                    (theme ? '<span class="theme-tag">' + esc(theme) + '</span>' : '') +
                    '<span class="cell-reason__text">' + esc(reason || '52주 신고가 돌파') + '</span>' +
                '</div></td>' +
                '<td class="cell-change">' + formatChangeRate(row.change_rate) + '</td>' +
                '<td class="cell-volume">' + fmtAmount(row.trading_value) + '</td>' +
                '<td class="cell-cap">' + fmtAmount(row.market_cap) + '</td>' +
                '<td class="cell-sector">' + esc(row.sector || '-') + '</td>' +
                '<td class="cell-meta-compact">' + meta.join(' · ') + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderPullbacks(rows) {
        var el = $('pullbackList');
        if (!el) return;
        if (!rows.length) {
            el.innerHTML = '<li class="report-empty">조건에 맞는 조정 후 반등 시도 종목이 없습니다.</li>';
            return;
        }
        el.innerHTML = rows.map(function (pb) {
            var p = pullbackPrices(pb);
            var drawdown = currentDrawdownPct(pb);
            var lowDrop = lowDrawdownPct(pb);
            var bounce = normalizedBouncePct(pb);
            var row = {
                ticker: pb.ticker,
                name: pb.name,
                market: pb.market,
            };
            return '<li class="report-move-row ' + ratingClass(pb.ticker) + '" data-ticker="' + esc(pb.ticker) + '">' +
                '<div class="report-move-row__stock">' + stockNameHtml(row, 'report-move-row__name') + '</div>' +
                '<div class="report-move-row__metrics">' +
                    '<span class="report-move-metric"><span class="report-move-metric__top"><strong>' + fmtPrice(p.peak) + '</strong><em>고점</em></span><small class="report-rate--down">현재가 대비 ' + pctDown(drawdown) + '</small></span>' +
                    '<span class="report-move-metric"><span class="report-move-metric__top"><strong>' + fmtPrice(p.low) + '</strong><em>저점</em></span><small class="report-rate--down">고점 대비 ' + pctDown(lowDrop) + '</small></span>' +
                    '<span class="report-move-metric"><span class="report-move-metric__top"><strong>' + fmtPrice(p.current) + '</strong><em>현재</em></span><small class="cell-change--up">저점 대비 ' + pct(bounce, 1) + '</small></span>' +
                '</div>' +
            '</li>';
        }).join('');
    }

    // 라이브 숫자 오버레이 — 최신일 && live 맵 있을 때만, ticker 단위 4숫자만 덮어쓴 '복사본 배열' 반환(불변).
    // 빌드 캐시 객체(state.day = getRankings 5분 캐시)를 절대 변형하지 않아 파생(컷/그룹/대장) baseline 오염 방지.
    // 세부필드(섹터/테마/상승이유/뉴스/풀백)는 미변경. change_rate 가 모든 파생 입력이라 파생 전에 오버레이된 행으로 계산.
    function _overlaidRankings(day) {
        var rows = (day && day.rankings) || [];
        if (state.dateIndex !== 0 || !state.live) return rows;
        var live = state.live;
        return rows.map(function (row) {
            var lv = live[row.ticker];
            if (!lv) return row;
            var o = Object.assign({}, row);
            if (lv.change_rate != null) o.change_rate = lv.change_rate;
            if (lv.close_price != null) o.close_price = lv.close_price;
            if (lv.trading_value != null) o.trading_value = lv.trading_value;
            if (lv.market_cap != null) o.market_cap = lv.market_cap * 1e8;   // 억원 → 원 (fmtAmount 원 기대)
            return o;
        });
    }

    // 라이브 사이클 — 최신일·장중·포그라운드일 때만 폴링. fetch 완료 후 다음 사이클 예약 → 느린 응답(최대 30s)이
    // 와도 타이머 중첩/동시 fetch 없음(단일 타이머). 어떤 실패도 catch 해 빌드값 유지(오류 미노출).
    var _wasOpen = false;       // 장중→마감 전이 감지 (확정 종가 1회 재확보)
    function liveCycle() {
        var latest = state.dateIndex === 0 && document.visibilityState !== 'hidden';
        var clockOpen = isMarketOpen();
        // 서버 market_status 가 권위 — 로컬 시계가 장중이어도 공휴일이면 서버는 CLOSE.
        // ''(미확인) 은 로컬 시계 신뢰 (첫 fetch 실패 시 폴링이 영구 정지하지 않도록).
        var statusClosed = clockOpen && state.marketStatus === 'CLOSE';
        var open = clockOpen && !statusClosed;
        // 장중→마감 전이 — 동시호가 확정 종가를 잠시 후 1회 더 받도록 liveOnce 재무장
        if (_wasOpen && !clockOpen) {
            _wasOpen = false;
            setTimeout(function () { state.liveOnce = false; }, CLOSE_SETTLE_MS);
        }
        if (open) _wasOpen = true;
        // 장중이면 매 주기 라이브 오버레이. 장 마감·장전이라도 최신일이면 '실제 종가'를 최소 1회는 받아온다.
        // statusClosed(공휴일/오판) 면 5분 간격으로만 재확인 — 상태가 OPEN 으로 돌아오면 자동 복구.
        var fetchNow = latest && (open || !state.liveOnce || statusClosed);
        var p = Promise.resolve();
        if (fetchNow) {
            p = WhyAPI.getLiveMarketmap().then(function (res) {
                state.liveOnce = true;
                state.marketStatus = res.market_status || state.marketStatus;
                if (state.dateIndex !== 0) return;   // fetch 중 과거 날짜로 이동 — 라이브/시각 오염 방지
                state.live = res.map;
                if (res.updated_at) setUpdatedAt(res.updated_at);   // 빌드시각 대신 라이브 갱신시각 표시
                applyDay();   // state.day(빌드) + state.live 로 재파생·재렌더 (네트워크 호출 없음)
            }).catch(function () {});
            // 빌드 데이터도 주기 재조회 (클라 5분 캐시 — 네트워크는 5분당 1회) —
            // 신규 급등주 '이유 분석 대기중' 이 빌드 도착 시 정식 행으로 자동 승격.
            if (open && state.dates.length) {
                WhyAPI.getRankings(state.dates[0]).then(function (data) {
                    if (state.dateIndex !== 0 || !data || !state.day) return;
                    if (data.collected_at && data.collected_at !== state.day.collected_at) {
                        state.day = data;
                        applyDay();
                    }
                }).catch(function () {});
            }
        }
        p.then(function () {
            state.liveTimer = setTimeout(liveCycle,
                open ? LIVE_POLL_MS : (statusClosed ? STATUS_RECHECK_MS : IDLE_RECHECK_MS));
        });
    }

    // 풀백 행도 라이브 현재가로 재계산 — '현재' 가격·저점 대비 반등률이 장중 실시간이 됨.
    // rankings 오버레이와 동일한 불변 복사 패턴 (state.day.pullbacks 미변형).
    function _overlaidPullbacks(pullbacks) {
        if (state.dateIndex !== 0 || !state.live) return pullbacks || [];
        return (pullbacks || []).map(function (pb) {
            var lv = pb && pb.ticker ? state.live[pb.ticker] : null;
            if (!lv || !(num(lv.close_price) > 0)) return pb;
            var o = Object.assign({}, pb);
            o.currentPrice = lv.close_price;   // pullbackPrices 의 1순위 키 — 반등률/낙폭 라이브 재계산
            // 라이브 현재가가 기존 저점 아래면 저점도 갱신 (고점 후 최저가 의미 유지)
            var low = firstNum(pb, ['postPeakLow', 'lowPrice', 'low_price', 'troughPrice', 'bottomPrice', 'low']);
            if (low > 0 && lv.close_price < low) o.postPeakLow = lv.close_price;
            return o;
        });
    }

    function applyDay() {
        var day = state.day;
        if (!day) return;
        var date = state.dates[state.dateIndex] || '';
        var rankings = _overlaidRankings(day);   // 불변 오버레이 — state.day 미변경, 파생 오염 방지
        var riseRows = activeRiseRows(rankings);
        var sectors = buildGroups(riseRows, 'sector');
        var themes = buildGroups(riseRows, 'theme');
        var leader = pickLeader(riseRows, sectors, themes);
        // 52주 신고가 멤버십은 빌드 확정치로 판정 — 라이브 등락률·현재가 출렁임으로
        // '오늘 신고가 기록' 종목이 장중에 목록에서 사라지는 문제 방지. 표시 숫자만 라이브로 교체.
        var highRows = deriveHigh52w((day && day.rankings) || [], date);
        if (state.dateIndex === 0 && state.live) {
            var overlaidByTicker = {};
            rankings.forEach(function (r) { if (r && r.ticker) overlaidByTicker[r.ticker] = r; });
            highRows = highRows.map(function (r) { return overlaidByTicker[r.ticker] || r; });
        }
        var newcomers = deriveNewcomers(rankings);
        var pullbacks = derivePullbacks(_overlaidPullbacks(day.pullbacks || []));

        renderLeader(leader, sectors[0], themes[0]);
        renderGroups(sectors, 'sectorGroups', 'sector', '3종목 이상 몰린 주도 섹터가 없습니다.');
        renderGroups(themes, 'themeGroups', 'theme', '3종목 이상 몰린 핫 테마가 없습니다.');
        renderNewcomers(newcomers);
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
        state.liveOnce = false;   // 날짜 변경 시 재무장 — 최신일로 돌아오면 실제 종가 1회 재확보
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
                if (!requirePersonal('interest')) return;
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
                if (!requirePersonal('exclude')) return;
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
                if (!requirePersonal('memo')) return;
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
                if (!requirePersonal('memo')) return;
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
                if (!requirePersonal('memo')) return;
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
        window.addEventListener('whyrise:ratings-updated', function (e) {
            state.ratings = (e.detail && e.detail.ratings) || {};
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
                    if (result && result.ratings) {
                        state.ratings = result.ratings;
                        applyDay();
                    }
                    return null;
                });
            }
            return null;
        }).then(function () {
            if (state.dates.length && !state.liveTimer) liveCycle();   // 라이브 사이클 1회 기동(단일 타이머)
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', WhyReport.init);
