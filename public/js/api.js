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

    // overrides 는 404(파일 없음)가 흔해 _cachedFetch(성공만 캐시)를 못 씀 — 결과(빈 객체 포함)를 5분 캐시.
    // 없으면 장중 15초 폴링마다 /data/overrides/{date}.json 네트워크 요청이 반복된다.
    var _ovCache = {};

    function _fetchOverrides(date) {
        var now = Date.now();
        var hit = _ovCache[date];
        if (hit && (now - hit.t) < _cacheTtlMs) return Promise.resolve(hit.data);
        return fetch('/data/overrides/' + date + '.json')
            .then(function (res) {
                if (!res.ok) return {};
                return res.json();
            })
            .catch(function () { return {}; })
            .then(function (data) {
                _ovCache[date] = { t: now, data: data };
                return data;
            });
    }

    /**
     * 거래일 목록 — stock-rise(2026-04-13~) + 자체 백필 rise-history(2025~) 유니온.
     * 내림차순(최신 먼저) — 소비자가 dates[0]=최신 가정.
     */
    function getDates() {
        return Promise.all([
            _cachedFetch('/data/rise-history/dates.json').catch(function () { return []; }),
            _cachedFetch(STOCK_RISE_RAW + '/dates.json').catch(function () { return []; }),
        ]).then(function (res) {
            var seen = {};
            [].concat(res[0] || [], res[1] || []).forEach(function (d) { if (d) seen[d] = 1; });
            return Object.keys(seen).sort().reverse();
        });
    }

    function _shapeRankings(data, overrides, market, prefThemes) {
        overrides = overrides || {};
        prefThemes = prefThemes || {};
        var rankings = (data.rankings || []).map(function (r) {
            var pt = prefThemes[r.ticker];
            var ov = overrides[r.ticker];
            // 우선주는 보통주 테마/섹터로 보정, stock-rise '분야' placeholder 제거, admin override 적용
            if (!pt && !ov && r.theme_tag !== '분야') return r;
            var merged = Object.assign({}, r);
            if (pt) {
                if (pt.theme_tag) merged.theme_tag = pt.theme_tag;
                if (pt.sector) merged.sector = pt.sector;
            }
            if ((merged.theme_tag || '') === '분야') merged.theme_tag = '';
            if (ov) {
                if (ov.rise_reason != null) merged.rise_reason = ov.rise_reason;
                if (ov.theme_tag != null) merged.theme_tag = ov.theme_tag;
                merged._edited = true;
                merged._edit_note = ov.note || '';
            }
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
    }

    /**
     * 일자별 종목 + overrides 머지.
     * stock-rise 에 없는 과거 백필 일자(4/13 이전)는 자체 /data/rise-history/{date}.json 폴백.
     * @returns { rankings, collected_at, is_final, mode }
     */
    function getRankings(date, market) {
        return _cachedFetch(STOCK_RISE_RAW + '/' + date + '.json')
            .catch(function () {
                return _cachedFetch('/data/rise-history/' + date + '.json');
            })
            .then(function (data) {
                return Promise.all([
                    _fetchOverrides(date),
                    _cachedFetch('/data/pref-themes.json').catch(function () { return {}; }),
                ]).then(function (res) {
                    return _shapeRankings(data, res[0], market, res[1]);
                });
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

    /**
     * 라이브 시세 — treemap/bubbles2 와 동일 /api/marketmap. 빠른 숫자만(주가·상승률·거래대금·시총).
     * 세부필드(섹터·테마·상승이유·뉴스)는 이 헬퍼가 다루지 않는다 — 1시간 빌드(getRankings) 전담.
     * no-cache(라이브 무효화 방지) + 30s 타임아웃(AbortController, 느린 서버 견딤) + 콜드스타트 1회 재시도.
     * 어떤 실패(타임아웃/빈응답/네트워크)도 reject 로 통일 → 소비자가 catch 해 빌드값 유지(화면 안 비움).
     * @returns Promise<{ map: { [ticker]: {name, market, change_rate, close_price, trading_value, market_cap(억원)} },
     *                    date, updated_at(KST 'YYYY-MM-DDTHH:MM:SS'), market_status, count }>
     */
    function getLiveMarketmap() {
        function attempt() {
            var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var opts = { cache: 'no-cache' };
            if (ctl) opts.signal = ctl.signal;
            var timer;
            // 30s 타임아웃 — 서버 콜드 시 ~22s 순차 호출 견딤(속도보다 갱신 성공 우선). AbortController 가
            // 없거나 서버가 행이어도 Promise.race 의 timeout 이 반드시 reject 시켜, 프라미스가 영영 미정착되어
            // 폴링이 멈추는 일이 없게 함(소비자 catch→재시도/빌드값 유지).
            var timeout = new Promise(function (_, reject) {
                timer = setTimeout(function () { if (ctl) ctl.abort(); reject(new Error('timeout')); }, 30000);
            });
            var req = fetch('/api/marketmap', opts).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            }).then(function (data) {
                if (!data || !Array.isArray(data.items) || !data.items.length) throw new Error('empty');
                return data;
            });
            return Promise.race([req, timeout]).finally(function () { clearTimeout(timer); });
        }
        // 1차 실패(콜드스타트 빈 응답/타임아웃/네트워크) 시 정확히 1회만 재시도. 2차 실패는 reject 전파.
        return attempt().catch(function () { return attempt(); }).then(function (data) {
            var map = {};
            data.items.forEach(function (it) {
                if (!it || !it.ticker) return;
                map[it.ticker] = {
                    name: it.name,               // 빌드에 없는 신규 급등주 표시용
                    market: it.market,
                    change_rate: it.change_rate,
                    close_price: it.close_price,
                    trading_value: it.trading_value,
                    market_cap: it.market_cap,   // 억원 (api/marketmap.py 에서 이미 억원)
                };
            });
            // updated_at 은 서버에서 UTC ISO('...Z'). KST(+9h) 벽시계 문자열로 변환(소비자 slice(11,16)=KST HH:MM).
            var kst = '';
            if (data.updated_at) {
                var d = new Date(data.updated_at);
                if (!isNaN(d.getTime())) kst = new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 19);
            }
            return {
                map: map,
                date: data.date || '',
                updated_at: kst,
                market_status: data.market_status || 'CLOSE',
                count: Object.keys(map).length,
            };
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
        getLiveMarketmap: getLiveMarketmap,
        getCardsIndex: getCardsIndex,
    };
})();
