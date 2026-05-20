"""관심 별점·메모 동기화 — Vercel KV 단일 키.

GET  /api/ratings → { ok, ratings, updated_at }
POST /api/ratings → body { ratings: {...} } → { ok, updated_at }

본인만 쓰는 사이트 전제로 인증 없이 열어둠. localStorage(whyrise-ratings)
값을 통째로 KV 키 `whyrise:ratings` 에 덮어쓰고, 클라이언트는 페이지 로드
시 GET 으로 머지한다 (서버 → 로컬 방향이 우선).

마지막 쓰기 우선(LWW). 두 디바이스에서 동시 변경 시 늦게 도착한 POST 가
이긴다. 본인 1인 사용 전제라 큰 문제 없음.

KV 환경변수 미설정 시 503 으로 즉시 응답해 클라이언트가 동기화 비활성화
모드로 전환할 수 있게 한다.
"""
import json
import os
import time
import urllib.request
from http.server import BaseHTTPRequestHandler


KV_URL = os.environ.get('KV_REST_API_URL', '').rstrip('/')
KV_TOKEN = os.environ.get('KV_REST_API_TOKEN', '')

RATINGS_KEY = 'whyrise:ratings'
META_KEY = 'whyrise:ratings:updated_at'
MAX_BODY_BYTES = 256 * 1024  # 256KB — 1000+ ticker × 작은 객체 여유분


def _kv_pipeline(commands, timeout=5):
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
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


def _result(results, idx):
    """Upstash pipeline 응답에서 idx 번째 result 추출."""
    try:
        v = results[idx]
        if isinstance(v, dict) and 'result' in v:
            return v['result']
        return v
    except (IndexError, TypeError):
        return None


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        if not KV_URL or not KV_TOKEN:
            self._respond(503, {'ok': False, 'reason': 'kv_not_connected'})
            return

        results = _kv_pipeline([
            ['GET', RATINGS_KEY],
            ['GET', META_KEY],
        ])
        if not results:
            self._respond(502, {'ok': False, 'reason': 'kv_error'})
            return

        raw = _result(results, 0)
        try:
            ratings = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            ratings = {}
        try:
            updated_at = int(_result(results, 1) or 0)
        except (TypeError, ValueError):
            updated_at = 0

        self._respond(200, {
            'ok': True,
            'ratings': ratings,
            'updated_at': updated_at,
        })

    def do_POST(self):
        if not KV_URL or not KV_TOKEN:
            self._respond(503, {'ok': False, 'reason': 'kv_not_connected'})
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(400, {'ok': False, 'reason': 'invalid_length'})
            return

        try:
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
            self._respond(400, {'ok': False, 'reason': 'invalid_json'})
            return

        ratings = body.get('ratings')
        if not isinstance(ratings, dict):
            self._respond(400, {'ok': False, 'reason': 'ratings_not_object'})
            return

        # 단순 sanitize — ticker 키 형식 + 각 rating 객체에 허용 필드만 통과
        cleaned = {}
        for k, v in ratings.items():
            if not isinstance(k, str) or len(k) > 8:
                continue
            if not isinstance(v, dict):
                continue
            entry = {}
            if isinstance(v.get('stars'), (int, float)):
                s = int(v['stars'])
                if 0 <= s <= 5:
                    entry['stars'] = s
            if isinstance(v.get('excluded'), bool):
                entry['excluded'] = v['excluded']
            memo = v.get('memo')
            if isinstance(memo, str):
                entry['memo'] = memo[:2000]
            if entry:
                cleaned[k] = entry

        now = int(time.time())
        payload = json.dumps(cleaned, ensure_ascii=False)
        results = _kv_pipeline([
            ['SET', RATINGS_KEY, payload],
            ['SET', META_KEY, str(now)],
        ])
        if not results:
            self._respond(502, {'ok': False, 'reason': 'kv_write_failed'})
            return

        self._respond(200, {
            'ok': True,
            'updated_at': now,
            'count': len(cleaned),
        })

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
