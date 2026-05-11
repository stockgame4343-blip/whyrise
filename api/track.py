"""방문자 heartbeat — Upstash/Vercel KV.

POST { sid: string, first: bool }
  - ZADD online {now} {sid}                  (5분 active 셋)
  - ZREMRANGEBYSCORE online 0 {now - 300}    (만료 청소)
  - if first: SADD unique-visitors {sid}     (누적 unique)

환경변수 KV_REST_API_URL + KV_REST_API_TOKEN 가 없으면 200 OK 만 (no-op).
"""
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler


KV_URL = os.environ.get('KV_REST_API_URL', '').rstrip('/')
KV_TOKEN = os.environ.get('KV_REST_API_TOKEN', '')

ONLINE_KEY = 'wr:online'
UNIQUE_KEY = 'wr:unique'
ONLINE_TTL_SEC = 300   # 5분


def _kv_pipeline(commands):
    """Upstash pipeline — 한 번에 여러 명령 실행."""
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
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except (json.JSONDecodeError, ValueError):
            self._respond(400, {'ok': False, 'error': 'bad json'})
            return

        sid = (body.get('sid') or '').strip()[:64]
        first = bool(body.get('first'))
        if not sid:
            self._respond(400, {'ok': False, 'error': 'sid required'})
            return

        now = int(time.time())
        cutoff = now - ONLINE_TTL_SEC

        commands = [
            ['ZADD', ONLINE_KEY, str(now), sid],
            ['ZREMRANGEBYSCORE', ONLINE_KEY, '0', str(cutoff)],
        ]
        if first:
            commands.append(['SADD', UNIQUE_KEY, sid])

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
