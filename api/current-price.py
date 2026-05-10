"""Vercel serverless function — 현재가 조회 (urllib만 사용, 의존성 0)"""
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler


USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
NAVER_API_URL = 'https://m.stock.naver.com/api/stock/{ticker}/basic'


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        ticker = params.get('ticker', [None])[0]

        if not ticker or len(ticker) != 6 or not ticker.isdigit():
            self._respond(400, {'error': 'ticker 파라미터가 필요합니다 (6자리 숫자)'})
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
            self._respond(200, {'ticker': ticker, 'price': price_int})

        except urllib.error.HTTPError as e:
            self._respond(502, {'error': f'네이버 API 오류: {e.code}', 'ticker': ticker})
        except Exception as e:
            self._respond(502, {'error': str(e), 'ticker': ticker})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
