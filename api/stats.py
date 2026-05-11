"""방문자 통계 — Upstash/Vercel KV.

GET → { ok, online, unique }

KV 환경변수 없으면 ok:false 반환 (프런트는 카운터 자동 숨김).
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
ONLINE_TTL_SEC = 300


def _kv_pipeline(commands):
    if not KV_URL or not KV_TOKEN:
        return None
    body = json.dumps(commands).encode('utf-8')
    req = urllib.request.Request(
        f'{KV_URL}/pipeline',
        data=body,
        method='POST',
        headers={
            'Authorization': f'Bearer {KV_TOKEN}',
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not KV_URL or not KV_TOKEN:
            self._respond(200, {'ok': False, 'reason': 'kv_not_connected'})
            return

        now = int(time.time())
        cutoff = now - ONLINE_TTL_SEC

        # 만료 정리 + 카운트 한 번에
        results = _kv_pipeline([
            ['ZREMRANGEBYSCORE', ONLINE_KEY, '0', str(cutoff)],
            ['ZCARD', ONLINE_KEY],
            ['SCARD', UNIQUE_KEY],
        ])
        if not results or len(results) < 3:
            self._respond(200, {'ok': False, 'reason': 'kv_error'})
            return

        # Upstash pipeline 응답: [{result: ...}, ...]
        def _r(idx):
            try:
                v = results[idx]
                if isinstance(v, dict) and 'result' in v:
                    return int(v['result'] or 0)
                return int(v or 0)
            except (ValueError, TypeError):
                return 0

        self._respond(200, {
            'ok': True,
            'online': _r(1),
            'unique': _r(2),
        })

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
