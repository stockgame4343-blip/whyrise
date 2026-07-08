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

async function fetchJsonRetry(url) {
    var lastErr;
    for (var i = 0; i < FETCH_RETRIES; i++) {
        try {
            var res = await fetch(url, {
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
            return await res.json();
        } catch (e) {
            lastErr = e;
            if (i < FETCH_RETRIES - 1) await sleep(RETRY_DELAY_MS);
        }
    }
    throw lastErr;
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

module.exports = {
    GLOBAL_SYMBOLS, FX_SYMBOL,
    fetchJsonRetry, fetchKrIndex, fetchUpDownCount, fetchKrMarketSummary,
    fetchGlobalQuote, fetchGlobalQuotes,
};
