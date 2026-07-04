/**
 * 리포트 페이지 - Whyrise compact report.
 *
 * 기준:
 * - 주도 섹터/핫 테마: 그날 +15% 이상 종목 중 3종목 이상 그룹만 표시
 * - 오늘의 대장: 상승 에너지(거래대금×상승률, 30%캡) 최대 종목 — 후보는 +5% 이상, 에너지 8조·% 미만이면 그날 대장 없음
 * - 52주 신고가: +10% 이상 상승하면서 해당 날짜에 52주 신고가를 기록한 종목
 * - 조정 후 반등 시도: +15% 이상 급등 후 저점 -20% 이상, 저점 대비 현재가 +15% 이상, 이전 고점 미회복
 */
var WhyReport = (function () {
    'use strict';

    var STORAGE_KEY = 'whyrise-ratings';
    var THEME_KEY = 'theme';
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };

    var RISE_CUTOFF = 15;
    // ── 대장주 황금식 (2026-07 개편) — report-core.js pickLeader 와 동일 상수·로직 ──
    // 점수(상승 에너지) = 거래대금(원) × 상승률(%, 30캡). 컷 계단(+15% 등) 없이 단일 곱셈으로
    // "상승에 실린 돈"이 가장 큰 종목이 대장 — 거래대금 2배 = 상승률 2배 등가.
    // 후보 풀 = 급등 랭킹(+10%↑) + marketmap 대형주 스냅샷(+5%대) 병합 → 삼성전자·SK하이닉스가
    // +5~10% 로 수조원 터진 날도 대장으로 잡힌다.
    var LEADER_MIN_RATE = 5;          // 후보 최소 상승률(%) — 이 밑은 대장 자격 없음
    var LEADER_MIN_SCORE = 8e12;      // 최소 상승 에너지(원×%) — 예: 3,000억×+27% ≈ 1조×+8%. 미달이면 그날 대장 없음
    // 대장주 비교용 '상승률 캡'(%). +30% 초과는 신규상장·재상장 등 이벤트성(가격제한 무관 또는 첫날 무제한)이라
    // 동일 조건 비교를 깨뜨린다. 비교 계산(점수·정렬)에서만 이 값으로 캡하고, 후보에선 제외하지 않으며
    // 화면 표시는 원래 상승률을 그대로 쓴다. → 저거래·초고상승 종목의 대장 독식 방지.
    var LEADER_RATE_CAP = 30;
    var HIGH52_CUTOFF = 10;
    var GROUP_MIN = 3;
    var GROUP_TOP_STOCKS = 4;
    var PB_PEAK_MIN = 15;
    var PB_DROP_MIN = 25;     // 고점 대비 낙폭 컷 (조정 깊이) — 너무 많이 잡혀 20→25 강화
    var PB_BOUNCE_MIN = 25;   // 저점 대비 반등 컷 — 15→25 강화 (확실히 반등 중인 것만)

    // 라이브 숫자 오버레이 — 15s 주기(home 과 동일). /api/marketmap 병렬화로 ~3s 응답이라 단축.
    var LIVE_POLL_MS = 15 * 1000;
    var IDLE_RECHECK_MS = 5000;            // 비라이브 상태 재확인 주기
    var STATUS_RECHECK_MS = 5 * 60 * 1000; // 서버 CLOSE(공휴일/오판) 재확인 주기
    var CLOSE_SETTLE_MS = 90 * 1000;       // 마감 후 확정 종가 fetch 지연 (동시호가 체결 대기)
    // 급등 신규 — 빌드(stock-rise 일자 rankings)에 아직 없는데 라이브 union 에서 +N% 인 종목.
    // 오버레이는 기존 행 숫자만 갱신 → 새 종목은 못 잡으므로 별도 슬롯에 '시세만' 노출(이유 분석 대기중).
    var KST_OFFSET = 9 * 60, OPEN_MIN = 8 * 60, CLOSE_MIN = 15 * 60 + 30; // NXT 시작 08:00부터 라이브 대기
    function isMarketOpen() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }
    function isNxtLeadIn() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < 9 * 60;
    }

    var state = {
        dates: [],
        dateIndex: 0,
        day: null,
        ratings: {},
        live: null,        // /api/marketmap ticker→숫자 맵 (라이브 오버레이용)
        liveDate: '',      // 라이브 거래일(/api/marketmap date) — 빌드 날짜와 다르면 오버레이 보류(stale 가드)
        liveTimer: null,   // 단일 라이브 사이클 타이머
        liveOnce: false,   // 최신일 '실제 종가' 1회 확보 여부 — 장 마감·장전에도 최소 1회는 라이브 fetch
        marketStatus: '',  // ''=미확인(로컬 시계 신뢰) | 'OPEN' | 'CLOSE' (서버 판정 — 공휴일 포함)
        _pbFallback: null,        // 장중 폴백: 직전 마감일 pullbacks (현재가 오버레이 base)
        _pbFallbackDate: '',      // 그 직전 마감일 (YYYYMMDD)
        _pbFallbackFetching: false,
        mmExtras: {},             // date → marketmap 스냅샷의 대장 후보 행(+4%↑ 대형주). null=조회중, []=없음/실패
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

    // 대장주 비교 전용: 상승률을 LEADER_RATE_CAP(=30%)로 상한. 표시·후보판정엔 쓰지 않는다.
    function capRate(row) {
        return Math.min(num(row && row.change_rate), LEADER_RATE_CAP);
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

    // 상승 에너지 — 대장주 점수 그 자체 (원 × %)
    function leaderEnergy(row) {
        return num(row && row.trading_value) * capRate(row);
    }

    // extraRows: 급등 랭킹 밖 후보(marketmap 대형주 +5%대 등).
    // ticker 중복 시 상승 에너지 큰 쪽 '숫자'를 신뢰(랭킹 원본의 거래대금 결손 방어),
    // 상승이유·테마 등 서술 필드는 랭킹 쪽을 유지한다.
    function pickLeader(rows, sectors, themes, extraRows) {
        var byTicker = {};
        var order = [];
        (rows || []).concat(extraRows || []).forEach(function (row) {
            if (!row || !row.ticker || BLOCKED_TICKERS[row.ticker]) return;
            if (!(num(row.change_rate) >= LEADER_MIN_RATE && num(row.trading_value) > 0)) return;
            var prev = byTicker[row.ticker];
            if (!prev) { byTicker[row.ticker] = row; order.push(row.ticker); return; }
            if (leaderEnergy(row) > leaderEnergy(prev)) {
                byTicker[row.ticker] = Object.assign({}, prev, {
                    change_rate: row.change_rate,
                    trading_value: row.trading_value,
                    close_price: row.close_price != null ? row.close_price : prev.close_price,
                    market_cap: row.market_cap != null ? row.market_cap : prev.market_cap,
                });
            }
        });
        var pool = order.map(function (t) { return byTicker[t]; });
        if (!pool.length) return null;
        var maps = groupMaps(sectors, themes);
        // 상승률은 캡값으로 비교 — +500% 이벤트 종목도 +30%로 환산돼 대장 독식 방지.
        pool.sort(function (a, b) {
            return leaderEnergy(b) - leaderEnergy(a) ||
                num(b.trading_value) - num(a.trading_value) ||
                capRate(b) - capRate(a);
        });
        if (leaderEnergy(pool[0]) < LEADER_MIN_SCORE) return null;   // 에너지 미달 → 그날은 대장주 없음
        var leader = Object.assign({}, pool[0]);
        leader._leaderScore = leaderEnergy(pool[0]);
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

    // 현재가가 과거 고점 이상 = '고점 회복'(그날 졸업). 라이브 현재가로만 발생(과거 빌드 데이터엔 없음).
    function isRecovered(pb) {
        if (pb && pb.recovered) return true;   // 빌드가 저장한 '졸업' 플래그 (마감 후·과거 조회에도 유지)
        var p = pullbackPrices(pb);
        return p.peak > 0 && p.current > 0 && p.current >= p.peak;
    }

    function derivePullbacks(pullbacks) {
        return (pullbacks || []).filter(function (pb) {
            if (!pb || !pb.ticker || BLOCKED_TICKERS[pb.ticker]) return false;
            // 고점 회복(졸업) 종목은 급등률/반등률 컷 면제 — 회복 자체가 강한 신호. 조정 깊이만 확인.
            // (신고가로 고점이 잡힌 종목도 회복하면 표시되도록)
            var rec = isRecovered(pb);
            if (!rec && peakRateFromPullback(pb) < PB_PEAK_MIN) return false;
            if (!rec && lowDrawdownPct(pb) < PB_DROP_MIN) return false;
            if (!rec && normalizedBouncePct(pb) < PB_BOUNCE_MIN) return false;
            var prices = pullbackPrices(pb);
            // 고점 회복(current>=peak) 종목도 그날은 포함 — '고점회복' 배지로 맨 위에 표시 후 다음 날 빠짐
            return prices.peak > 0 && prices.current > 0;
        }).sort(function (a, b) {
            // 고점 회복 종목을 맨 위로, 그다음은 반등률·낙폭 순
            var ra = isRecovered(a) ? 1 : 0, rb = isRecovered(b) ? 1 : 0;
            if (ra !== rb) return rb - ra;
            return normalizedBouncePct(b) - normalizedBouncePct(a) ||
                lowDrawdownPct(b) - lowDrawdownPct(a);
        });
    }

    function stockNameHtml(row, className, suffixHtml) {
        var ticker = esc(row.ticker);
        var market = row.market ? '<span class="report-stock-market">' + esc(row.market) + '</span>' : '';
        return '<span class="' + className + ' cell-name__wrap">' +
            '<a class="report-stock-name cell-name__link" href="' + stockUrl(row.ticker) + '" data-ticker="' + ticker + '">' + esc(row.name || row.ticker) + '</a>' +
            miniIndicatorsHtml(row.ticker) +
            market +
            (suffixHtml || '') +
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
        // 대장주·대장섹터·대장테마는 독립 판정 — 종목 기준 미달이어도 섹터/테마 타일은 그대로 노출
        if (!row && !sectorGroup && !themeGroup) {
            el.innerHTML = '<div class="report-empty">오늘 기준에 맞는 대장이 없습니다.</div>';
            return;
        }
        var stockTile;
        if (row) {
            var theme = themeOf(row);
            var reason = reasonOf(row);
            var sectorTheme = [row.sector, theme].filter(Boolean).join(' · ');
            var detailTag = theme || row.sector || '대장';
            var detailText = '[' + detailTag + '] ' + (reason || sectorTheme || '거래대금 상위 종목');
            stockTile = '<section class="report-leader-tile report-leader-tile--stock">' +
                '<span class="report-leader-tile__label">대장주</span>' +
                stockNameHtml(row, 'report-leader-card__name') +
                '<span class="report-leader-tile__meta"><strong class="cell-change--up">' + pct(row.change_rate) + '</strong> · 거래 ' + fmtAmount(row.trading_value) + '</span>' +
                '<span class="report-leader-tile__sub">' + esc(detailText) + '</span>' +
            '</section>';
        } else {
            stockTile = '<section class="report-leader-tile report-leader-tile--stock report-leader-tile--empty">' +
                '<span class="report-leader-tile__label">대장주</span>' +
                '<strong>대장주 없음</strong>' +
                '<span class="report-leader-tile__sub">상승 에너지(상승률×거래대금) 기준 미달</span>' +
            '</section>';
        }

        el.innerHTML = '<article class="report-leader-card' +
            (row ? ' ' + ratingClass(row.ticker) + '" data-ticker="' + esc(row.ticker) : '') + '">' +
            '<div class="report-leader-grid">' +
                stockTile +
                leaderGroupTile(sectorGroup, 'sector', '대장섹터', '주도 섹터 없음') +
                leaderGroupTile(themeGroup, 'theme', '대장테마', '핫 테마 없음') +
            '</div>' +
        '</article>';
    }

    // ── 오늘의 대장 카드 이미지 저장 — 실제 모바일 뷰를 html2canvas 로 캡처 + ORGO 워터마크 ──
    // 시각화 savePNG 는 SVG 직렬화지만 대장 카드는 HTML 이라, DOM 을 그대로 캡처한다(새로 그리지 않음).
    var LEADER_CAPTURE_W = 400;   // 캡처용 모바일 폭 — PC 에서 눌러도 모바일 세로 레이아웃으로 산출

    // 캡처 canvas 위에 워터마크 헤더(시각화 savePNG 와 동일 톤) 합성 → 최종 canvas
    function _leaderWatermark(cardCanvas, light) {
        var R = 2;                       // 캡처 scale 과 동일 (선명도)
        var W = cardCanvas.width;        // 실제 픽셀
        var HEAD = 46 * R;
        var out = document.createElement('canvas');
        out.width = W; out.height = cardCanvas.height + HEAD;
        var ctx = out.getContext('2d');
        var bg = light ? '#ffffff' : '#0a0b0f';
        var fg = light ? '#0a0b0f' : '#ffffff';
        var dim = light ? 'rgba(10,11,15,0.55)' : 'rgba(255,255,255,0.55)';
        var line = light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
        var FONT = 'Pretendard, "Pretendard Variable", -apple-system, "Noto Sans KR", sans-serif';
        var PX = 20 * R, BY = 28 * R;
        ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = fg; ctx.font = '800 ' + (16 * R) + 'px ' + FONT;
        ctx.fillText('ORGO', PX, BY);
        var lw = ctx.measureText('ORGO').width;
        ctx.fillStyle = dim; ctx.font = '600 ' + (13 * R) + 'px ' + FONT;
        ctx.fillText('orgo.kr', PX + lw + 10 * R, BY);
        ctx.textAlign = 'right';
        ctx.fillStyle = fg; ctx.font = '700 ' + (13 * R) + 'px ' + FONT;
        ctx.fillText('오늘의 대장 · ' + formatDate(state.dates[state.dateIndex] || ''), W - PX, BY);
        ctx.strokeStyle = line; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, HEAD - 0.5); ctx.lineTo(W, HEAD - 0.5); ctx.stroke();
        ctx.drawImage(cardCanvas, 0, HEAD);
        return out;
    }

    function downloadLeaderCard() {
        if (typeof html2canvas === 'undefined') return;
        var card = $('leaderCard');
        if (!card) return;
        var light = document.documentElement.getAttribute('data-theme') === 'light';
        var bg = light ? '#ffffff' : '#0a0b0f';
        // 오프스크린에 모바일 폭으로 클론 — 실제 모바일 세로 레이아웃 그대로 캡처(PC 에서도 동일)
        var holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + LEADER_CAPTURE_W +
            'px;padding:16px;background:' + bg + ';box-sizing:border-box;';
        if (light) holder.setAttribute('data-theme', 'light');
        var clone = card.cloneNode(true);
        var grid = clone.querySelector('.report-leader-grid');
        if (grid) grid.style.gridTemplateColumns = '1fr';   // PC 가로 3열 → 모바일 세로 강제
        holder.appendChild(clone);
        document.body.appendChild(holder);

        function cleanup() { if (holder.parentNode) holder.parentNode.removeChild(holder); }
        function run() {
            html2canvas(holder, { scale: 2, backgroundColor: bg, useCORS: true, logging: false })
                .then(function (cardCanvas) {
                    cleanup();
                    _leaderWatermark(cardCanvas, light).toBlob(function (blob) {
                        if (!blob) return;
                        var url = URL.createObjectURL(blob);
                        var a = document.createElement('a');
                        a.href = url;
                        a.download = 'orgo-leader-' + (state.dates[state.dateIndex] || 'today') + '.png';
                        document.body.appendChild(a); a.click(); a.remove();
                        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
                    }, 'image/png');
                })
                .catch(cleanup);
        }
        // 폰트(Pretendard) 로드 후 캡처해야 글꼴이 정확
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
        else run();
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
            // 최신일인데 오늘이 아직 마감 전(intraday)이면 '없음'이 아니라 '집계 전' 안내
            var pending = state.dateIndex === 0 && state.day && !state.day.is_final;
            el.innerHTML = '<li class="report-empty">' +
                (pending ? '오늘 데이터는 장 마감 후 집계됩니다.' : '조건에 맞는 조정 후 반등 시도 종목이 없습니다.') +
                '</li>';
            return;
        }
        el.innerHTML = rows.map(function (pb) {
            var p = pullbackPrices(pb);
            var drawdown = currentDrawdownPct(pb);
            var lowDrop = lowDrawdownPct(pb);
            var bounce = normalizedBouncePct(pb);
            var rec = isRecovered(pb);
            var row = {
                ticker: pb.ticker,
                name: pb.name,
                market: pb.market,
            };
            var recBadge = rec ? '<span class="report-recover-badge" style="display:inline-flex;align-items:center;margin-left:6px;padding:2px 7px;border-radius:999px;font-size:10.5px;font-weight:800;background:var(--wr-accent-soft,rgba(49,130,246,.14));color:var(--wr-accent,#3182F6);vertical-align:middle;white-space:nowrap;">고점회복</span>' : '';
            var firstCell = rec
                ? '<small class="cell-change--up">고점 회복</small>'
                : '<small class="report-rate--down">현재가 대비 ' + pctDown(drawdown) + '</small>';
            return '<li class="report-move-row ' + ratingClass(pb.ticker) + '" data-ticker="' + esc(pb.ticker) + '">' +
                '<div class="report-move-row__stock">' + stockNameHtml(row, 'report-move-row__name', recBadge) + '</div>' +
                '<div class="report-move-row__metrics">' +
                    '<span class="report-move-metric"><span class="report-move-metric__top"><strong>' + fmtPrice(p.peak) + '</strong><em>고점</em></span>' + firstCell + '</span>' +
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
        // 빌드가 라이브 거래일과 다르면(오늘 빌드 미도착 — 장전·NXT·장초반) 오버레이 안 함:
        // 어제 확정 빌드 위에 오늘 시세를 덮어 대장/주도섹터/핫테마를 잘못 재선정하는 것 방지
        // (예: 16일 확정 대장이 17일 장중 급등주로 뒤바뀜). 오늘 빌드 도착 시 정상 오버레이.
        var buildDate = state.dates[state.dateIndex] || '';
        if (state.liveDate && buildDate && state.liveDate !== buildDate) return rows;
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
        // 리포트는 08~09시 NXT 프리마켓을 라이브에서 제외한다 — 대장/주도섹터/핫테마는
        // 정규장 상승분만으로 산출(사용자 요청: NXT 시세는 홈·시각화에만 반영). 프리마켓엔
        // 직전 정규장 빌드를 그대로 보여주고, 09:00 정규장 개장부터 라이브 오버레이를 재개해
        // 전체 반영한다. (홈/treemap/bubbles2 의 08:00~ 라이브 창과 의도적으로 다름.)
        var nxtLeadIn = isNxtLeadIn();
        var clockOpen = isMarketOpen() && !nxtLeadIn;   // 리포트 라이브 창 = 정규장(09:00~15:30)
        // 정규장 시간인데 서버가 CLOSE(공휴일/오판) 면 5분 간격 재확인 — OPEN 복귀 시 자동 복구.
        var statusClosed = clockOpen && state.marketStatus === 'CLOSE';
        var open = clockOpen && !statusClosed;
        // 장중→마감 전이 — 동시호가 확정 종가를 잠시 후 1회 더 받도록 liveOnce 재무장
        if (_wasOpen && !clockOpen) {
            _wasOpen = false;
            setTimeout(function () { state.liveOnce = false; }, CLOSE_SETTLE_MS);
        }
        if (open) _wasOpen = true;
        // 프리마켓(nxtLeadIn)엔 fetch 자체를 건너뜀 — !state.liveOnce 경로로도 NXT 가 새지 않게.
        // 정규장이면 매 주기 오버레이, 마감/장전이라도 최신일이면 '실제 종가'를 최소 1회는 받아온다.
        var fetchNow = latest && !nxtLeadIn && (open || !state.liveOnce || statusClosed);
        var p = Promise.resolve();
        if (fetchNow) {
            p = WhyAPI.getLiveMarketmap().then(function (res) {
                state.liveOnce = true;
                state.marketStatus = res.market_status || state.marketStatus;
                state.liveDate = res.date || state.liveDate;   // 라이브 거래일 — 오버레이 stale 가드 기준
                if (state.dateIndex !== 0) return;   // fetch 중 과거 날짜로 이동 — 라이브/시각 오염 방지
                state.live = res.map;
                // 빌드가 오늘(라이브 거래일)분일 때만 라이브 갱신시각 표시 — 어제 빌드(stale)면 오버레이를
                // 안 하므로 시각도 빌드값 유지(어제 데이터에 오늘 시각이 붙는 모순 방지).
                if (res.updated_at && state.liveDate === state.dates[0]) setUpdatedAt(res.updated_at);
                applyDay();   // state.day(빌드) + state.live 로 재파생·재렌더 (네트워크 호출 없음)
            }).catch(function () {});
            // 빌드 재조회 — 새 거래일 빌드 도착 시 그 날짜로 전진(stale 가드 해제 → 오늘 확정 대장으로
            // 오버레이 재개). 같은 날 intraday 갱신은 collected_at 비교로 반영. (클라 5분 캐시.)
            if (open && state.dates.length) {
                WhyAPI.getDates().then(function (dts) {
                    if (state.dateIndex !== 0 || !state.day) return;
                    var latest = (Array.isArray(dts) ? dts[0] : (dts && dts.dates && dts.dates[0])) || '';
                    if (latest && latest > state.dates[0]) {
                        return WhyAPI.getRankings(latest).then(function (nd) {
                            if (state.dateIndex !== 0 || !nd || !nd.rankings) return;
                            state.dates.unshift(latest);
                            state.day = nd;
                            setUpdatedAt(nd.collected_at);
                            updateDateUI();
                            applyDay();
                        });
                    }
                    return WhyAPI.getRankings(state.dates[0]).then(function (data) {
                        if (state.dateIndex !== 0 || !data || !state.day) return;
                        if (data.collected_at && data.collected_at !== state.day.collected_at) {
                            state.day = data;
                            applyDay();
                        }
                    });
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
        // 빌드 ≠ 라이브 거래일이면 오버레이 안 함 (_overlaidRankings 와 동일 원칙).
        var buildDate = state.dates[state.dateIndex] || '';
        if (state.liveDate && buildDate && state.liveDate !== buildDate) return pullbacks || [];
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

    // ── 대장 후보 보강 — 급등 랭킹(+10%↑)에 없는 +5%대 초대형주(삼성전자 등)를 marketmap 일자
    // 스냅샷에서 합류시킨다. 스냅샷 없는 옛 날짜(2025-04 이전)는 빈 배열 → 랭킹만으로 산출(자연 폴백).
    function fetchLeaderExtras(date) {
        if (!date || state.mmExtras[date] !== undefined) return;
        state.mmExtras[date] = null;   // 조회중 마커 — 중복 fetch 방지
        fetch('/data/marketmap/' + date + '.json', { cache: 'no-cache' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        }).then(function (data) {
            var rows = [];
            ((data && data.items) || []).forEach(function (it) {
                // 후보 컷(5%)보다 낮은 4%에서 미리 자름 — 라이브 오버레이로 5%를 넘어설 여지
                if (!it || !it.ticker || num(it.change_rate) < 4) return;
                rows.push({
                    ticker: it.ticker, name: it.name, market: it.market || '',
                    sector: it.sector || '', rise_reason: '',
                    change_rate: it.change_rate, close_price: it.close_price,
                    trading_value: it.trading_value,
                    market_cap: num(it.market_cap) * 1e8,   // 억원 → 원
                });
            });
            state.mmExtras[date] = rows;
            if ((state.dates[state.dateIndex] || '') === date && rows.length) applyDay();
        }).catch(function () { state.mmExtras[date] = []; });
    }

    // 스냅샷 후보에 라이브 숫자 오버레이(_overlaidRankings 와 동일 원칙) + 스냅샷에 없는
    // 라이브 급등 대형주 합성. 과거 날짜는 스냅샷 그대로.
    function leaderExtras(date) {
        var rows = state.mmExtras[date] || [];
        if (state.dateIndex !== 0 || !state.live) return rows;
        var buildDate = state.dates[state.dateIndex] || '';
        if (state.liveDate && buildDate && state.liveDate !== buildDate) return rows;
        var live = state.live;
        var seen = {};
        var out = rows.map(function (row) {
            seen[row.ticker] = 1;
            var lv = live[row.ticker];
            if (!lv) return row;
            var o = Object.assign({}, row);
            if (lv.change_rate != null) o.change_rate = lv.change_rate;
            if (lv.close_price != null) o.close_price = lv.close_price;
            if (lv.trading_value != null) o.trading_value = lv.trading_value;
            if (lv.market_cap != null) o.market_cap = lv.market_cap * 1e8;
            return o;
        });
        Object.keys(live).forEach(function (ticker) {
            if (seen[ticker]) return;
            var lv = live[ticker];
            if (num(lv && lv.change_rate) < 4) return;
            out.push({
                ticker: ticker, name: lv.name || ticker, market: lv.market || '',
                sector: '', rise_reason: '',
                change_rate: lv.change_rate, close_price: lv.close_price,
                trading_value: lv.trading_value, market_cap: num(lv.market_cap) * 1e8,
            });
        });
        return out;
    }

    function applyDay() {
        var day = state.day;
        if (!day) return;
        var date = state.dates[state.dateIndex] || '';
        fetchLeaderExtras(date);                 // 첫 호출 때만 실제 fetch — 도착하면 applyDay 재실행
        var rankings = _overlaidRankings(day);   // 불변 오버레이 — state.day 미변경, 파생 오염 방지
        var riseRows = activeRiseRows(rankings);
        var sectors = buildGroups(riseRows, 'sector');
        var themes = buildGroups(riseRows, 'theme');
        // 대장 풀 = 랭킹 전체(+10%↑) + marketmap 후보 — riseRows(+15%↑)가 아니라 rankings 를 쓴다
        var leader = pickLeader(rankings, sectors, themes, leaderExtras(date));
        // 52주 신고가 멤버십은 빌드 확정치로 판정 — 라이브 등락률·현재가 출렁임으로
        // '오늘 신고가 기록' 종목이 장중에 목록에서 사라지는 문제 방지. 표시 숫자만 라이브로 교체.
        var highRows = deriveHigh52w((day && day.rankings) || [], date);
        if (state.dateIndex === 0 && state.live) {
            var overlaidByTicker = {};
            rankings.forEach(function (r) { if (r && r.ticker) overlaidByTicker[r.ticker] = r; });
            highRows = highRows.map(function (r) { return overlaidByTicker[r.ticker] || r; });
        }
        // 장중 최신일에 오늘 풀백이 아직 없으면(intraday) 직전 마감일 풀백을 base 로 사용 —
        // 현재가 오버레이(_overlaidPullbacks)가 낙폭·반등률을 실시간으로 재계산한다.
        var rawPb = (day.pullbacks && day.pullbacks.length) ? day.pullbacks : null;
        if (!rawPb && state.dateIndex === 0 && state._pbFallback && state._pbFallback.length) {
            rawPb = state._pbFallback;
        }
        var pullbacks = derivePullbacks(_overlaidPullbacks(rawPb || []));

        renderLeader(leader, sectors[0], themes[0]);
        renderGroups(sectors, 'sectorGroups', 'sector', '3종목 이상 몰린 주도 섹터가 없습니다.');
        renderGroups(themes, 'themeGroups', 'theme', '3종목 이상 몰린 핫 테마가 없습니다.');
        renderHigh52w(highRows);
        renderPullbacks(pullbacks);
        maybeFetchPbFallback();
    }

    // 장중(오늘 intraday) 최신일에 풀백이 비면 직전 마감일 풀백을 1회 끌어와 base 로 캐시한다.
    // 이후 liveCycle 의 현재가 오버레이로 '실시간 비슷'하게 노출. 오늘 마감 빌드 도착 시 자동 무시.
    function maybeFetchPbFallback() {
        if (state.dateIndex !== 0) return;
        var day = state.day;
        if (day && day.pullbacks && day.pullbacks.length) return;   // 오늘 마감 집계 있으면 폴백 불필요
        if (state._pbFallbackFetching) return;
        if (state._pbFallback && state._pbFallback.length) return;  // 이미 확보
        var prevDate = state.dates[1];
        if (!prevDate) return;
        state._pbFallbackFetching = true;
        WhyAPI.getRankings(prevDate).then(function (data) {
            state._pbFallbackFetching = false;
            if (data && data.pullbacks && data.pullbacks.length) {
                state._pbFallback = data.pullbacks;
                state._pbFallbackDate = prevDate;
                if (state.dateIndex === 0) applyDay();
            }
        }).catch(function () { state._pbFallbackFetching = false; });
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
        var _saveBtn = $('leaderSaveBtn');
        if (_saveBtn) _saveBtn.addEventListener('click', downloadLeaderCard);

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
