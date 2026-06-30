/**
 * 메인 — 컷오프 토글 + 일별 종목 표시 + 위젯 + 호버 메뉴 이벤트.
 *
 * stock-rise app.js 의 핵심을 가벼운 형태로 이식:
 *  - localStorage key 'whyrise-ratings' (stock-rise 와 분리)
 *  - 컷오프 toggle [+10/+15/+20/29.9]
 *  - 위젯: 최근 30일 동안 +15% 이상 친 종목 TOP 10 (인덱스 기반)
 */
var WhyApp = (function () {

    var STORAGE_KEY = 'whyrise-ratings';
    var WATCHLIST_KEY = 'whyrise-watchlist-mode';
    var MARKET_KEY = 'whyrise-market-filter';   // 'ALL' | 'KOSPI' | 'KOSDAQ'
    var THEME_KEY = 'theme';
    var CUTOFF = 15;   // 고정
    // 모든 메뉴에서 가려야 할 종목 — 에이프로젠바이오로직스, 졸스, 에이프로젠
    var BLOCKED_TICKERS = { '003060': 1, '018700': 1, '007460': 1 };
    // 합성행(빌드 TOP_N=100 밖 급등주) 상승이유 보강
    var REASON_SS_PREFIX = 'wr:reason:';   // sessionStorage 키: wr:reason:{date}:{ticker}
    var REASON_MAX_CONCURRENT = 4;         // 동시 보강 fetch 상한 (네이버/Vercel 부하 가드)
    // 라이브 숫자 오버레이 주기 15s — /api/marketmap 에서 주가/상승률/거래대금/시총만 받아
    // 1시간 빌드(getRankings) 행 위에 ticker 단위로 덮어씀. 세부필드(섹터/테마/뉴스)는 빌드 그대로.
    // (/api/marketmap 병렬화로 ~3s 응답이라 30s→15s 단축)
    var LIVE_POLL_MS = 15 * 1000;
    var IDLE_RECHECK_MS = 5000;            // 비라이브 상태 재확인 주기
    var STATUS_RECHECK_MS = 5 * 60 * 1000; // 서버 CLOSE(공휴일/오판) 재확인 주기
    var CLOSE_SETTLE_MS = 90 * 1000;       // 마감 후 확정 종가 fetch 지연 (동시호가 체결 대기)
    var KST_OFFSET = 9 * 60;
    var OPEN_MIN = 8 * 60, CLOSE_MIN = 15 * 60 + 30; // NXT 시작 08:00부터 라이브 대기
    var RING_CIRCUM = 2 * Math.PI * 9;
    function isMarketOpenKST() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var day = k.getUTCDay();
        if (day === 0 || day === 6) return false;
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < CLOSE_MIN;
    }
    function isNxtLeadInKST() {
        var k = new Date(Date.now() + KST_OFFSET * 60000);
        var mins = k.getUTCHours() * 60 + k.getUTCMinutes();
        return mins >= OPEN_MIN && mins < 9 * 60;
    }
    // ── LIVE ring / chain pattern (버블맵·트리맵과 동일) ──
    function $ringFg() { return document.querySelector('#homeLive .tmap-live__ring-fg'); }
    function startRingFill() {
        var el = $ringFg(); if (!el) return;
        el.style.transition = 'none';
        el.style.strokeDashoffset = String(RING_CIRCUM);
        void el.getBoundingClientRect();
        el.style.transition = 'stroke-dashoffset ' + (LIVE_POLL_MS / 1000) + 's linear';
        el.style.strokeDashoffset = '0';
    }
    function stopRingFill() {
        var el = $ringFg(); if (!el) return;
        el.style.transition = 'none';
        el.style.strokeDashoffset = String(RING_CIRCUM);
    }
    function _dateStrKST() {
        var d = state.dates[state.currentDateIdx] || '';
        if (d.length !== 8) return '';
        return d.slice(0, 4) + '.' + d.slice(4, 6) + '.' + d.slice(6, 8);
    }
    function _composeLabel() {
        // 'LIVE' 글자 없이 날짜·시간만 — 회색 텍스트 + ring 만으로 라이브 표현
        var ds = _dateStrKST();
        var hhmm = (state.collectedAt || '').slice(11, 16);
        return [ds, hhmm].filter(Boolean).join(' ');
    }
    function setLiveState(open) {
        var live = document.getElementById('homeLive');
        var lab = document.getElementById('homeLiveLabel');
        if (!live || !lab) return;
        if (open) live.classList.remove('tmap-live--idle');
        else { live.classList.add('tmap-live--idle'); stopRingFill(); }
        lab.textContent = _composeLabel();
    }
    function refreshLiveLabel() {
        var lab = document.getElementById('homeLiveLabel');
        if (!lab) return;
        lab.textContent = _composeLabel();
    }
    var _lastLiveAt = '';   // 마지막 라이브 갱신 시각 (KST 'YYYY-MM-DDTHH:MM:SS') — 라벨용
    var _wasOpen = false;   // 장중→마감 전이 감지 (확정 종가 1회 재확보)

    // loadDate 가 라벨 시각을 빌드 collected_at 으로 되돌리므로, 라이브 직후엔 라이브 시각으로 교정.
    function _stampLiveLabel() {
        if (_lastLiveAt && state.currentDateIdx === 0 && !state.watchlistMode) {
            state.collectedAt = _lastLiveAt;
            refreshLiveLabel();
        }
    }

    // 라이브 거래일(/api/marketmap 의 quote 일자)이 빌드 최신일보다 새로우면 화면 날짜도 전진 —
    // 날짜 라벨·피커·하단 갱신시각이 어제(빌드)로 표시되는 문제 해소 (treemap/bubbles2 와 동일 패턴).
    // 내용은 기존 그대로(직전 빌드 + 라이브 오버레이) — 오늘 빌드가 도착하면 loadDate 폴백이 자연 교체.
    function maybeAdvanceLiveDate(liveDate) {
        if (!liveDate || liveDate.length !== 8) return;
        if (state.currentDateIdx !== 0 || state.watchlistMode) return;
        if (!state.dates.length || liveDate <= state.dates[0]) return;
        state.virtualDate = liveDate;
        state.dates.unshift(liveDate);
        updateDateUI();
    }

    function liveCycle() {
        var isLatest = state.currentDateIdx === 0;
        var clockOpen = isMarketOpenKST();
        // 08~09시 NXT 리드인은 서버가 아직 CLOSE 여도 라이브 재시도를 유지.
        // 그 이후 서버 market_status 는 휴장/공휴일 가드로 사용.
        // ''(미확인) 은 로컬 시계 신뢰 (첫 fetch 실패 시 폴링이 영구 정지하지 않도록).
        var statusClosed = clockOpen && state.marketStatus === 'CLOSE' && !isNxtLeadInKST();
        var open = clockOpen && !statusClosed;
        var fg = document.visibilityState !== 'hidden';
        // 장중부터 열어둔 탭 — 마감 직후 1회 더 받아 동시호가 확정 종가 반영
        if (_wasOpen && !clockOpen && isLatest && !state.watchlistMode && fg) {
            _wasOpen = false;
            setTimeout(function () { primeLive(); }, CLOSE_SETTLE_MS);
        }
        if (!isLatest || !open || !fg || state.watchlistMode) {
            setLiveState(false);
            // 공휴일/오판 CLOSE — 5분 간격으로만 재확인 (상태가 OPEN 으로 돌아오면 자동 복구)
            if (statusClosed && isLatest && !state.watchlistMode && fg) {
                setTimeout(function () { primeLive().then(function () { liveCycle(); }); }, STATUS_RECHECK_MS);
                return;
            }
            setTimeout(liveCycle, IDLE_RECHECK_MS);
            return;
        }
        _wasOpen = true;
        setLiveState(true);
        startRingFill();
        setTimeout(function () {
            // 라이브 숫자(주가/상승률/거래대금/시총) 먼저 받아 state.liveMap 갱신 →
            // loadDate(빌드, 5분 캐시)의 applyCutoffAndRender 가 그 위에 오버레이.
            // 라이브 실패 시 liveMap 유지(최초 실패면 null→빌드값) = 직전 정상 라이브값 표시, 깜빡임 방지.
            WhyAPI.getLiveMarketmap().then(function (res) {
                state.liveMap = res.map;
                state.marketStatus = res.market_status || state.marketStatus;
                _lastLiveAt = res.updated_at || _lastLiveAt;
                maybeAdvanceLiveDate(res.date);
            }).catch(function () {})
              .then(function () {
                  // 느린 fetch(최대 30s) 도중 사용자가 다른 날짜/관심모드로 이동했으면 최신일 강제 로드 금지
                  // (날짜 헤더와 표 데이터 불일치 방지). 다음 liveCycle 이 isLatest 가드로 알아서 처리.
                  if (state.currentDateIdx !== 0 || state.watchlistMode) return;
                  return loadDate(state.dates[0]).then(_stampLiveLabel);
              })
              .then(function () { liveCycle(); });
        }, LIVE_POLL_MS);
    }

    // 로드 시 최신일이면 장 마감·장전이라도 라이브 1회 즉시 fetch → 실제 종가/시세를 빌드값 위에 바로 반영.
    // (시각화는 로드 때 항상 1회 fetch. 이게 없으면 홈은 마감 후 빌드값에 멈춰 '여전히 빌드 기다림'으로 보임.)
    function primeLive() {
        if (state.currentDateIdx !== 0 || state.watchlistMode) return Promise.resolve();
        return WhyAPI.getLiveMarketmap().then(function (res) {
            state.liveMap = res.map;
            state.marketStatus = res.market_status || state.marketStatus;
            _lastLiveAt = res.updated_at || _lastLiveAt;
            maybeAdvanceLiveDate(res.date);
            if (state.currentDateIdx === 0 && !state.watchlistMode) {
                return loadDate(state.dates[0]).then(_stampLiveLabel);
            }
        }).catch(function () {});
    }

    var state = {
        dates: [],
        currentDateIdx: 0,
        marketFilter: 'ALL',  // 시장 필터 — 'ALL' | 'KOSPI' | 'KOSDAQ' (날짜·관심 모드 무관 공통)
        virtualDate: '',      // 라이브가 알려준 오늘 거래일 — 빌드(dates.json) 도착 전 라벨/피커용 (treemap 패턴)
        rankings: [],         // 원본 (필터 전)
        liveMap: null,        // /api/marketmap ticker→{change_rate,close_price,trading_value,market_cap(억원)} — 라이브 숫자 오버레이용
        marketStatus: '',     // ''=미확인(로컬 시계 신뢰) | 'OPEN' | 'CLOSE' (서버 판정 — 공휴일 포함)
        ratings: {},
        watchlistMode: false, // 별점 매긴 종목만 필터
        // 관심 모드 fallback: 그 날 랭킹에 없는 별표 종목을 stock-history events[0] 로 채우기 위한 캐시
        // ticker → {ticker,name,market,date,change_rate,close_price,rise_reason,theme_tag,sector,news}
        latestEvent: {},
        // history fetch 진행 중 ticker 집합 — 중복 fetch 방지
        _historyInFlight: {},
        tickerMeta: {},
        // 합성행(빌드 TOP_N=100 밖 급등주) 상승이유 보강 캐시·큐
        reasonCache: {},      // ticker → {theme_tag, news} | null(실패) | undefined(진행 중)
        _reasonQueue: [],     // 보강 대기 ticker
        _reasonActive: 0,     // 진행 중 fetch 수 (동시성 제한)
        snapshotMap: null,    // 과거일 그날 marketmap 스냅샷 ticker→숫자맵 (과거일 합성행/오버레이용)
        snapshotDate: '',     // snapshotMap 의 거래일 (YYYYMMDD) — 중복 로드 가드
    };

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

    function formatDate(yyyymmdd) {
        if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
        var y = yyyymmdd.slice(0, 4);
        var m = yyyymmdd.slice(4, 6);
        var d = yyyymmdd.slice(6, 8);
        var DAYS = ['일','월','화','수','목','금','토'];
        var dt = new Date(+y, +m - 1, +d);
        return y + '.' + m + '.' + d + ' (' + DAYS[dt.getDay()] + ')';
    }

    /**
     * stock-history fetch — 별표 종목 중 그 날 랭킹에 없고 캐시에도 없는 ticker.
     * events[0] (가장 최근 +15% 친 날) 을 state.latestEvent 에 저장.
     * 모두 끝나면 onDone(changed) 호출 — true 일 때만 재렌더 트리거.
     *
     * 중요: 실패·404·이벤트 없는 ticker 도 latestEvent[ticker]=null 로 마킹.
     * 이 sentinel 이 없으면 호출자 가드가 매번 다시 fetch 트리거 → 무한 루프.
     * 가드는 hasOwnProperty 로 — null 도 "시도했음" 으로 인정.
     */
    function prefetchLatestEvents(tickers, onDone) {
        var todo = tickers.filter(function (t) {
            return !state.latestEvent.hasOwnProperty(t) && !state._historyInFlight[t];
        });
        if (!todo.length) { if (onDone) onDone(false); return; }
        todo.forEach(function (t) { state._historyInFlight[t] = true; });
        var promises = todo.map(function (ticker) {
            return WhyAPI.getStockHistory(ticker).then(function (hist) {
                if (hist && hist.events && hist.events.length) {
                    var ev = hist.events[0];
                    var entry = {
                        ticker: ticker,
                        name: hist.name || ticker,
                        market: hist.market || '',
                        date: ev.date || '',
                        change_rate: ev.change_rate,
                        close_price: ev.close_price,
                        trading_value: ev.trading_value || null,
                        market_cap: ev.market_cap || null,
                        rise_reason: ev.rise_reason || '',
                        theme_tag: ev.theme_tag || '',
                        sector: ev.sector || '',
                        news: ev.news || [],
                    };
                    state.latestEvent[ticker] = entry;
                    if (ev.date) {
                        return WhyAPI.getRankings(ev.date).then(function (daily) {
                            var rankings = (daily && daily.rankings) || [];
                            for (var i = 0; i < rankings.length; i++) {
                                if (rankings[i].ticker === ticker) {
                                    var row = rankings[i];
                                    entry.trading_value = row.trading_value || entry.trading_value || null;
                                    entry.market_cap = row.market_cap || entry.market_cap || null;
                                    entry.market = entry.market || row.market || '';
                                    entry.sector = entry.sector || row.sector || '';
                                    break;
                                }
                            }
                        }).catch(function () {});
                    }
                } else {
                    state.latestEvent[ticker] = null;   // 시도했지만 events 없음
                }
            }).catch(function () {
                state.latestEvent[ticker] = null;        // 404 등 — 재시도 막기 위한 sentinel
            }).then(function () { delete state._historyInFlight[ticker]; });
        });
        Promise.all(promises).then(function () { if (onDone) onDone(true); });
    }

    // 라이브 숫자 오버레이 — 최신일=라이브(liveMap), 과거일=그날 스냅샷(snapshotMap), ticker 단위 4숫자만 덮어씀.
    // 세부필드(섹터/테마/상승이유/뉴스)는 절대 미변경. 맵에 없는 종목은 빌드값 유지.
    function _overlayMap() {
        return state.currentDateIdx === 0 ? state.liveMap : state.snapshotMap;
    }

    // 과거일 그날 marketmap 스냅샷 확보 — 합성행/오버레이용. 최신일은 liveCycle(실시간)이 담당.
    function _ensureSnapshot(date) {
        if (state.currentDateIdx === 0) { state.snapshotMap = null; state.snapshotDate = ''; return; }
        if (state.snapshotDate === date) return;          // 이미 로드(또는 시도)
        state.snapshotDate = date;
        state.snapshotMap = null;
        WhyAPI.getMarketmapSnapshot(date).then(function (res) {
            if (state.dates[state.currentDateIdx] !== date) return;   // 그새 날짜 이동 — 무시
            state.snapshotMap = res.map;
            applyCutoffAndRender();   // 스냅샷으로 합성행 재현
        }).catch(function () {
            if (state.dates[state.currentDateIdx] === date) state.snapshotMap = {};  // 스냅샷 없음 → 빌드만
        });
    }

    function _applyLiveOverlay() {
        if (state.watchlistMode) return;
        var map = _overlayMap();
        if (!map) return;
        // 불변 머지 — getRankings 5분 캐시 객체(참조 공유)를 변형하지 않도록 복사본에만 덮어씀.
        // (in-place 면 캐시 오염 → 다음 폴링/재방문에서 잘못된 baseline 으로 누적)
        state.rankings = (state.rankings || []).map(function (r) {
            var lv = map[r.ticker];
            if (!lv) return r;
            var o = Object.assign({}, r);
            if (lv.change_rate != null) o.change_rate = lv.change_rate;
            if (lv.close_price != null) o.close_price = lv.close_price;
            if (lv.trading_value != null) o.trading_value = lv.trading_value;
            if (lv.market_cap != null) o.market_cap = lv.market_cap * 1e8;   // 억원 → 원 (table.js formatAmount 원 기대)
            return o;
        });
        // NXT 프리마켓(08~09시)엔 NXT 시세가 있는 종목만 '오늘 상승'으로 인정 —
        // 라이브(NXT)에 없는 빌드 행(어제 급등주가 어제 등락률로 박제되는 것)은 제외해
        // 'NXT 상승분만' 표기. 09:00 정규장부터는 필터 해제(정규 상승분 전체 반영).
        // (합성 신규행은 아래에서 별도 추가 — liveMap 출처라 이 필터와 무관.)
        if (state.currentDateIdx === 0 && isNxtLeadInKST()) {
            state.rankings = state.rankings.filter(function (r) {
                return r && r.ticker && map[r.ticker];
            });
        }
        // 빌드에 아직 없는 신규 급등주 — 라이브 union 에서 +CUTOFF% 면 합성 행으로 즉시 노출.
        // 세부필드(이유/테마/뉴스)는 다음 빌드 도착 시 정식 행으로 자연 교체. (api.js:136 name 필드의 용도)
        var have = {};
        state.rankings.forEach(function (r) { if (r && r.ticker) have[r.ticker] = 1; });
        Object.keys(map).forEach(function (tk) {
            if (have[tk] || BLOCKED_TICKERS[tk]) return;
            var lv = map[tk];
            if (!lv || lv.change_rate == null || lv.change_rate < CUTOFF || !lv.name) return;
            var rc = state.reasonCache[tk];   // 보강 도착분(있으면 테마·뉴스 채움) → table.js 가 이유 가공
            state.rankings.push({
                ticker: tk,
                name: lv.name,
                market: lv.market || '',
                change_rate: lv.change_rate,
                close_price: lv.close_price,
                trading_value: lv.trading_value,
                market_cap: lv.market_cap != null ? lv.market_cap * 1e8 : null,
                sector: (rc && rc.theme_tag) || '',
                theme_tag: (rc && rc.theme_tag) || '',
                rise_reason: _liveRowReason(rc),
                news: (rc && rc.news) || [],
                _liveNew: true,
            });
        });
    }

    function applyCutoffAndRender() {
        var date = state.dates[state.currentDateIdx] || '';
        _applyLiveOverlay();   // 필터(CUTOFF)·정렬보다 먼저 — 라이브 change_rate 기준으로 컷·정렬
        var filtered;
        var emptyMsg;

        if (state.watchlistMode) {
            // 관심 모드 — 날짜 무관, 별표 단 모든 종목을 stock-history events[0]
            // (각 종목의 가장 최근 +15% 친 날) 으로 통일. 사용자: "관심은 날자랑 상관없는거야".
            var starred = [];
            for (var t in state.ratings) {
                if (state.ratings[t] && (state.ratings[t].stars || 0) > 0) starred.push(t);
            }

            // 모든 별표 종목 prefetch — 한 번도 시도 안 한 ticker 만.
            // 가드는 hasOwnProperty — null sentinel(=시도 후 history 없음) 도 재시도 안 함.
            var needPrefetch = starred.filter(function (tk) {
                return !state.latestEvent.hasOwnProperty(tk);
            });
            if (needPrefetch.length) {
                prefetchLatestEvents(needPrefetch, function (changed) {
                    if (changed && state.watchlistMode) applyCutoffAndRender();
                });
            }

            filtered = starred.map(function (ticker) {
                var ev = state.latestEvent[ticker];
                if (ev) {
                    return {
                        ticker: ticker,
                        name: ev.name || ticker,
                        market: ev.market || '',
                        change_rate: ev.change_rate,
                        trading_value: ev.trading_value || null,
                        market_cap: ev.market_cap || null,
                        sector: ev.sector || '',
                        theme_tag: ev.theme_tag || '',
                        rise_reason: ev.rise_reason || '',
                        news: ev.news || [],
                        _fromHistory: true,
                        _historyDate: ev.date || '',
                    };
                }
                // history 도 없으면 인덱스 메타로 최소 dummy
                var meta = (state.tickerMeta || {})[ticker] || {};
                return {
                    ticker: ticker,
                    name: meta.name || ticker,
                    market: meta.market || '',
                    change_rate: null,
                    trading_value: null,
                    market_cap: null,
                    sector: '',
                    theme_tag: '',
                    rise_reason: '',
                    news: [],
                };
            });
            // 정렬: 최근 등장일(_historyDate) 최신순, 없으면 뒤로
            filtered.sort(function (a, b) {
                var ad = a._historyDate || '';
                var bd = b._historyDate || '';
                if (ad !== bd) return ad < bd ? 1 : -1;
                return (b.change_rate || -Infinity) - (a.change_rate || -Infinity);
            });
            emptyMsg = '관심 종목이 없습니다.';
        } else {
            filtered = (state.rankings || []).filter(function (r) {
                return r.change_rate != null && r.change_rate >= CUTOFF;
            });
            filtered.sort(function (a, b) { return (b.change_rate || 0) - (a.change_rate || 0); });
        }
        // 시장 필터 (전체/코스피/코스닥) — 관심·일반 양쪽 모드 공통 적용
        if (state.marketFilter && state.marketFilter !== 'ALL') {
            var _mkt = state.marketFilter;
            filtered = filtered.filter(function (r) { return r.market === _mkt; });
            emptyMsg = (_mkt === 'KOSPI' ? '코스피' : '코스닥') + ' 종목이 없습니다.';
        }
        filtered.forEach(function (r, i) { r._displayRank = i + 1; });

        WhyTable.render(filtered, state.ratings, {
            date: date,
            emptyMsg: emptyMsg,
            watchlistMode: state.watchlistMode,
        });
        _enqueueReasonFetch();   // 합성행 상승이유 lazy 보강
    }

    // ── 합성행(빌드 TOP_N=100 밖 급등주) 상승이유 보강 ──────────────────────
    // 빌드에 없는 종목은 이유/테마/뉴스가 비어 '이유 분석 대기중' 으로만 뜬다. 그 종목에 한해
    // /api/stock-reason 으로 네이버 뉴스+업종을 lazy 로 받아 채운다(동시성 제한 + sessionStorage 캐시).
    // 표시 문구는 만들지 않고 news/테마만 채워 table.js cleanReasonText 가 구체 이슈를 뽑게 한다.
    function _reasonSSKey(date, tk) { return REASON_SS_PREFIX + date + ':' + tk; }
    function _reasonFromSS(date, tk) {
        try { var v = sessionStorage.getItem(_reasonSSKey(date, tk)); return v ? JSON.parse(v) : undefined; }
        catch (e) { return undefined; }
    }
    function _reasonToSS(date, tk, val) {
        try { sessionStorage.setItem(_reasonSSKey(date, tk), JSON.stringify(val)); } catch (e) {}
    }

    // 합성행 표시 이유 — 도착 전 '이유 분석 대기중', 도착 후엔 weak text 로 둬
    // table.js cleanReasonText 가 뉴스/테마에서 구체 이슈를 뽑게 한다(단정 문구 생성 안 함).
    function _liveRowReason(rc) {
        if (!rc) return '이유 분석 대기중';                     // 미도착 또는 fetch 실패
        if (rc.theme_tag) return rc.theme_tag + ' 관련 뉴스';   // → 뉴스로 구체화
        if (rc.news && rc.news.length) return '관련 뉴스';      // 테마 없음 → 종목명 매칭으로 구체화
        return '관련 뉴스 없음';                                // 시도했으나 뉴스 없음(대기중 무한표시 방지)
    }

    var _reasonRerenderTimer = null;
    function _scheduleReasonRerender() {
        if (_reasonRerenderTimer) return;        // 여러 도착을 한 번의 재렌더로 묶음
        _reasonRerenderTimer = setTimeout(function () {
            _reasonRerenderTimer = null;
            if (!state.watchlistMode) applyCutoffAndRender();
        }, 250);
    }

    // 합성행 중 이유 미보강(reasonCache 없음) ticker 를 큐에 모아 동시성 제한으로 보강한다.
    function _enqueueReasonFetch() {
        if (state.watchlistMode || !_overlayMap()) return;   // 최신일=liveMap, 과거일=snapshotMap
        var date = state.dates[state.currentDateIdx] || state.virtualDate || '';
        var added = false;
        (state.rankings || []).forEach(function (r) {
            if (!r || !r._liveNew || !r.ticker) return;
            var tk = r.ticker;
            if (state.reasonCache.hasOwnProperty(tk)) return;     // 도착/실패/진행 중
            var ss = _reasonFromSS(date, tk);                     // 새로고침 간 캐시 — 네트워크 없이
            if (ss !== undefined) { state.reasonCache[tk] = ss; added = true; return; }
            if (state._reasonQueue.indexOf(tk) < 0) state._reasonQueue.push(tk);
        });
        if (added) _scheduleReasonRerender();   // SS 히트분 즉시 반영
        _pumpReasonQueue(date);
    }

    function _pumpReasonQueue(date) {
        while (state._reasonActive < REASON_MAX_CONCURRENT && state._reasonQueue.length) {
            var tk = state._reasonQueue.shift();
            if (state.reasonCache.hasOwnProperty(tk)) continue;
            state.reasonCache[tk] = undefined;   // 진행 마킹(hasOwnProperty=true → 재큐잉 차단)
            (function (tk) {
                state._reasonActive++;
                var lv = (_overlayMap() || {})[tk] || {};
                WhyAPI.getStockReason(tk, lv.name || '', date).then(function (res) {
                    state.reasonCache[tk] = { theme_tag: (res && res.theme_tag) || '', news: (res && res.news) || [] };
                    _reasonToSS(date, tk, state.reasonCache[tk]);
                }).catch(function () {
                    state.reasonCache[tk] = null;   // 실패 — 이 세션 재시도 안 함
                }).then(function () {
                    state._reasonActive--;
                    _scheduleReasonRerender();
                    _pumpReasonQueue(date);
                });
            })(tk);
        }
    }

    function loadDate(date) {
        var $loading = document.getElementById('loading');
        var $msg = document.getElementById('message');
        if ($loading) $loading.style.display = 'block';
        if ($msg) $msg.style.display = 'none';

        return WhyAPI.getRankings(date).then(function (data) {
            // 가상 날짜의 빌드가 실제로 도착 — 이제 정식 거래일
            if (date === state.virtualDate) state.virtualDate = '';
            return data;
        }).catch(function (err) {
            // 라이브 가상 날짜(오늘 빌드 미도착) — 직전 거래일 빌드를 베이스라인으로.
            // 라이브 오버레이가 오늘 시세로 덮으므로 내용은 오늘, 세부필드는 직전 빌드.
            if (date === state.virtualDate && state.dates[1]) {
                return WhyAPI.getRankings(state.dates[1]);
            }
            throw err;
        }).then(function (data) {
            state.rankings = (data.rankings || []).filter(function (r) {
                return !BLOCKED_TICKERS[r.ticker];
            });
            state.collectedAt = data.collected_at || '';
            _ensureSnapshot(date);   // 과거일이면 그날 스냅샷 확보 → 합성행 재현
            applyCutoffAndRender();
            refreshLiveLabel();
        }).catch(function (err) {
            if ($msg) {
                $msg.textContent = '데이터 로딩 실패: ' + err.message;
                $msg.style.display = 'block';
            }
        }).finally(function () {
            if ($loading) $loading.style.display = 'none';
        });
    }

    function updateDateUI() {
        var $disp = document.getElementById('dateDisplay');
        var date = state.dates[state.currentDateIdx];
        if ($disp) $disp.textContent = formatDate(date);
        refreshLiveLabel();   // LIVE 라벨에도 같은 날짜 동기화
    }

    function bindDateNav() {
        var $prev = document.getElementById('datePrev');
        var $next = document.getElementById('dateNext');
        var $disp = document.getElementById('dateDisplay');

        function jumpTo(date) {
            var idx = state.dates.indexOf(date);
            if (idx < 0) return;
            state.currentDateIdx = idx;
            updateDateUI();
            loadDate(date);
        }

        if ($prev) $prev.addEventListener('click', function () {
            if (state.currentDateIdx < state.dates.length - 1) {
                state.currentDateIdx++;
                updateDateUI();
                loadDate(state.dates[state.currentDateIdx]);
            }
        });
        if ($next) $next.addEventListener('click', function () {
            if (state.currentDateIdx > 0) {
                state.currentDateIdx--;
                updateDateUI();
                loadDate(state.dates[state.currentDateIdx]);
            }
        });

        // dateDisplay 클릭 → 캘린더 팝오버 (date-picker.js 가 글로벌 DatePicker 제공)
        function openPicker(trigger) {
            if (typeof DatePicker === 'undefined' || !DatePicker.open) return;
            DatePicker.open({
                trigger: trigger,
                dates: state.dates,
                current: state.dates[state.currentDateIdx],
                onSelect: jumpTo,
            });
        }
        if ($disp) $disp.addEventListener('click', function () { openPicker($disp); });
    }

    function bindWatchlistToggle() {
        var $btn = document.getElementById('watchlistBtn');
        if (!$btn) return;
        // 초기 복원
        try {
            state.watchlistMode = localStorage.getItem(WATCHLIST_KEY) === '1';
        } catch (e) {}
        $btn.classList.toggle('active', state.watchlistMode);
        window.addEventListener('whyrise:auth', function () {
            if (window.WhyAuth && !window.WhyAuth.personalAllowed() && state.watchlistMode) {
                state.watchlistMode = false;
                $btn.classList.remove('active');
                try { localStorage.setItem(WATCHLIST_KEY, '0'); } catch (e) {}
                applyCutoffAndRender();
            }
        });
        $btn.addEventListener('click', function () {
            if (!requirePersonal('watchlist')) return;
            state.watchlistMode = !state.watchlistMode;
            $btn.classList.toggle('active', state.watchlistMode);
            try { localStorage.setItem(WATCHLIST_KEY, state.watchlistMode ? '1' : '0'); }
            catch (e) {}
            applyCutoffAndRender();
        });
    }

    function bindMarketFilter() {
        var $seg = document.getElementById('marketSeg');
        if (!$seg) return;
        var btns = $seg.querySelectorAll('.seg__btn');
        // 초기 복원
        try {
            var saved = localStorage.getItem(MARKET_KEY);
            if (saved === 'ALL' || saved === 'KOSPI' || saved === 'KOSDAQ') state.marketFilter = saved;
        } catch (e) {}
        function syncActive() {
            for (var i = 0; i < btns.length; i++) {
                btns[i].classList.toggle('seg__btn--active',
                    btns[i].getAttribute('data-market') === state.marketFilter);
            }
        }
        syncActive();
        $seg.addEventListener('click', function (e) {
            var btn = e.target.closest('.seg__btn');
            if (!btn) return;
            var m = btn.getAttribute('data-market') || 'ALL';
            if (m === state.marketFilter) return;
            state.marketFilter = m;
            syncActive();
            try { localStorage.setItem(MARKET_KEY, m); } catch (e2) {}
            applyCutoffAndRender();
        });
    }

    function bindThemeToggle() {
        var $btn = document.getElementById('themeToggle');
        if (!$btn) return;
        $btn.addEventListener('click', function () {
            var cur = document.documentElement.getAttribute('data-theme') || 'dark';
            var next = cur === 'light' ? 'dark' : 'light';
            if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
            else document.documentElement.removeAttribute('data-theme');
            localStorage.setItem(THEME_KEY, next);
        });
    }

    function bindRatingsEvents() {
        var $body = document.getElementById('rankingBody');
        if (!$body) return;

        $body.addEventListener('click', function (e) {
            // 별점
            var star = e.target.closest('.star');
            if (star) {
                if (!requirePersonal('interest')) return;
                var ticker = star.parentNode.getAttribute('data-ticker');
                var n = parseInt(star.getAttribute('data-star'), 10);
                if (!ticker || !n) return;
                state.ratings[ticker] = state.ratings[ticker] || {};
                if (state.ratings[ticker].stars === n) state.ratings[ticker].stars = 0;
                else state.ratings[ticker].stars = n;
                saveRatings();
                applyCutoffAndRender();
                return;
            }
            // 제외
            var ex = e.target.closest('.exclude-btn');
            if (ex) {
                if (!requirePersonal('exclude')) return;
                var ticker2 = ex.getAttribute('data-ticker');
                state.ratings[ticker2] = state.ratings[ticker2] || {};
                state.ratings[ticker2].excluded = !state.ratings[ticker2].excluded;
                saveRatings();
                applyCutoffAndRender();
                return;
            }
            // 메모
            var memo = e.target.closest('.memo-btn');
            if (memo) {
                if (!requirePersonal('memo')) return;
                var ticker3 = memo.getAttribute('data-ticker');
                openMemo(ticker3);
                return;
            }
            // 컨트롤 토글 (모바일)
            var toggle = e.target.closest('.ctrl-toggle');
            if (toggle) {
                var wrap = toggle.parentNode;
                wrap.classList.toggle('is-open');
                return;
            }
            // 관리자 편집 ✏️
            var adminBtn = e.target.closest('[data-action="admin-edit"]');
            if (adminBtn) {
                e.preventDefault();
                e.stopPropagation();
                var ticker4 = adminBtn.getAttribute('data-ticker');
                var date4 = adminBtn.getAttribute('data-date');
                openAdminEdit(ticker4, date4);
                return;
            }
        });
    }

    var _adminModal = null;
    function openAdminEdit(ticker, date) {
        if (!_adminModal) {
            _adminModal = Admin.bindEditModal(function () {
                // 저장 후 다시 fetch
                loadDate(state.dates[state.currentDateIdx]);
            });
        }
        if (!_adminModal) return;
        var stock = state.rankings.find(function (r) { return r.ticker === ticker; });
        _adminModal.open({
            date: date,
            ticker: ticker,
            name: stock ? stock.name : ticker,
            reason: stock ? stock.rise_reason : '',
            theme_tag: stock ? stock.theme_tag : '',
            note: stock ? (stock._edit_note || '') : '',
        });
    }

    function openMemo(ticker) {
        var $modal = document.getElementById('memoModal');
        var $title = document.getElementById('memoModalTitle');
        var $area = document.getElementById('memoTextarea');
        if (!$modal || !$area) return;
        var stock = state.rankings.find(function (r) { return r.ticker === ticker; });
        $title.textContent = (stock ? stock.name : ticker) + ' 메모';
        var rating = state.ratings[ticker] || {};
        $area.value = rating.memo || '';
        $area.setAttribute('data-ticker', ticker);
        $modal.style.display = 'flex';
        setTimeout(function () { $area.focus(); }, 50);
    }

    function bindMemoModal() {
        var $modal = document.getElementById('memoModal');
        var $close = document.getElementById('memoModalClose');
        var $save = document.getElementById('memoSave');
        var $del = document.getElementById('memoDelete');
        var $area = document.getElementById('memoTextarea');
        if (!$modal) return;
        if ($close) $close.addEventListener('click', function () { $modal.style.display = 'none'; });
        $modal.addEventListener('click', function (e) { if (e.target === $modal) $modal.style.display = 'none'; });
        if ($save) $save.addEventListener('click', function () {
            if (!requirePersonal('memo')) return;
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            state.ratings[ticker] = state.ratings[ticker] || {};
            state.ratings[ticker].memo = $area.value.trim();
            saveRatings();
            applyCutoffAndRender();
            $modal.style.display = 'none';
        });
        if ($del) $del.addEventListener('click', function () {
            if (!requirePersonal('memo')) return;
            var ticker = $area.getAttribute('data-ticker');
            if (!ticker) return;
            if (state.ratings[ticker]) delete state.ratings[ticker].memo;
            saveRatings();
            applyCutoffAndRender();
            $modal.style.display = 'none';
        });
    }

    function bindNewsModal() {
        var $modal = document.getElementById('newsModal');
        var $close = document.getElementById('newsModalClose');
        if ($close) $close.addEventListener('click', WhyTable.closeNews);
        if ($modal) $modal.addEventListener('click', function (e) {
            if (e.target === $modal) WhyTable.closeNews();
        });
    }

    function loadWidgetTopRecent() {
        var $list = document.getElementById('widgetTopRecentList');
        if (!$list) return;
        WhyAPI.getStockIndex().then(function (idx) {
            // index.json: { ticker: { name, count, ... } } 또는 { ticker: name } 단순형
            var rows = [];
            Object.keys(idx || {}).forEach(function (ticker) {
                var entry = idx[ticker];
                if (typeof entry === 'object' && entry.count_recent != null) {
                    rows.push({ ticker: ticker, name: entry.name, count: entry.count_recent });
                } else if (typeof entry === 'object' && entry.count != null) {
                    rows.push({ ticker: ticker, name: entry.name, count: entry.count });
                }
            });
            rows.sort(function (a, b) { return b.count - a.count; });
            rows = rows.slice(0, 10);
            if (!rows.length) {
                $list.innerHTML = '<li class="widget__empty">데이터 빌드 대기 중</li>';
                return;
            }
            var html = '';
            rows.forEach(function (r) {
                html += '<li><a href="/stock/' + r.ticker + '">' + r.name + '</a>' +
                    '<span class="count">' + r.count + '회</span></li>';
            });
            $list.innerHTML = html;
        }).catch(function () {
            $list.innerHTML = '<li class="widget__empty">인덱스 없음</li>';
        });
    }

    function loadTickerMeta() {
        // stock-history/index.json — 1177 종목의 name/count 메타.  관심 모드용.
        return fetch('/data/stock-history/index.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (m) { state.tickerMeta = m || {}; })
            .catch(function () { state.tickerMeta = {}; });
    }

    function init() {
        loadRatings();
        bindThemeToggle();
        bindDateNav();
        bindWatchlistToggle();
        bindMarketFilter();
        bindRatingsEvents();
        bindMemoModal();
        bindNewsModal();
        loadTickerMeta();

        WhyAPI.getDates().then(function (dates) {
            if (!Array.isArray(dates) || !dates.length) {
                document.getElementById('message').textContent = '거래일 데이터 없음.';
                document.getElementById('message').style.display = 'block';
                return;
            }
            state.dates = dates;
            state.currentDateIdx = 0;
            updateDateUI();
            return loadDate(dates[0]);
        }).then(function () {
            return primeLive();   // 최신일 라이브 1회 즉시 반영 — 마감 후에도 실제 종가/시세 표시
        }).then(function () {
            liveCycle();   // chain pattern (ring transition = setTimeout = fetch 정확 동기화)
            // 서버 별점 동기화 — KV pull 후 머지되면 다시 그림. 실패해도 로컬 모드로 작동.
            if (window.WhyRatingsSync) {
                window.WhyRatingsSync.pull().then(function (result) {
                    if (result && result.ratings) {
                        state.ratings = result.ratings;
                        applyCutoffAndRender();
                    }
                });
            }
        });

        // 탭 복귀 시 즉시 1회 갱신 — idle 체크 + 15초 폴링 주기를 기다리지 않음
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') primeLive();
        });
    }

    return { init: init };
})();

document.addEventListener('DOMContentLoaded', WhyApp.init);
