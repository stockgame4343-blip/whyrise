"""방문자 heartbeat + 일별 집계 — Upstash/Vercel KV.

POST { sid, first?, pv?, ref?, dur?, path? }
  - ZADD wr:online {now} {sid}                  (5분 active)
  - ZREMRANGEBYSCORE wr:online 0 {now-300}       (만료 청소)
  - SADD wr:visitors:{day} {sid}                 (그날 순방문)
  - if first: SADD wr:unique {sid} ; INCR wr:new:{day}      (누적/신규)
  - if pv:    INCR wr:pv:{day} ; (ref 있으면) ZINCRBY wr:ref:{day} 1 {refHost}
  - if dur:   ZADD wr:dur:{day} {durSec} {sid}   (세션 체류시간, 최신값)

day = KST(Asia/Seoul) YYYYMMDD. 일별 키는 TTL 40일.
환경변수 KV_REST_API_URL + KV_REST_API_TOKEN 없으면 200 OK no-op.

보안: Origin 이 있으면 자기 도메인(ALLOWED_ORIGINS)만 허용(403).
ref 는 utm allowlist / host 문자셋 검증 통과분만 집계 (저장형 XSS 차단).
"""
import json
import os
import re
import time
import urllib.request
from http.server import BaseHTTPRequestHandler


KV_URL = os.environ.get('KV_REST_API_URL', '').rstrip('/')
KV_TOKEN = os.environ.get('KV_REST_API_TOKEN', '')

ONLINE_KEY = 'wr:online'
UNIQUE_KEY = 'wr:unique'
ONLINE_TTL_SEC = 300        # 5분
DAY_TTL_SEC = 40 * 86400    # 일별 키 보관 40일

# same-origin 검증 — 통계 POST 는 자기 사이트 페이지에서만.
# Origin 이 아예 없는 요청(sendBeacon 일부 구현·서버 모니터)은 허용한다:
# 브라우저의 cross-origin fetch/XHR/sendBeacon 은 항상 Origin 을 붙이므로
# 외부 사이트발 위조는 아래 allowlist 에서 걸리고, Origin 없는 요청은
# 브라우저 교차출처 경로가 아니다 (curl 스팸은 XSS 와 무관, 별개 위협).
ALLOWED_ORIGINS = (
    'https://orgo.kr',
    'https://www.orgo.kr',
    'https://whyrise.vercel.app',
)
_LOCAL_ORIGIN_RE = re.compile(r'^https?://(localhost|127\.0\.0\.1)(:\d+)?$')

# utm ref allowlist — visitor.js 가 만드는 'utm:{source}[/{campaign}]' 형식만.
# 영숫자·._- 만 허용 → HTML 특수문자·공백·스킴(:)·태그(<>) 전부 거부 (저장형 XSS 차단).
_UTM_REF_RE = re.compile(r'^utm:[A-Za-z0-9_.\-]{1,40}(/[A-Za-z0-9_.\-]{1,40})?$')
# referrer host — DNS 호스트 문자셋만. urlparse 는 'http://<script>x' 류의
# netloc 을 그대로 돌려주므로 파싱 결과를 다시 검증해야 한다.
_HOST_RE = re.compile(r'^[a-z0-9]([a-z0-9\-]{0,62})?(\.[a-z0-9]([a-z0-9\-]{0,62})?)+$')


def _kst_day(now):
    return time.strftime('%Y%m%d', time.gmtime(now + 9 * 3600))


def _origin_allowed(origin):
    """Origin 헤더 same-origin 검증. 빈 값은 허용(위 ALLOWED_ORIGINS 주석 참조)."""
    if not origin:
        return True
    if origin in ALLOWED_ORIGINS:
        return True
    return bool(_LOCAL_ORIGIN_RE.match(origin))


def _ref_host(ref):
    """referrer 문자열 → 호스트(외부만). 내부/빈/비정상 값은 ''."""
    if not isinstance(ref, str):
        return ''
    ref = ref.strip()
    if not ref:
        return ''
    # utm 유입(visitor.js 가 'utm:telegram/daily' 형태로 승격) — 엄격한 형식만 집계
    if ref.startswith('utm:'):
        return ref if _UTM_REF_RE.match(ref) else ''
    try:
        from urllib.parse import urlparse
        h = (urlparse(ref).hostname or '').lower()
    except Exception:
        return ''
    if not h or len(h) > 80 or not _HOST_RE.match(h):
        return ''
    for own in ('orgo.kr', 'whyrise.vercel.app', 'localhost'):
        if h == own or h.endswith('.' + own):
            return ''   # 자기 도메인 유입 제외
    return h


def _kv_pipeline(commands):
    if not KV_URL or not KV_TOKEN or not commands:
        return None
    req = urllib.request.Request(
        f'{KV_URL}/pipeline',
        data=json.dumps(commands).encode('utf-8'),
        method='POST',
        headers={'Authorization': f'Bearer {KV_TOKEN}', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not _origin_allowed((self.headers.get('Origin') or '').strip()):
            self._respond(403, {'ok': False, 'error': 'forbidden origin'})
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except (json.JSONDecodeError, ValueError):
            self._respond(400, {'ok': False, 'error': 'bad json'})
            return
        if not isinstance(body, dict):
            self._respond(400, {'ok': False, 'error': 'json object required'})
            return

        raw_sid = body.get('sid')
        sid = raw_sid.strip()[:64] if isinstance(raw_sid, str) else ''
        if not sid:
            self._respond(400, {'ok': False, 'error': 'sid required'})
            return
        first = bool(body.get('first'))
        pv = bool(body.get('pv'))
        try:
            dur = int(body.get('dur') or 0)
        except (ValueError, TypeError):
            dur = 0
        dur = max(0, min(dur, 6 * 3600))   # 0~6시간 클램프(이상치 차단)
        ref_host = _ref_host(body.get('ref'))

        now = int(time.time())
        day = _kst_day(now)
        vkey = f'wr:visitors:{day}'
        nkey = f'wr:new:{day}'
        pkey = f'wr:pv:{day}'
        rkey = f'wr:ref:{day}'
        dkey = f'wr:dur:{day}'
        ttl = str(DAY_TTL_SEC)

        commands = [
            ['ZADD', ONLINE_KEY, str(now), sid],
            ['ZREMRANGEBYSCORE', ONLINE_KEY, '0', str(now - ONLINE_TTL_SEC)],
            ['SADD', vkey, sid],
            ['EXPIRE', vkey, ttl],
        ]
        if first:
            commands += [['SADD', UNIQUE_KEY, sid],
                         ['INCR', nkey], ['EXPIRE', nkey, ttl]]
        if pv:
            commands += [['INCR', pkey], ['EXPIRE', pkey, ttl]]
            if ref_host:
                commands += [['ZINCRBY', rkey, '1', ref_host], ['EXPIRE', rkey, ttl]]
        if dur > 0:
            commands += [['ZADD', dkey, str(dur), sid], ['EXPIRE', dkey, ttl]]

        _kv_pipeline(commands)
        self._respond(200, {'ok': True})

    def do_OPTIONS(self):
        # CORS 헤더 없음 — same-origin 전용 엔드포인트.
        # 외부 Origin 의 preflight 는 여기서 실패해 브라우저가 POST 자체를 막는다.
        # (same-origin 요청은 preflight 를 타지 않으므로 정상 호출엔 영향 없음)
        self.send_response(204)
        self.send_header('Allow', 'POST, OPTIONS')
        self.end_headers()

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
