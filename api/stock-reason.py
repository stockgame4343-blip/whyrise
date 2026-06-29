"""Vercel serverless — 단일 종목 '상승 이유' 보강용 경량 뉴스+업종 프록시.

stock-rise 빌드가 TOP_N=100 cap 이라, +15% 종목이 100개를 넘는 날엔 100위 밖 급등주가
whyrise 홈 합성행에 '이유 분석 대기중' 으로 남는다(빌드에 뉴스/테마가 없음). 이 핸들러는
그 종목 하나에 대해 네이버 금융 종목뉴스(+업종)를 즉석에서 가져와 빌드와 동일한
news 구조({title,link,source,date}) + theme_tag 로 돌려준다.

'상승 이유 문구' 는 만들지 않는다 — 유사투자자문 미신고 리스크. raw 뉴스/업종만 주고,
표시 가공('OO 관련 뉴스'·뉴스 제목 이슈 추출)은 클라이언트 table.js cleanReasonText 가 전담한다.

응답:
{
  "ticker": "025620",
  "theme_tag": "화장품",                            # 네이버 업종, 실패 시 ''
  "news": [ {title, link, source, date}, ... ]      # 종목명/[특징주] 우선 상위 N
}
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler


UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
REFERER = 'https://finance.naver.com/'
NEWS_BASE = 'https://finance.naver.com'
NEWS_URL = 'https://finance.naver.com/item/news_news.naver?code={ticker}&page=1'
MAIN_URL = 'https://finance.naver.com/item/main.naver?code={ticker}'

TICKER_RE = re.compile(r'^[0-9A-Z]{6}$')   # current-price.py 와 동일 — 영문 신코드 포함
MAX_ARTICLES = 6
FETCH_TIMEOUT = 6        # 개별 네이버 호출 타임아웃(초) — Vercel ~10s 안에 2회 병렬+재시도 여유
# 뉴스는 자주 안 바뀜 → edge 캐시 길게(종목당 1회로 네이버 호출 절감). 오류·빈응답은 캐시 안 함.
CACHE_OK = 's-maxage=600, stale-while-revalidate=1200'

# 종목 뉴스 테이블 한 행: 제목(링크) + 출처 + 날짜 (finance.naver.com EUC-KR)
ROW_RE = re.compile(
    r'<td class="title">\s*<a href="([^"]+)"[^>]*>(.*?)</a>.*?'
    r'<td class="info">(.*?)</td>\s*'
    r'<td class="date">\s*([\d.]+)',
    re.S,
)
TAG_RE = re.compile(r'<[^>]+>')
# 업종(테마) — type=upjong 링크 중 '동일업종' 류 보조 링크가 아닌 첫 업종명
UPJONG_RE = re.compile(r'type=upjong[^>]*>([^<]+)</a>')
# 광고/루틴 단신 노이즈 (경량 — 빌드 _is_spam_article 의 핵심만)
SPAM_TITLE = re.compile(r'\[(?:게시판|부고|인사|포토)\]|PRNewswire|Business Wire')


def _clean(s):
    s = TAG_RE.sub('', s or '')
    for a, b in (('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'),
                 ('&#39;', "'"), ('&apos;', "'"), ('&hellip;', '…'),
                 ('&middot;', '·'), ('&nbsp;', ' '),
                 ('&uarr;', '↑'), ('&darr;', '↓'), ('&rarr;', '→')):
        s = s.replace(a, b)
    return re.sub(r'\s+', ' ', s).strip()


def _fetch(url):
    # 네이버 금융은 엔드포인트별 인코딩이 다르다 — news_news=EUC-KR, main=UTF-8.
    # 응답 charset 헤더를 따르고, 없으면 EUC-KR 폴백.
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': REFERER})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        raw = resp.read()
        m = re.search(r'charset=([\w-]+)', resp.headers.get('Content-Type', ''))
        return raw.decode(m.group(1) if m else 'euc-kr', 'replace')


def _fetch_retry(url):
    """외부 호출 — 1회 재시도(콜드/순간 오류). 최종 실패는 None."""
    for _ in range(2):
        try:
            return _fetch(url)
        except Exception:
            continue
    return None


def _priority(title, name):
    """종목명 포함·[특징주] 기사를 상위로 — 종목 무관 시황 노이즈를 뒤로."""
    p = 0
    if name and name in title:
        p += 10
    if title.startswith('[특징주]'):
        p += 5
    return p


def _parse_news(html, name):
    if not html:
        return []
    seen = set()
    out = []
    for link, title, info, date in ROW_RE.findall(html):
        title = _clean(title)
        if not title or title in seen or SPAM_TITLE.search(title):
            continue
        seen.add(title)
        if link and not link.startswith('http'):
            link = NEWS_BASE + link
        out.append({
            'title': title,
            'link': link,
            'source': _clean(info),
            'date': (date or '')[:10],          # "YYYY.MM.DD HH:MM" → "YYYY.MM.DD"
            '_score': _priority(title, name),
        })
    out.sort(key=lambda a: a['_score'], reverse=True)
    for a in out:
        del a['_score']
    return out[:MAX_ARTICLES]


def _parse_theme(html):
    if not html:
        return ''
    for raw in UPJONG_RE.findall(html):
        t = _clean(raw)
        if t and not t.startswith('동일업종'):
            return t
    return ''


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            ticker = (q.get('ticker', [''])[0] or '').upper()
            name = (q.get('name', [''])[0] or '').strip()
            if not TICKER_RE.match(ticker):
                self._respond(400, {'error': 'invalid ticker'})
                return
            # 뉴스 + 업종 병렬 fetch (각 1회 재시도) — Vercel timeout 안에서 합산 최소화
            with ThreadPoolExecutor(max_workers=2) as ex:
                f_news = ex.submit(_fetch_retry, NEWS_URL.format(ticker=ticker))
                f_main = ex.submit(_fetch_retry, MAIN_URL.format(ticker=ticker))
                news_html = f_news.result()
                main_html = f_main.result()
            news = _parse_news(news_html, name)
            theme = _parse_theme(main_html)
            # 뉴스가 있으면 길게 캐시, 없으면 캐시 안 함(나중에 생길 수 있어 재요청 허용)
            self._respond(200, {
                'ticker': ticker,
                'theme_tag': theme,
                'news': news,
            }, cache=(CACHE_OK if news else None))
        except urllib.error.HTTPError as e:
            self._respond(502, {'error': 'naver %d' % e.code})
        except Exception as e:
            self._respond(502, {'error': str(e)[:200]})

    def _respond(self, status, body, cache=None):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        if cache:
            self.send_header('Cache-Control', cache)
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
