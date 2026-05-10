"""Vercel serverless — 관리자 토큰 인증 (MVP).

GET     : 현재 세션 인증 여부 반환 ({authed: bool})
POST    : { token } 검증 → 인증 시 HttpOnly 쿠키 wr_admin 세팅
DELETE  : 쿠키 삭제 (로그아웃)

쿠키 값은 `hmac_sha256(SECRET, ADMIN_TOKEN)` — 토큰 자체는 노출 안 함.
SECRET 미설정 시 ADMIN_TOKEN 자체를 fallback 비교(보안 약화 — 실제 운영은 SECRET 권장).

Phase 3 OAuth 도입 후 deprecate.
"""
import hashlib
import hmac
import json
import os
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler


ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
SESSION_SECRET = os.environ.get('SESSION_SECRET', ADMIN_TOKEN)
COOKIE_NAME = 'wr_admin'
COOKIE_MAX_AGE = 86400  # 24h


def _sign():
    """ADMIN_TOKEN 의 HMAC — 쿠키 검증용 비교 값."""
    if not SESSION_SECRET or not ADMIN_TOKEN:
        return ''
    return hmac.new(
        SESSION_SECRET.encode('utf-8'),
        ADMIN_TOKEN.encode('utf-8'),
        hashlib.sha256,
    ).hexdigest()


def _is_authed(headers):
    cookie = SimpleCookie()
    raw = headers.get('Cookie', '') or ''
    if not raw:
        return False
    cookie.load(raw)
    val = cookie.get(COOKIE_NAME)
    if not val:
        return False
    expected = _sign()
    if not expected:
        return False
    return hmac.compare_digest(val.value, expected)


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        self._respond(200, {'authed': _is_authed(self.headers)})

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except (json.JSONDecodeError, ValueError):
            self._respond(400, {'error': '잘못된 요청 본문'})
            return

        token = (body.get('token') or '').strip()
        if not ADMIN_TOKEN:
            self._respond(500, {'error': 'ADMIN_TOKEN 환경변수 미설정'})
            return
        if not token or not hmac.compare_digest(token, ADMIN_TOKEN):
            self._respond(401, {'error': '토큰이 올바르지 않습니다'})
            return

        signed = _sign()
        cookie_val = (
            f'{COOKIE_NAME}={signed}; '
            f'HttpOnly; Secure; SameSite=Lax; Path=/; '
            f'Max-Age={COOKIE_MAX_AGE}'
        )
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Set-Cookie', cookie_val)
        self.end_headers()
        self.wfile.write(json.dumps({'authed': True}).encode('utf-8'))

    def do_DELETE(self):
        clear = f'{COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Set-Cookie', clear)
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True}).encode('utf-8'))

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
