"""단일 종목 시총 조회 — screening 페이지 '미집계' 보강용.

marketmap.json 에 잡혀있지 않은 중소형주에 대해 finance.naver.com 종목 페이지
HTML 의 `<em id="_market_sum">` 영역(조·억 두 그룹 또는 억 한 그룹)을 파싱해
억원 단위로 반환. 네이버 mobile API /basic·/integration 은 marketValue 필드가
None 으로 빠져있어 사용 불가.

edge 캐시 1h — 같은 ticker 요청은 vercel edge 즉시 응답.
"""
import json
import re
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler


UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
URL = 'https://finance.naver.com/item/main.naver?code={ticker}'
_RE_MARKET_SUM = re.compile(r'id="_market_sum"[^>]*>(.*?)</em>', re.S)
_RE_NUMS = re.compile(r'([0-9,]+)')


def _parse_market_sum_eok(html: str) -> int:
    """HTML 에서 시총(억원) 추출. 조+억 두 그룹이면 `cho*10000+eok`, 한 그룹이면 그대로 억."""
    m = _RE_MARKET_SUM.search(html)
    if not m:
        return 0
    raw = re.sub(r'<[^>]+>|\s+', '', m.group(1))
    nums = _RE_NUMS.findall(raw)
    if len(nums) >= 2:
        return int(nums[0].replace(',', '')) * 10000 + int(nums[1].replace(',', ''))
    if nums:
        return int(nums[0].replace(',', ''))
    return 0


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        ticker = params.get('ticker', [None])[0]

        if not ticker or len(ticker) != 6 or not ticker.isdigit():
            self._respond(400, {'error': 'ticker 파라미터 (6자리 숫자) 필요'})
            return

        try:
            req = urllib.request.Request(URL.format(ticker=ticker), headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=5) as resp:
                html = resp.read().decode('euc-kr', errors='ignore')
            mc_eok = _parse_market_sum_eok(html)
            self._respond(200, {'ticker': ticker, 'market_cap': mc_eok})
        except urllib.error.HTTPError as e:
            self._respond(502, {'error': f'네이버 {e.code}', 'ticker': ticker})
        except Exception as e:
            self._respond(502, {'error': str(e)[:100], 'ticker': ticker})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        # 1h edge 캐시 — 시총은 분단위로 안 변함. 같은 ticker 는 vercel edge 즉시 응답.
        self.send_header('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
