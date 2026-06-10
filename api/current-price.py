"""Vercel serverless function — 현재가 조회 (urllib만 사용, 의존성 0)"""
import json
import re
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler


USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
NAVER_API_URL = 'https://m.stock.naver.com/api/stock/{ticker}/basic'
# KRX 신형 코드(예: 00088K)는 영문 포함 — 클라이언트(stock.js) 검증과 동일하게 허용
_TICKER_RE = re.compile(r'^[0-9A-Z]{6}$')
# 같은 종목 동시 조회 dedupe — 폴링 도입에 맞춘 짧은 edge 캐시
CACHE_OK = 's-maxage=5, stale-while-revalidate=25'


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        ticker = (params.get('ticker', [None])[0] or '').upper()

        if not _TICKER_RE.match(ticker):
            self._respond(400, {'error': 'ticker 파라미터가 필요합니다 (6자리 종목코드)'})
            return

        try:
            url = NAVER_API_URL.format(ticker=ticker)
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))

            price = data.get('closePrice') or data.get('nowVal')
            if price is None:
                self._respond(404, {'error': '시세 데이터 없음', 'ticker': ticker})
                return

            price_int = int(str(price).replace(',', ''))
            # 종목 메타 — stock-history 미빌드 종목 fallback 용
            name = data.get('stockName') or ''
            exch = (data.get('stockExchangeType') or {})
            market = exch.get('name') or ''  # 'KOSPI' / 'KOSDAQ'
            try:
                rate = float(str(data.get('fluctuationsRatio') or 0).replace(',', ''))
            except (ValueError, TypeError):
                rate = 0.0
            self._respond(200, {
                'ticker': ticker,
                'price': price_int,
                'name': name,
                'market': market,
                'change_rate': round(rate, 2),
            })

        except urllib.error.HTTPError as e:
            self._respond(502, {'error': f'네이버 API 오류: {e.code}', 'ticker': ticker})
        except Exception as e:
            self._respond(502, {'error': str(e), 'ticker': ticker})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        if status == 200:
            self.send_header('Cache-Control', CACHE_OK)
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
