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
import os
import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler


UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
STOCK_RISE_RAW = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data'
# Vercel serverless timeout (~10s) 안에 처리하려고 두 정렬 endpoint 분리:
# 1) marketValue 시총 정렬 TOP 500 — 시총·거래대금 큰 종목 대부분 커버
# 2) up 상승률 정렬 TOP 300 — 시총 작은 급등주 보장 진입 (intraday 와 정합)
URL_MCAP = 'https://m.stock.naver.com/api/stocks/marketValue/{mkt}?page={page}&pageSize=100'
URL_UP = 'https://m.stock.naver.com/api/stocks/up/{mkt}?page={page}&pageSize=100'
PAGES_MCAP = (1, 2, 3, 4, 5)
PAGES_UP = (1, 2, 3)
PAGES_RANKING_FAST = (1, 2, 3)
PAGES_RANKING_DEEP = (4, 5)
TOP_N = 100   # 정렬 기준별 TOP n 으로 union 산출
FETCH_TIMEOUT = 3.5
DEFAULT_RANKING_CUTOFF = 10.0
RANKINGS_CACHE_TTL_SECONDS = 15
RANKINGS_STALE_SECONDS = 90
MARKETMAP_CACHE_TTL_SECONDS = 10
MARKETMAP_STALE_SECONDS = 60

_RANKINGS_CACHE = {}
_MARKETMAP_CACHE = {}


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


def _fetch(url, timeout=FETCH_TIMEOUT):
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
            'market_cap_won': mc_won,
            'close_price': close,
            'change_amount': _parse_int(s.get('compareToPreviousClosePriceRaw')) or _parse_int(s.get('compareToPreviousClosePrice')) or 0,
            'change_rate': round(rate, 2),
            'trading_value': tv or 0,  # 원
            'trading_volume': tvol,
            '_traded_at': s.get('localTradedAt') or '',
            '_market_status': s.get('marketStatus') or '',
        })
    return out


def _fetch_market_pool(market_label: str):
    """시총 정렬 TOP 500 + 상승률 정렬 TOP 300 fetch → ticker 중복 제거 union.

    시총 작은 급등주는 marketValue 페이지에서는 5위 페이지 밖이지만 up 페이지의
    상위에 잡힘 → 두 정렬 합치면 시총 무관하게 +14% 이상 종목 모두 진입.
    """
    pool_by_ticker: dict[str, dict] = {}
    first_meta: dict = {}
    # 1) 시총 정렬 — 시총·거래대금 큰 종목 커버
    for p in PAGES_MCAP:
        try:
            data = _fetch(URL_MCAP.format(mkt=market_label, page=p))
        except Exception:
            break
        stocks = data.get('stocks') or []
        if p == 1 and stocks:
            first_meta = stocks[0]
        if not stocks:
            break
        for it in _normalize(stocks, market_label):
            pool_by_ticker[it['ticker']] = it
    # 2) 상승률 정렬 — 시총 작은 급등주 보장 진입
    for p in PAGES_UP:
        try:
            data = _fetch(URL_UP.format(mkt=market_label, page=p))
        except Exception:
            break
        stocks = data.get('stocks') or []
        if not stocks:
            break
        for it in _normalize(stocks, market_label):
            # 시총 page에 이미 있으면 그쪽 (동일 데이터)
            pool_by_ticker.setdefault(it['ticker'], it)
    return list(pool_by_ticker.values()), first_meta


def _fetch_market_pool_fast(market_label: str):
    pool_by_ticker: dict[str, dict] = {}
    first_meta: dict = {}
    futures = {}

    with ThreadPoolExecutor(max_workers=len(PAGES_MCAP) + len(PAGES_UP)) as executor:
        for p in PAGES_MCAP:
            url = URL_MCAP.format(mkt=market_label, page=p)
            futures[executor.submit(_fetch, url)] = ('mcap', p)
        for p in PAGES_UP:
            url = URL_UP.format(mkt=market_label, page=p)
            futures[executor.submit(_fetch, url)] = ('up', p)

        for future in as_completed(futures):
            kind, page = futures[future]
            try:
                data = future.result()
            except Exception:
                continue
            stocks = data.get('stocks') or []
            if kind == 'mcap' and page == 1 and stocks:
                first_meta = stocks[0]
            if not stocks:
                continue
            for it in _normalize(stocks, market_label):
                if kind == 'mcap':
                    pool_by_ticker[it['ticker']] = it
                else:
                    pool_by_ticker.setdefault(it['ticker'], it)

    return list(pool_by_ticker.values()), first_meta


def _fetch_ranking_market(market_label: str, cutoff: float):
    rows_by_ticker: dict[str, dict] = {}
    first_meta: dict = {}
    page_tails: dict[int, float] = {}

    def fetch_pages(pages):
        nonlocal first_meta
        futures = {}
        with ThreadPoolExecutor(max_workers=len(pages)) as executor:
            for p in pages:
                url = URL_UP.format(mkt=market_label, page=p)
                futures[executor.submit(_fetch, url)] = p

            for future in as_completed(futures):
                page = futures[future]
                try:
                    data = future.result()
                except Exception:
                    continue
                stocks = data.get('stocks') or []
                if page == 1 and stocks:
                    first_meta = stocks[0]
                normalized = _normalize(stocks, market_label)
                if normalized:
                    page_tails[page] = normalized[-1].get('change_rate') or 0
                for it in normalized:
                    if (it.get('change_rate') or 0) >= cutoff:
                        rows_by_ticker[it['ticker']] = it

    fetch_pages(PAGES_RANKING_FAST)
    available_pages = [p for p in PAGES_RANKING_FAST if p in page_tails]
    last_tail = page_tails.get(max(available_pages)) if available_pages else None
    if last_tail is not None and last_tail >= cutoff:
        fetch_pages(PAGES_RANKING_DEEP)

    return list(rows_by_ticker.values()), first_meta


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


def _date_from_traded_at(value):
    s = str(value or '')
    if len(s) >= 10:
        return s[:10].replace('-', '')
    return ''


def _latest_static_day(preferred_date=''):
    try:
        dates = _fetch(STOCK_RISE_RAW + '/dates.json')
    except Exception:
        dates = []
    if isinstance(dates, list) and preferred_date in dates:
        return preferred_date
    if isinstance(dates, list) and dates:
        return dates[0]
    return preferred_date


def _fetch_static_day(date):
    if not date:
        return {}
    try:
        return _fetch(STOCK_RISE_RAW + '/' + date + '.json')
    except Exception:
        return {}


def _read_overrides(date):
    if not date:
        return {}
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    path = os.path.join(root, 'public', 'data', 'overrides', date + '.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _merge_ranking_context(live_rows, static_day, overrides, same_day):
    static_rows = {}
    for row in (static_day.get('rankings') or []):
        ticker = row.get('ticker')
        if ticker:
            static_rows[ticker] = row

    merged = []
    for idx, live in enumerate(live_rows, 1):
        ticker = live.get('ticker')
        base = static_rows.get(ticker) or {}
        row = dict(base)
        row.update({
            'rank': idx,
            'ticker': ticker,
            'name': live.get('name') or base.get('name') or ticker,
            'market': live.get('market') or base.get('market') or '',
            'close_price': live.get('close_price') or 0,
            'change_amount': live.get('change_amount') or 0,
            'change_rate': live.get('change_rate') or 0,
            'trading_value': live.get('trading_value') or 0,
            'trading_volume': live.get('trading_volume') or 0,
            'market_cap': live.get('market_cap_won') or (live.get('market_cap') or 0) * 100_000_000,
            '_live': True,
        })
        for key in ('sector', 'industry_no', 'theme_tag', 'theme_tags', 'theme_no', 'rise_reason', 'news'):
            if row.get(key) in (None, '', []):
                value = base.get(key)
                if value is not None:
                    row[key] = value
        if same_day:
            for key in ('high_52w', 'high_52w_date', 'high_price', 'low_price'):
                if base.get(key) is not None:
                    row[key] = base.get(key)
        ov = overrides.get(ticker) or {}
        if ov.get('rise_reason') is not None:
            row['rise_reason'] = ov.get('rise_reason')
        if ov.get('theme_tag') is not None:
            row['theme_tag'] = ov.get('theme_tag')
        if row.get('theme_tag') and not row.get('theme_tags'):
            row['theme_tags'] = [row['theme_tag']]
        merged.append(row)
    return merged


def _static_rankings_fallback(static_day, overrides, cutoff, market_filter):
    rows = []
    for row in (static_day.get('rankings') or []):
        if market_filter in ('KOSPI', 'KOSDAQ') and row.get('market') != market_filter:
            continue
        if _parse_float(row.get('change_rate')) < cutoff:
            continue
        merged = dict(row)
        ov = overrides.get(row.get('ticker')) or {}
        if ov.get('rise_reason') is not None:
            merged['rise_reason'] = ov.get('rise_reason')
        if ov.get('theme_tag') is not None:
            merged['theme_tag'] = ov.get('theme_tag')
        if merged.get('theme_tag') and not merged.get('theme_tags'):
            merged['theme_tags'] = [merged['theme_tag']]
        rows.append(merged)
    return rows


def _build_live_rankings_uncached(params):
    try:
        cutoff = float((params.get('cutoff') or [DEFAULT_RANKING_CUTOFF])[0])
    except (ValueError, TypeError):
        cutoff = DEFAULT_RANKING_CUTOFF
    market_filter = (params.get('market') or ['ALL'])[0].upper()

    with ThreadPoolExecutor(max_workers=2) as executor:
        kospi_future = executor.submit(_fetch_ranking_market, 'KOSPI', cutoff)
        kosdaq_future = executor.submit(_fetch_ranking_market, 'KOSDAQ', cutoff)
        kospi_pool, k_first = kospi_future.result()
        kosdaq_pool, q_first = kosdaq_future.result()

    live_rows = kospi_pool + kosdaq_pool
    if market_filter in ('KOSPI', 'KOSDAQ'):
        live_rows = [row for row in live_rows if row.get('market') == market_filter]
    live_rows.sort(key=lambda r: ((r.get('change_rate') or 0), (r.get('trading_value') or 0)), reverse=True)

    first_meta = k_first or q_first or {}
    live_date = _date_from_traded_at(first_meta.get('localTradedAt'))
    if not live_date and live_rows:
        live_date = _date_from_traded_at(live_rows[0].get('_traded_at'))
    static_date = _latest_static_day(live_date)
    static_day = _fetch_static_day(static_date)
    overrides = _read_overrides(live_date) or _read_overrides(static_date)
    rankings = _merge_ranking_context(live_rows, static_day, overrides, static_date == live_date)
    mode = 'live'
    if not rankings:
        rankings = _static_rankings_fallback(static_day, overrides, cutoff, market_filter)
        mode = 'static-fallback'
    quote_at = (first_meta.get('localTradedAt') or '')
    if mode == 'static-fallback':
        quote_at = static_day.get('collected_at') or quote_at
    if not quote_at and live_rows:
        quote_at = live_rows[0].get('_traded_at') or ''
    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

    return {
        'date': live_date or static_date,
        'source_date': static_date,
        'collected_at': quote_at or now,
        'updated_at': quote_at or now,
        'server_updated_at': now,
        'is_final': (first_meta.get('marketStatus') or 'CLOSE') != 'OPEN',
        'mode': mode,
        'market_status': first_meta.get('marketStatus') or 'CLOSE',
        'cutoff': cutoff,
        'rankings': rankings,
        'pullbacks': static_day.get('pullbacks') or [],
    }


def _ranking_cache_key(params):
    try:
        cutoff = float((params.get('cutoff') or [DEFAULT_RANKING_CUTOFF])[0])
    except (ValueError, TypeError):
        cutoff = DEFAULT_RANKING_CUTOFF
    market_filter = (params.get('market') or ['ALL'])[0].upper()
    if market_filter not in ('ALL', 'KOSPI', 'KOSDAQ'):
        market_filter = 'ALL'
    return (market_filter, round(cutoff, 2))


def _with_cache_meta(body, status, age):
    out = dict(body)
    out['cache_status'] = status
    out['cache_age_seconds'] = round(max(age, 0), 1)
    return out


def _build_live_rankings(params):
    key = _ranking_cache_key(params)
    now_ts = time.time()
    hit = _RANKINGS_CACHE.get(key)
    if hit:
        age = now_ts - hit['t']
        if age <= RANKINGS_CACHE_TTL_SECONDS:
            return _with_cache_meta(hit['body'], 'fresh', age)

    try:
        body = _build_live_rankings_uncached(params)
        _RANKINGS_CACHE[key] = {'t': now_ts, 'body': body}
        return _with_cache_meta(body, 'miss', 0)
    except Exception as e:
        if hit:
            age = now_ts - hit['t']
            if age <= RANKINGS_STALE_SECONDS:
                stale = _with_cache_meta(hit['body'], 'stale', age)
                stale['cache_error'] = str(e)[:120]
                return stale
        raise


def _build_marketmap_uncached():
    with ThreadPoolExecutor(max_workers=2) as executor:
        kospi_future = executor.submit(_fetch_market_pool_fast, 'KOSPI')
        kosdaq_future = executor.submit(_fetch_market_pool_fast, 'KOSDAQ')
        kospi_pool, k_first = kospi_future.result()
        kosdaq_pool, q_first = kosdaq_future.result()

    items = _union_top(kospi_pool, TOP_N) + _union_top(kosdaq_pool, TOP_N)
    items.sort(key=lambda x: x['market_cap'], reverse=True)

    first_meta = k_first or q_first or {}
    market_status = first_meta.get('marketStatus') or 'CLOSE'
    quote_at = first_meta.get('localTradedAt') or ''
    traded = _date_from_traded_at(quote_at)
    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

    return {
        'date': traded,
        'collected_at': quote_at,
        'updated_at': quote_at or now,
        'server_updated_at': now,
        'market_status': market_status,
        'universe': 'union',
        'items': items,
    }


def _build_marketmap():
    now_ts = time.time()
    hit = _MARKETMAP_CACHE.get('ALL')
    if hit:
        age = now_ts - hit['t']
        if age <= MARKETMAP_CACHE_TTL_SECONDS:
            return _with_cache_meta(hit['body'], 'fresh', age)

    try:
        body = _build_marketmap_uncached()
        _MARKETMAP_CACHE['ALL'] = {'t': now_ts, 'body': body}
        return _with_cache_meta(body, 'miss', 0)
    except Exception as e:
        if hit:
            age = now_ts - hit['t']
            if age <= MARKETMAP_STALE_SECONDS:
                stale = _with_cache_meta(hit['body'], 'stale', age)
                stale['cache_error'] = str(e)[:120]
                return stale
        raise


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            if (params.get('rankings') or [''])[0] == '1':
                self._respond(200, _build_live_rankings(params), 'public, s-maxage=15, stale-while-revalidate=60')
                return

            self._respond(200, _build_marketmap(), 'public, s-maxage=10, stale-while-revalidate=30')
            return
        except urllib.error.HTTPError as e:
            self._respond(502, {'error': f'네이버 API 오류: {e.code}'})
        except Exception as e:
            self._respond(502, {'error': str(e)[:200]})

    def _respond(self, status, body, cache_control='public, s-maxage=5, stale-while-revalidate=10'):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        # 5초 캐시 — 같은 5초 윈도우 내 다른 사용자 요청은 edge cache 히트
        self.send_header('Cache-Control', cache_control)
        if cache_control != 'no-store':
            self.send_header('CDN-Cache-Control', cache_control)
            self.send_header('Vercel-CDN-Cache-Control', cache_control)
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
