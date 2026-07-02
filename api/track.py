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
"""
import json
import os
import time
import urllib.request
from http.server import BaseHTTPRequestHandler


KV_URL = os.environ.get('KV_REST_API_URL', '').rstrip('/')
KV_TOKEN = os.environ.get('KV_REST_API_TOKEN', '')

ONLINE_KEY = 'wr:online'
UNIQUE_KEY = 'wr:unique'
ONLINE_TTL_SEC = 300        # 5분
DAY_TTL_SEC = 40 * 86400    # 일별 키 보관 40일


def _kst_day(now):
    return time.strftime('%Y%m%d', time.gmtime(now + 9 * 3600))


def _ref_host(ref):
    """referrer 문자열 → 호스트(외부만). 내부/빈 값은 ''."""
    ref = (ref or '').strip()
    if not ref:
        return ''
    # utm 유입(visitor.js 가 'utm:telegram/daily' 형태로 승격) — 그대로 집계
    if ref.startswith('utm:'):
        return ref[:80]
    try:
        from urllib.parse import urlparse
        h = (urlparse(ref).hostname or '').lower()
    except Exception:
        return ''
    if not h:
        return ''
    for own in ('orgo.kr', 'whyrise.vercel.app', 'localhost'):
        if h == own or h.endswith('.' + own):
            return ''   # 자기 도메인 유입 제외
    return h[:80]


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
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except (json.JSONDecodeError, ValueError):
            self._respond(400, {'ok': False, 'error': 'bad json'})
            return

        sid = (body.get('sid') or '').strip()[:64]
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
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
