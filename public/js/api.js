/**
 * API 통신 — stock-rise raw GitHub URL 데이터 fetch + whyrise overrides 머지
 *
 * stock-rise 본진 데이터는 raw URL 로 가져오고, 관리자 편집 결과(whyrise overrides)는
 * 같은 도메인 정적 JSON 으로 가져와 ticker 단위 머지.
 */
var WhyAPI = (function () {

    // stock-rise repo (데이터 원본)
    var STOCK_RISE_RAW = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data';

    // 클라이언트 캐시 — 5분
    var _cache = {};
    var _cacheTtlMs = 5 * 60 * 1000;

    function _cachedFetch(url) {
        var now = Date.now();
        var hit = _cache[url];
        if (hit && (now - hit.t) < _cacheTtlMs) return Promise.resolve(hit.data);
        return fetch(url).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
            return res.json();
        }).then(function (data) {
            _cache[url] = { t: now, data: data };
            return data;
        });
    }

    function _fetchOverrides(date) {
        // 같은 도메인 정적 JSON. 404 면 빈 객체.
        return fetch('/data/overrides/' + date + '.json')
            .then(function (res) {
                if (!res.ok) return {};
                return res.json();
            })
            .catch(function () { return {}; });
    }

    /** 거래일 목록 (stock-rise 의 dates.json 재사용) */
    function getDates() {
        return _cachedFetch(STOCK_RISE_RAW + '/dates.json');
    }

    /**
     * 일자별 종목 + overrides 머지.
     * @returns { rankings, collected_at, is_final, mode }
     */
    function getRankings(date, market) {
        return Promise.all([
            _cachedFetch(STOCK_RISE_RAW + '/' + date + '.json'),
            _fetchOverrides(date),
        ]).then(function (results) {
            var data = results[0];
            var overrides = results[1] || {};
            var rankings = (data.rankings || []).map(function (r) {
                var ov = overrides[r.ticker];
                if (!ov) return r;
                var merged = Object.assign({}, r);
                if (ov.rise_reason != null) merged.rise_reason = ov.rise_reason;
                if (ov.theme_tag != null) merged.theme_tag = ov.theme_tag;
                merged._edited = true;
                merged._edit_note = ov.note || '';
                return merged;
            });
            if (market && market !== 'ALL') {
                rankings = rankings.filter(function (r) { return r.market === market; });
            }
            return {
                rankings: rankings,
                pullbacks: data.pullbacks || [],   // 풀백 분석 — 리포트 페이지가 사용
                collected_at: data.collected_at || '',
                is_final: data.is_final || false,
                mode: data.mode || 'closing',
            };
        });
    }

    /** 종목별 인덱스 (이 사이트 자체 빌드본) */
    function getStockHistory(ticker) {
        return fetch('/data/stock-history/' + ticker + '.json')
            .then(function (res) {
                if (res.status === 404) return null;
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            });
    }

    /** 검색 자동완성용 인덱스 (ticker → name) */
    function getStockIndex() {
        return _cachedFetch('/data/stock-history/index.json').catch(function () { return {}; });
    }

    /** 현재가 조회 (자체 serverless) */
    function getCurrentPrice(ticker) {
        return fetch('/api/current-price?ticker=' + ticker).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
    }

    /** 카드뉴스 인덱스 — Phase 2 에서 whyrise 자체 생성. 그 전까지 404 fallback. */
    function getCardsIndex() {
        return fetch('/data/cards/index.json', { cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) return null;
                return res.json();
            })
            .catch(function () { return null; });
    }

    return {
        getDates: getDates,
        getRankings: getRankings,
        getStockHistory: getStockHistory,
        getStockIndex: getStockIndex,
        getCurrentPrice: getCurrentPrice,
        getCardsIndex: getCardsIndex,
    };
})();
