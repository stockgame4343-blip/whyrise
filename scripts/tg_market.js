/**
 * 텔레그램 게시용 시장 시세 모듈 (whyorgo 채널 공용)
 *
 *   - 국내 지수(코스피/코스닥): 네이버 폴링 API — 종가·등락률·거래대금·장 상태
 *   - 상승/하락 종목수: 네이버 종목 리스트 API totalCount
 *   - 해외 지수·환율: Yahoo Finance v8 chart API (심볼별 1콜, crumb 불필요)
 *
 * 모든 외부 호출은 타임아웃 + 재시도(ai/claude.md 규칙). 실패 시 throw —
 * 호출 측이 블록 생략 등으로 우아하게 처리한다.
 */
'use strict';

const FETCH_TIMEOUT_MS = 10000;
const FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const UA = 'Mozilla/5.0 (compatible; whyrise-telegram)';

const NAVER_POLLING_INDEX = 'https://polling.finance.naver.com/api/realtime/domestic/index/';
const NAVER_STOCK_LIST = 'https://m.stock.naver.com/api/stocks/';   // {up|down}/{KOSPI|KOSDAQ}
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search?hl=ko&gl=KR&ceid=KR:ko&q=';

// 장전 브리핑에 싣는 해외 심볼(순서 = 표시 순서)
const GLOBAL_SYMBOLS = [
    { symbol: '^GSPC', label: 'S&P 500' },
    { symbol: '^IXIC', label: '나스닥' },
    { symbol: '^DJI', label: '다우' },
    { symbol: '^SOX', label: '반도체(SOX)' },
    { symbol: '^VIX', label: 'VIX' },
];
const FX_SYMBOL = { symbol: 'KRW=X', label: '원/달러' };

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function fetchRetry(url, kind) {
    var lastErr;
    for (var i = 0; i < FETCH_RETRIES; i++) {
        try {
            var res = await fetch(url, {
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
            return kind === 'text' ? await res.text() : await res.json();
        } catch (e) {
            lastErr = e;
            if (i < FETCH_RETRIES - 1) await sleep(RETRY_DELAY_MS);
        }
    }
    throw lastErr;
}
function fetchJsonRetry(url) { return fetchRetry(url, 'json'); }
function fetchTextRetry(url) { return fetchRetry(url, 'text'); }

function decodeEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
        .replace(/&amp;/g, '&');
}

// "7,246.79" / "42,465,431백만" 류 콤마·단위 문자열 → number
function parseNum(s) {
    var n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : 0;
}

/**
 * 국내 지수 스냅샷. code: 'KOSPI' | 'KOSDAQ'
 * → { code, price, changePct, tradingValueWon, marketStatus, tradedYmd }
 *   tradedYmd 는 이 시세가 어느 거래일 것인지("20260708") — 캡션 날짜와 대조용.
 */
async function fetchKrIndex(code) {
    var j = await fetchJsonRetry(NAVER_POLLING_INDEX + code);
    var d = j && j.datas && j.datas[0];
    if (!d) throw new Error('naver index empty: ' + code);
    return {
        code: code,
        price: parseNum(d.closePrice),
        changePct: parseNum(d.fluctuationsRatio),
        tradingValueWon: parseNum(d.accumulatedTradingValue) * 1e6,   // "…백만" 단위
        marketStatus: String(d.marketStatus || ''),
        tradedYmd: String(d.localTradedAt || '').slice(0, 10).replace(/-/g, ''),
    };
}

// 시장별 상승/하락 종목수 (totalCount 만 필요 — pageSize 최소)
async function fetchUpDownCount(market) {
    var up = await fetchJsonRetry(NAVER_STOCK_LIST + 'up/' + market + '?page=1&pageSize=1');
    var down = await fetchJsonRetry(NAVER_STOCK_LIST + 'down/' + market + '?page=1&pageSize=1');
    return { up: Number(up.totalCount) || 0, down: Number(down.totalCount) || 0 };
}

/**
 * 국내 시장 요약(코스피+코스닥) — 15:45 대장 캡션의 시장 블록용.
 * → { kospi, kosdaq, upCount, downCount, tradingValueWon, tradedYmd }
 */
async function fetchKrMarketSummary() {
    var r = await Promise.all([
        fetchKrIndex('KOSPI'), fetchKrIndex('KOSDAQ'),
        fetchUpDownCount('KOSPI'), fetchUpDownCount('KOSDAQ'),
    ]);
    var kospi = r[0], kosdaq = r[1], cKospi = r[2], cKosdaq = r[3];
    return {
        kospi: kospi,
        kosdaq: kosdaq,
        upCount: cKospi.up + cKosdaq.up,
        downCount: cKospi.down + cKosdaq.down,
        tradingValueWon: kospi.tradingValueWon + kosdaq.tradingValueWon,
        tradedYmd: kospi.tradedYmd,
    };
}

/**
 * 실측 거래일 가드 — 네이버 KOSPI 시세의 거래일(tradedYmd)이 오늘과 다르면 휴장일.
 * 정적 캘린더(kr_holidays.json)가 못 잡는 임시휴장(2026-07-17 사례) 방어.
 * 개장(09:00) 이후에만 유효 — 장전엔 항상 전 거래일이 나오므로 쓰지 말 것(장전 브리핑 제외).
 * 네이버 실패 시 fail-open(ok:true) — 일시 장애가 정상 거래일 게시를 막지 않게 한다.
 */
async function isKrTradedToday(todayYmd) {
    try {
        var k = await fetchKrIndex('KOSPI');
        return { ok: k.tradedYmd === String(todayYmd), tradedYmd: k.tradedYmd };
    } catch (e) {
        console.error('거래일 실측 실패(fail-open):', e.message);
        return { ok: true, tradedYmd: '' };
    }
}

/**
 * 해외 지수/환율 1종 — Yahoo v8 chart. range=1d 라 meta.chartPreviousClose 가 직전 종가.
 * → { symbol, label, price, changePct }
 */
async function fetchGlobalQuote(item) {
    var j = await fetchJsonRetry(YAHOO_CHART + encodeURIComponent(item.symbol) + '?range=1d&interval=1d');
    var meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!meta || meta.regularMarketPrice == null) throw new Error('yahoo meta empty: ' + item.symbol);
    var price = Number(meta.regularMarketPrice);
    var prev = Number(meta.chartPreviousClose || meta.previousClose) || 0;
    return {
        symbol: item.symbol,
        label: item.label,
        price: price,
        changePct: prev > 0 ? (price / prev - 1) * 100 : 0,
    };
}

// 심볼 여러 개 — 실패한 심볼은 건너뛰고 성공분만 반환(전체 실패 시 빈 배열)
async function fetchGlobalQuotes(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
        try { out.push(await fetchGlobalQuote(items[i])); }
        catch (e) { console.error('해외 시세 실패(' + items[i].symbol + '):', e.message); }
    }
    return out;
}

// 사이드카 방향 — 제목에 매수/매도 명시 우선, 없으면 급락/급등 어휘로 추정.
function sidecarDirection(title) {
    if (title.indexOf('매수') >= 0) return '매수';
    if (title.indexOf('매도') >= 0) return '매도';
    if (/급락|폭락|하락|급락장|낙폭/.test(title)) return '매도';
    if (/급등|폭등|상승|급등장/.test(title)) return '매수';
    return '';
}

/**
 * 사이드카 발동 속보 감지 — Google 뉴스 RSS(키 불필요, 최신순).
 * KRX가 사이드카를 발동하면 연합뉴스 등이 초 단위로 [속보] 송고 → 그 제목을 잡는다.
 * 선물 실시간 시세로 역산하는 대신 "실제 발동됐다"는 사실을 감지하는 방식.
 *   withinMin: 이 분(minute) 내 발행 기사만(오래된 해설·과거 발동 배제). Infinity 면 무시(데모).
 * → 시장(코스피/코스닥) 단위 이벤트 배열. 한 발동이 여러 헤드라인(코스피만/둘다/방향유무)으로
 *   흩어져도 **시장 단위 signature 로 1건**으로 합친다(같은 코스피 사이드카에 중복 알림 방지).
 *   [{ title, pubEpoch, market:'코스피'|'코스닥', direction:'매수'|'매도'|'', signature:'사이드카|<시장>' }]
 */
async function fetchSidecarEvents(withinMin) {
    var xml = await fetchTextRetry(GOOGLE_NEWS_RSS + encodeURIComponent('사이드카 발동'));
    var blocks = xml.split('<item>').slice(1);
    var now = Date.now();
    var rows = [];
    for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var title = decodeEntities((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
        var pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        if (title.indexOf('사이드카') < 0 || title.indexOf('발동') < 0) continue;
        if (title.indexOf('해제') >= 0) continue;                 // 발동만(해제 기사 제외)
        var pubEpoch = Date.parse(pub);
        if (!isFinite(pubEpoch)) continue;
        var ageMin = (now - pubEpoch) / 60000;
        if (withinMin !== Infinity && !(ageMin >= -5 && ageMin <= withinMin)) continue;   // 신선도(-5분=시계 오차 여유)
        var dir = sidecarDirection(title);
        var mkts = [];
        if (title.indexOf('코스피') >= 0) mkts.push('코스피');
        if (title.indexOf('코스닥') >= 0) mkts.push('코스닥');
        if (!mkts.length) continue;                               // 국내 지수 명시된 것만(미국장 등 배제)
        for (var m = 0; m < mkts.length; m++) {
            rows.push({ title: title, pubEpoch: pubEpoch, market: mkts[m], direction: dir, signature: '사이드카|' + mkts[m] });
        }
    }
    rows.sort(function (a, b) { return b.pubEpoch - a.pubEpoch; });   // 최신 먼저
    var seen = {}, out = [];
    for (var j = 0; j < rows.length; j++) {                          // 시장 단위 dedup — 최신 기사 것 유지
        if (seen[rows[j].signature]) continue;
        seen[rows[j].signature] = 1;
        out.push(rows[j]);
    }
    return out;
}

module.exports = {
    GLOBAL_SYMBOLS, FX_SYMBOL,
    fetchJsonRetry, fetchTextRetry, decodeEntities, fetchKrIndex, fetchUpDownCount, fetchKrMarketSummary,
    isKrTradedToday,
    fetchGlobalQuote, fetchGlobalQuotes, fetchSidecarEvents,
};
