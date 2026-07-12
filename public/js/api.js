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

    // overrides 는 404(파일 없음)가 흔해 _cachedFetch(성공만 캐시)를 못 씀 — 404 도 '확정 빈 셋'으로
    // 5분 캐시한다. 없으면 장중 15초 폴링마다 /data/overrides/{date}.json 네트워크 요청이 반복된다.
    // 단, 404 외 HTTP 실패·네트워크 오류·JSON 파싱 실패는 reject 하고 캐시하지 않는다 —
    // 일시 장애를 '확정 빈 셋'으로 오캐시하면 실제 override 가 5분간 숨는다.
    var _ovCache = {};
    var _ovEpoch = 0;
    var _ovGeneration = {};
    var _ovLocalPatches = {};
    var OV_LOCAL_PATCH_MAX_MS = 15 * 60 * 1000;

    function _overridePatchMatches(entry, serverEntry) {
        if (!entry) return !serverEntry;
        if (!serverEntry) return false;
        return ['rise_reason', 'theme_tag', 'note'].every(function (key) {
            return (entry[key] || '') === (serverEntry[key] || '');
        });
    }

    function _applyOverridePatches(date, data, allowAck) {
        var next = Object.assign({}, data || {});
        var patches = _ovLocalPatches[date] || {};
        Object.keys(patches).forEach(function (ticker) {
            var patch = patches[ticker];
            var entry = patch.entry;
            // 정적 파일이 방금 저장값을 확인(ack)했거나 안전 상한을 넘기면 로컬 우선권 해제.
            if (Date.now() >= patch.expiresAt ||
                (allowAck && _overridePatchMatches(entry, next[ticker]))) {
                delete patches[ticker];
                return;
            }
            if (entry) next[ticker] = entry;
            else delete next[ticker];
        });
        if (!Object.keys(patches).length) delete _ovLocalPatches[date];
        return next;
    }

    function _requestOverrides(date) {
        return fetch('/data/overrides/' + date + '.json')
            .then(function (res) {
                if (res.status === 404) return {};   // 파일 없음 = override 없음 (유효한 확정 값)
                if (!res.ok) throw new Error('HTTP ' + res.status + ' for overrides/' + date);
                return res.json();
            });
    }

    function _fetchOverrides(date) {
        var now = Date.now();
        var hit = _ovCache[date];
        if (hit && (now - hit.t) < _cacheTtlMs) return Promise.resolve(hit.data);
        var epoch = _ovEpoch;
        var generation = _ovGeneration[date] || 0;
        return _requestOverrides(date)
            .then(function (data) {
                data = _applyOverridePatches(date, data, true);
                // admin 낙관 반영/무효화 뒤 늦게 끝난 과거 요청은 캐시를 덮지 못한다.
                if (epoch === _ovEpoch && generation === (_ovGeneration[date] || 0)) {
                    _ovCache[date] = { t: now, data: data, hydrated: true };
                    return data;
                }
                var latest = _ovCache[date];
                return latest ? latest.data : data;
            });
    }

    /** override 캐시 명시적 무효화 — admin 저장/삭제 직후 5분 캐시 stale 방지. date 생략 시 전체. */
    function invalidateOverrides(date) {
        if (date) {
            delete _ovCache[date];
            delete _ovLocalPatches[date];
            _ovGeneration[date] = (_ovGeneration[date] || 0) + 1;
        } else {
            _ovCache = {};
            _ovGeneration = {};
            _ovLocalPatches = {};
            _ovEpoch += 1;
        }
    }

    /**
     * admin 저장/삭제 낙관 반영 — 정적 /data/overrides 는 커밋→재배포 후에나 갱신되므로,
     * 이 클라이언트의 캐시에 확정 값을 먼저 심는다 (entry=null 이면 삭제).
     * 기존 캐시(같은 날짜 다른 종목 override)는 보존하고 해당 ticker 만 갱신.
     */
    function applyLocalOverride(date, ticker, entry) {
        var cached = _ovCache[date];
        var hit = cached && (Date.now() - cached.t) < _cacheTtlMs ? cached : null;
        var epoch = _ovEpoch;
        var generation = (_ovGeneration[date] || 0) + 1;
        _ovGeneration[date] = generation;
        var patches = _ovLocalPatches[date] || {};
        patches[ticker] = { entry: entry || null,
            expiresAt: Date.now() + OV_LOCAL_PATCH_MAX_MS };
        _ovLocalPatches[date] = patches;

        function storeIfCurrent(data) {
            if (epoch !== _ovEpoch || generation !== (_ovGeneration[date] || 0)) {
                var latest = _ovCache[date];
                return latest ? latest.data : data;
            }
            _ovCache[date] = { t: Date.now(), data: data, hydrated: true };
            return data;
        }

        // 방금 저장한 값은 네트워크를 기다리지 않고 즉시 노출한다.
        var optimistic = _applyOverridePatches(date, hit ? hit.data : {}, false);
        _ovCache[date] = { t: Date.now(), data: optimistic,
            hydrated: !!(hit && hit.hydrated) };
        if (!hit || !hit.hydrated) {
            // 다른 ticker 값은 백그라운드에서 복구하되, 대상 ticker에는 최신 낙관 값을
            // 포함한 이 날짜의 모든 로컬 패치를 다시 적용한다. 세대 가드가 이전/동시
            // 요청의 stale 덮어쓰기를 막고, 연속 편집도 다른 ticker 값을 잃지 않는다.
            _requestOverrides(date).then(function (base) {
                storeIfCurrent(_applyOverridePatches(date, base, true));
            }).catch(function () {});
        }
        return Promise.resolve(optimistic);
    }

    /**
     * 거래일 목록 — stock-rise(2026-04-13~) + 자체 백필 rise-history(2025~) 유니온.
     * 내림차순(최신 먼저) — 소비자가 dates[0]=최신 가정.
     * TTL 동적: 평일 09시 이후인데 최신일 < 오늘(장초반, 오늘 첫 집계 미도착)이면 60s 로 줄여
     * 집계 도착을 소비자(리포트 등)가 빨리 알게 한다. 그 외 5분. 공휴일도 60s 로 오탐되지만
     * dates.json 이 작아 부담 미미.
     */
    var _datesCache = { t: 0, data: null };
    var DATES_GAP_TTL_MS = 60 * 1000;

    function _datesGapNow(latest) {
        var k = new Date(Date.now() + 9 * 3600000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        if (k.getUTCHours() * 60 + k.getUTCMinutes() < 9 * 60) return false;
        var today = k.toISOString().slice(0, 10).replace(/-/g, '');
        return !!latest && latest < today;
    }

    function _rawJson(url) {
        return fetch(url).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
            return res.json();
        });
    }

    function getDates() {
        if (_datesCache.data && _datesCache.data.length) {
            var ttl = _datesGapNow(_datesCache.data[0]) ? DATES_GAP_TTL_MS : _cacheTtlMs;
            if ((Date.now() - _datesCache.t) < ttl) return Promise.resolve(_datesCache.data);
        }
        return Promise.all([
            _rawJson('/data/rise-history/dates.json').catch(function () { return []; }),
            _rawJson(STOCK_RISE_RAW + '/dates.json').catch(function () { return []; }),
        ]).then(function (res) {
            var seen = {};
            [].concat(res[0] || [], res[1] || []).forEach(function (d) { if (d) seen[d] = 1; });
            var dates = Object.keys(seen).sort().reverse();
            if (dates.length) _datesCache = { t: Date.now(), data: dates };
            return dates;
        });
    }

    function _shapeRankings(data, overrides, market, prefThemes, corrections) {
        overrides = overrides || {};
        prefThemes = prefThemes || {};
        corrections = corrections || {};
        var rankings = (data.rankings || []).map(function (r) {
            var pt = prefThemes[r.ticker];
            var cor = corrections[r.ticker];
            var ov = overrides[r.ticker];
            var pre = r.pre_override;
            // 우선주는 보통주 테마/섹터로 보정, 수동 보정맵(theme-corrections) 적용,
            // stock-rise '분야' placeholder 제거, admin override(최우선) 적용
            if (!pt && !cor && !ov && !pre && r.theme_tag !== '분야') return r;
            var merged = Object.assign({}, r);
            if (pre) {
                ['rise_reason', 'reason_confidence', 'reason_source', 'reason_status',
                    'theme_tag', 'note'].forEach(function (key) {
                    if (Object.prototype.hasOwnProperty.call(pre, key)) merged[key] = pre[key];
                    else delete merged[key];
                });
                delete merged.pre_override;
            }
            if (pt) {
                if (pt.theme_tag) merged.theme_tag = pt.theme_tag;
                if (pt.sector) merged.sector = pt.sector;
            }
            if (cor) {
                if (cor.theme_tag) merged.theme_tag = cor.theme_tag;
                if (cor.sector) merged.sector = cor.sector;
            }
            if ((merged.theme_tag || '') === '분야') merged.theme_tag = '';
            if (ov) {
                // 최신 override 의 비어있지 않은 기여만 적용 — 빈 값/키 생략(지움)은
                // 원본(빌드) 값이 그대로 노출된다 (replace 시맨틱)
                if (ov.rise_reason) merged.rise_reason = ov.rise_reason;
                if (ov.theme_tag) merged.theme_tag = ov.theme_tag;
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
    // 자체 rise-history 의 LLM 정제 사유를 상류(stock-rise raw) 랭킹에 오버레이.
    // 상세(stock-history)는 정제 사유가 반영되는데 리스트는 상류 raw 를 읽어 제네릭
    // 사유("계약 체결" 등)로 어긋나던 문제 해소 (2026-07-12 사용자 리포트).
    // 캐시 객체를 제자리 수정하지만 멱등이라 반복 적용 무해. admin override 는
    // _shapeRankings 가 이 뒤에 적용하므로 여전히 최우선.
    function _overlayRefinedReasons(data, date) {
        return _cachedFetch('/data/rise-history/' + date + '.json').then(function (own) {
            var m = {};
            ((own && own.rankings) || []).forEach(function (r) {
                if (r && r.ticker && r.reason_source === 'llm' && r.rise_reason) m[r.ticker] = r;
            });
            (data.rankings || []).forEach(function (r) {
                var o = m[r.ticker];
                if (!o) return;
                r.rise_reason = o.rise_reason;
                r.reason_source = 'llm';
                if (o.reason_confidence) r.reason_confidence = o.reason_confidence;
            });
            return data;
        }).catch(function () { return data; });
    }

    function getRankings(date, market) {
        return _cachedFetch(STOCK_RISE_RAW + '/' + date + '.json')
            .then(function (data) { return _overlayRefinedReasons(data, date); })
            .catch(function () {
                return _cachedFetch('/data/rise-history/' + date + '.json');
            })
            .then(function (data) {
                return Promise.all([
                    // override 만의 일시 실패는 base 랭킹으로 fail-open — reject 라
                    // '확정 빈 셋'과 혼동되지 않고, 캐시도 안 남아 다음 호출이 재시도한다.
                    _fetchOverrides(date).catch(function () { return {}; }),
                    _cachedFetch('/data/pref-themes.json').catch(function () { return {}; }),
                    _cachedFetch('/data/theme-corrections.json').catch(function () { return {}; }),
                ]).then(function (res) {
                    return _shapeRankings(data, res[0], market, res[1], res[2]);
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

    /**
     * 단일 종목 상승이유 보강 — 빌드(TOP_N=100) 밖 합성행용. /api/stock-reason 이
     * 네이버 종목뉴스(+업종)를 빌드와 동일한 news 구조로 반환(표시 가공은 table.js 전담).
     * 8s 타임아웃, 실패는 reject → 소비자가 '이유 분석 대기중' 유지.
     */
    function getStockReason(ticker, name, date) {
        var qs = '?ticker=' + encodeURIComponent(ticker) +
            '&name=' + encodeURIComponent(name || '') +
            '&date=' + encodeURIComponent(date || '');
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var opts = {};
        if (ctl) opts.signal = ctl.signal;
        var timer;
        var timeout = new Promise(function (_, reject) {
            timer = setTimeout(function () { if (ctl) ctl.abort(); reject(new Error('timeout')); }, 8000);
        });
        var req = fetch('/api/stock-reason' + qs, opts).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
        return Promise.race([req, timeout]).finally(function () { clearTimeout(timer); });
    }

    /**
     * 과거일 합성행/오버레이용 — 그날 marketmap 스냅샷(/data/marketmap/{date}.json).
     * 실시간 /api/marketmap 과 같은 형식이라 동일 map 으로 변환(시각화 treemap/bubbles2 와 같은 소스).
     * @returns Promise<{map:{[ticker]:{name,market,change_rate,close_price,trading_value,market_cap(억원)}}, date, count}>
     */
    function getMarketmapSnapshot(date) {
        return fetch('/data/marketmap/' + date + '.json', { cache: 'no-cache' })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!data || !Array.isArray(data.items)) throw new Error('empty');
                var map = {};
                data.items.forEach(function (it) {
                    if (!it || !it.ticker) return;
                    map[it.ticker] = {
                        name: it.name, market: it.market,
                        change_rate: it.change_rate, close_price: it.close_price,
                        trading_value: it.trading_value, market_cap: it.market_cap,
                    };
                });
                return { map: map, date: data.date || date, count: Object.keys(map).length };
            });
    }

    return {
        getDates: getDates,
        getRankings: getRankings,
        getOverrides: _fetchOverrides,
        invalidateOverrides: invalidateOverrides,
        applyLocalOverride: applyLocalOverride,
        getStockHistory: getStockHistory,
        getStockIndex: getStockIndex,
        getCurrentPrice: getCurrentPrice,
        getLiveMarketmap: getLiveMarketmap,
        getCardsIndex: getCardsIndex,
        getStockReason: getStockReason,
        getMarketmapSnapshot: getMarketmapSnapshot,
    };
})();
