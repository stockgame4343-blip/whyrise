"""Vercel serverless — 시총 TOP 100 KOSPI + 100 KOSDAQ 실시간 시세 (5초 단위 polling 대상).

네이버 m.stock.naver.com 의 marketValue API 두 번 호출 → 정규화 → JSON.
응답에 marketValueRaw / closePriceRaw / fluctuationsRatio / marketStatus 가 포함돼
별도 OHLC 페치 없이 한 번에 시총·등락률 확보.

응답 형식:
{
  "date": "20260512",
  "updated_at": "2026-05-12T06:42:11Z",
  "market_status": "OPEN" | "CLOSE",
  "items": [
    { ticker, name, market: 'KOSPI'|'KOSDAQ',
      market_cap, close_price, change_rate, status }
  ]
}
"""
import json
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler


UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
# Vercel serverless timeout (~10s) 안에 처리하려고 두 정렬 endpoint 분리:
# 1) marketValue 시총 정렬 TOP 500 — 시총·거래대금 큰 종목 대부분 커버
# 2) up 상승률 정렬 TOP 300 — 시총 작은 급등주 보장 진입 (intraday 와 정합)
URL_MCAP = 'https://m.stock.naver.com/api/stocks/marketValue/{mkt}?page={page}&pageSize=100'
URL_UP = 'https://m.stock.naver.com/api/stocks/up/{mkt}?page={page}&pageSize=100'
PAGES_MCAP = (1, 2, 3, 4, 5)
PAGES_UP = (1, 2, 3)
TOP_N = 100   # 정렬 기준별 TOP n 으로 union 산출
MARKETS = ('KOSPI', 'KOSDAQ')
# 16개 네이버 요청을 순차로 돌면 Vercel 해외 리전에서 ~21s → 병렬로 ~3s.
# 동시성은 네이버 차단 회피 위해 8 로 상한 (16요청 ÷ 8 ≈ 2 wave).
FETCH_WORKERS = 8
# edge 캐시 — 장중엔 5초, 마감/휴장엔 시세가 멈춰 있으므로 60초로 늘려 네이버 호출 절감
CACHE_OPEN = 's-maxage=5, stale-while-revalidate=10'
CACHE_CLOSED = 's-maxage=60, stale-while-revalidate=120'
_ALL_URLS = (
    [URL_MCAP.format(mkt=m, page=p) for m in MARKETS for p in PAGES_MCAP]
    + [URL_UP.format(mkt=m, page=p) for m in MARKETS for p in PAGES_UP]
)


def _parse_int(v):
    if v is None:
        return None
    try:
        if isinstance(v, str):
            return int(v.replace(',', '').strip())
        return int(v)
    except (ValueError, TypeError):
        return None


def _parse_float(v):
    if v is None:
        return 0.0
    try:
        if isinstance(v, str):
            return float(v.replace(',', '').strip())
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def _fetch(url, timeout=8):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _normalize(stocks, market_label):
    out = []
    for s in stocks or []:
        # ETF/ETN/리츠 제외 — build_marketmap (full) 의 stock_only=True 와 정합
        if s.get('stockEndType') != 'stock':
            continue
        ticker = s.get('itemCode') or ''
        if not ticker or len(ticker) != 6:
            continue
        # marketValueRaw 가 원 단위 정확값. marketValue 는 백만원 단위 콤마 문자열.
        mc_won = _parse_int(s.get('marketValueRaw')) or (
            (_parse_int(s.get('marketValue')) or 0) * 1_000_000
        )
        if mc_won <= 0:
            continue
        # 정적 marketmap.json 과 단위 통일 → 억원
        mc = mc_won // 100_000_000
        if mc <= 0:
            mc = 1   # 1억 미만은 1억으로 표시
        rate = _parse_float(s.get('fluctuationsRatio'))
        close = _parse_int(s.get('closePriceRaw')) or _parse_int(s.get('closePrice')) or 0
        # 거래대금 (원). raw 가 우선, 없으면 콤마 문자열(천 단위) × 1000
        tv = _parse_int(s.get('accumulatedTradingValueRaw'))
        if not tv:
            tv = (_parse_int(s.get('accumulatedTradingValue')) or 0) * 1000
        tvol = _parse_int(s.get('accumulatedTradingVolumeRaw')) or _parse_int(s.get('accumulatedTradingVolume')) or 0
        out.append({
            'ticker': ticker,
            'name': s.get('stockName') or ticker,
            'market': market_label,
            'market_cap': mc,        # 억원 (정적 marketmap.json 과 동일)
            'close_price': close,
            'change_rate': round(rate, 2),
            'trading_value': tv or 0,  # 원
            'trading_volume': tvol,
        })
    return out


def _fetch_all(urls, workers=FETCH_WORKERS):
    """URL 목록 병렬 fetch → {url: data|None}. 개별 실패는 None (호출부에서 빈 stocks 처리)."""
    def _safe(u):
        try:
            return _fetch(u)
        except Exception:
            return None
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(_safe, urls))
    return dict(zip(urls, results))


def _pool_for(market_label: str, fetched: dict):
    """병렬 fetch 결과에서 한 시장의 union pool 재구성.

    시총 정렬(MCAP) + 상승률 정렬(UP) 합쳐 시총 무관하게 급등주까지 진입.
    시총 작은 급등주는 marketValue 5위 페이지 밖이라도 up 페이지 상위에 잡힘.
    """
    pool_by_ticker: dict[str, dict] = {}
    first_meta: dict = {}
    # 1) 시총 정렬 — 시총·거래대금 큰 종목 커버
    for p in PAGES_MCAP:
        data = fetched.get(URL_MCAP.format(mkt=market_label, page=p))
        stocks = (data or {}).get('stocks') or []
        if p == 1 and stocks:
            first_meta = stocks[0]
        for it in _normalize(stocks, market_label):
            pool_by_ticker[it['ticker']] = it
    # 2) 상승률 정렬 — 시총 작은 급등주 보장 진입
    for p in PAGES_UP:
        data = fetched.get(URL_UP.format(mkt=market_label, page=p))
        stocks = (data or {}).get('stocks') or []
        for it in _normalize(stocks, market_label):
            # 시총 page에 이미 있으면 그쪽 (동일 데이터)
            pool_by_ticker.setdefault(it['ticker'], it)
    return list(pool_by_ticker.values()), first_meta


def _union_top(pool, n=TOP_N):
    """모집단에서 (시총·거래량·양수 상승률) TOP n union 추출 — ticker 기준 중복 제거."""
    selected = {}
    for it in sorted(pool, key=lambda x: x.get('market_cap') or 0, reverse=True)[:n]:
        selected[it['ticker']] = it
    for it in sorted(pool, key=lambda x: x.get('trading_value') or 0, reverse=True)[:n]:
        selected[it['ticker']] = it
    rise = [x for x in pool if (x.get('change_rate') or 0) > 0]
    for it in sorted(rise, key=lambda x: x['change_rate'], reverse=True)[:n]:
        selected[it['ticker']] = it
    return list(selected.values())


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            fetched = _fetch_all(_ALL_URLS)
            kospi_pool, k_first = _pool_for('KOSPI', fetched)
            kosdaq_pool, _ = _pool_for('KOSDAQ', fetched)

            # 시장별로 union TOP n — 어떤 정렬에서도 진짜 TOP 100 보임
            items = _union_top(kospi_pool, TOP_N) + _union_top(kosdaq_pool, TOP_N)
            items.sort(key=lambda x: x['market_cap'], reverse=True)

            market_status = (k_first or {}).get('marketStatus') or 'CLOSE'
            traded = ((k_first or {}).get('localTradedAt') or '')[:10].replace('-', '')

            self._respond(200, {
                'date': traded,
                'updated_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
                'market_status': market_status,
                'universe': 'union',
                'items': items,
            }, cache=(CACHE_OPEN if market_status == 'OPEN' else CACHE_CLOSED))
        except urllib.error.HTTPError as e:
            self._respond(502, {'error': f'네이버 API 오류: {e.code}'})
        except Exception as e:
            self._respond(502, {'error': str(e)[:200]})

    def _respond(self, status, body, cache=None):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        # 같은 캐시 윈도우 내 다른 사용자 요청은 edge cache 히트. 오류 응답은 캐시 안 함.
        if cache:
            self.send_header('Cache-Control', cache)
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
