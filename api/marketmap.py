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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler


UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
KOSPI_URL = 'https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=1&pageSize=100'
KOSDAQ_URL = 'https://m.stock.naver.com/api/stocks/marketValue/KOSDAQ?page=1&pageSize=100'


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
        ticker = s.get('itemCode') or ''
        if not ticker or len(ticker) != 6:
            continue
        # marketValueRaw 가 원 단위 정확값. marketValue 는 백만원 단위 콤마 문자열.
        mc = _parse_int(s.get('marketValueRaw')) or (
            (_parse_int(s.get('marketValue')) or 0) * 1_000_000
        )
        if mc <= 0:
            continue
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
            'market_cap': mc,
            'close_price': close,
            'change_rate': round(rate, 2),
            'trading_value': tv or 0,
            'trading_volume': tvol,
        })
    return out


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            k = _fetch(KOSPI_URL)
            d = _fetch(KOSDAQ_URL)
            kospi_items = _normalize(k.get('stocks'), 'KOSPI')
            kosdaq_items = _normalize(d.get('stocks'), 'KOSDAQ')

            # 시총 내림차순 — 시장 내부 정렬은 이미 API 가 보장 (marketValue 순)
            kospi_items.sort(key=lambda x: x['market_cap'], reverse=True)
            kosdaq_items.sort(key=lambda x: x['market_cap'], reverse=True)
            items = kospi_items[:100] + kosdaq_items[:100]

            # 시장 상태 / 기준일
            first = (k.get('stocks') or [{}])[0] if k.get('stocks') else {}
            market_status = first.get('marketStatus') or 'CLOSE'
            traded = (first.get('localTradedAt') or '')[:10].replace('-', '')

            self._respond(200, {
                'date': traded,
                'updated_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
                'market_status': market_status,
                'items': items,
            })
        except urllib.error.HTTPError as e:
            self._respond(502, {'error': f'네이버 API 오류: {e.code}'})
        except Exception as e:
            self._respond(502, {'error': str(e)[:200]})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        # 5초 캐시 — 같은 5초 윈도우 내 다른 사용자 요청은 edge cache 히트
        self.send_header('Cache-Control', 's-maxage=5, stale-while-revalidate=10')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
