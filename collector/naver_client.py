"""네이버 금융 API 클라이언트 (urllib 만 사용, 의존성 0).

stock-rise 의 패턴을 차용한 단순 핸드롤 클라이언트.

엔드포인트:
  - GET /api/stocks/marketValue/{market}?page=&pageSize= — 시총순 전 종목 리스트
  - GET https://api.stock.naver.com/chart/domestic/item/{ticker}/day — 일봉 OHLC (1년치 한 번에)
  - GET https://api.stock.naver.com/news/{ticker}?pageSize=N&page=1 — 종목 뉴스
  - GET /item/main.naver?code={ticker} — 종목 메타(섹터·테마) HTML 파싱

throttle / retry 일관 처리.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
]

DEFAULT_TIMEOUT = 10
THROTTLE_SECONDS = 0.4   # 차단 방지용 sleep
RETRY_COUNT = 3


def _ua(idx: int = 0) -> str:
    return USER_AGENTS[idx % len(USER_AGENTS)]


def fetch_json(url: str, timeout: int = DEFAULT_TIMEOUT, retries: int = RETRY_COUNT) -> Any:
    """JSON GET — UA rotation + throttle + retry."""
    last_exc: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': _ua(i),
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://m.stock.naver.com/',
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            time.sleep(THROTTLE_SECONDS)
            return data
        except urllib.error.HTTPError as e:
            last_exc = e
            if e.code == 404:
                return None
            time.sleep((i + 1) * 2)
        except Exception as e:
            last_exc = e
            time.sleep((i + 1) * 2)
    if last_exc:
        raise last_exc
    return None


def fetch_text(url: str, timeout: int = DEFAULT_TIMEOUT, retries: int = RETRY_COUNT) -> str | None:
    """HTML GET (메타/뉴스 본문 등)."""
    last_exc: Exception | None = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': _ua(i),
                'Accept': 'text/html,application/xhtml+xml',
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                # 네이버 HTML 은 EUC-KR 인 경우 있음
                for enc in ('utf-8', 'euc-kr', 'cp949'):
                    try:
                        return raw.decode(enc)
                    except UnicodeDecodeError:
                        continue
                return raw.decode('utf-8', errors='replace')
        except urllib.error.HTTPError as e:
            last_exc = e
            if e.code == 404:
                return None
            time.sleep((i + 1) * 2)
        except Exception as e:
            last_exc = e
            time.sleep((i + 1) * 2)
    if last_exc:
        raise last_exc
    return None


# ── 종목 리스트 ─────────────────────────────────────────

def list_market_tickers(market: str = 'KOSPI', page_size: int = 100) -> list[dict]:
    """시총 순 전 종목 리스트 (KOSPI 또는 KOSDAQ).

    Returns:
        [{itemCode, stockName, sosok, stockType, stockEndType, ...}, ...]
        ETF/ETN 등 제외 위해 stockEndType == 'stock' 필터링은 호출자 책임.
    """
    out: list[dict] = []
    page = 1
    while True:
        url = (
            f'https://m.stock.naver.com/api/stocks/marketValue/{market}'
            f'?page={page}&pageSize={page_size}'
        )
        data = fetch_json(url)
        if not data or not isinstance(data, dict):
            break
        stocks = data.get('stocks') or []
        if not stocks:
            break
        out.extend(stocks)
        total = data.get('totalCount', len(out))
        if len(out) >= total:
            break
        page += 1
        if page > 30:  # safety
            break
    return out


def list_all_tickers(stock_only: bool = True) -> list[dict]:
    """KOSPI + KOSDAQ 합본. stock_only=True 면 일반 주식만."""
    items = list_market_tickers('KOSPI') + list_market_tickers('KOSDAQ')
    if stock_only:
        items = [s for s in items if s.get('stockEndType') == 'stock']
    return items


# ── 일봉 OHLC ───────────────────────────────────────────

def fetch_ohlc_daily(ticker: str, start: str, end: str) -> list[dict]:
    """일봉 OHLC (1년치 한 번에). YYYYMMDD 문자열.

    Returns:
        [{localDate, openPrice, highPrice, lowPrice, closePrice,
          accumulatedTradingVolume, foreignRetentionRate}, ...]
        (날짜 오름차순 정렬)
    """
    url = (
        f'https://api.stock.naver.com/chart/domestic/item/{ticker}/day'
        f'?startDateTime={start}&endDateTime={end}'
    )
    data = fetch_json(url)
    if isinstance(data, list):
        return data
    return []


# ── 종목 뉴스 ───────────────────────────────────────────

def fetch_stock_news(ticker: str, page_size: int = 20) -> list[dict]:
    """종목별 네이버 뉴스 (최신순).

    응답 구조: top-level list, 각 그룹 {total, items[]} — 모든 그룹의 items 합침.
    각 뉴스 item: {id, officeId, articleId, officeName, datetime('YYYYMMDDHHMM'), title, body}
    """
    url = (
        f'https://api.stock.naver.com/news/stock/{ticker}'
        f'?pageSize={page_size}'
    )
    data = fetch_json(url)
    out: list[dict] = []
    if isinstance(data, list):
        for grp in data:
            if isinstance(grp, dict) and isinstance(grp.get('items'), list):
                out.extend(grp['items'])
            elif isinstance(grp, dict) and ('title' in grp):
                out.append(grp)
    elif isinstance(data, dict):
        for k in ('items', 'news', 'list'):
            if isinstance(data.get(k), list):
                out.extend(data[k])
    return out


def fetch_news_for_date(ticker: str, target_date: str, span_days: int = 1) -> list[dict]:
    """target_date(YYYYMMDD) ± span_days 일자 뉴스만 필터.

    네이버 datetime 형식: 'YYYYMMDDHHMM' (12자). 앞 8자만 사용.
    """
    items = fetch_stock_news(ticker, page_size=40)
    if not items:
        return []
    target_int = int(target_date)
    out = []
    for it in items:
        dt_raw = (it.get('datetime') or it.get('date') or '')
        # 'YYYYMMDDHHMM' or 'YYYY-MM-DD HH:MM' 둘 다 처리
        dt = dt_raw[:10].replace('-', '').replace(' ', '')[:8]
        if not dt or not dt.isdigit() or len(dt) != 8:
            continue
        if abs(int(dt) - target_int) <= span_days:
            out.append(it)
    return out


def normalize_news_item(it: dict) -> dict:
    """네이버 뉴스 항목 → events.news 표준 형태.

    {title, link, source, date}
    """
    office = it.get('officeId') or '018'
    article = it.get('articleId') or ''
    link = f'https://n.news.naver.com/mnews/article/{office}/{article}' if article else ''
    dt_raw = it.get('datetime') or ''
    date = ''
    if len(dt_raw) >= 8 and dt_raw[:8].isdigit():
        date = f'{dt_raw[:4]}-{dt_raw[4:6]}-{dt_raw[6:8]}'
    return {
        'title': it.get('title') or '',
        'link': link,
        'source': it.get('officeName') or '',
        'date': date,
    }


# ── 종목 메타 (섹터·테마) ────────────────────────────────

def fetch_stock_meta(ticker: str) -> dict:
    """종목 메타 — 시장·섹터·테마 등.

    네이버 종목 페이지 HTML 파싱은 무거워서, 우선 m.stock.naver.com 의
    basic API 만 사용 (섹터 텍스트 일부만). 더 풍부한 테마는 향후 보강.
    """
    url = f'https://m.stock.naver.com/api/stock/{ticker}/basic'
    data = fetch_json(url)
    if not isinstance(data, dict):
        return {}
    return {
        'name': data.get('stockName') or '',
        'market': (data.get('stockExchangeType') or {}).get('code', ''),
        'industry': data.get('industryGroupKor') or '',
        'sector': data.get('groupKindKor') or '',
    }
