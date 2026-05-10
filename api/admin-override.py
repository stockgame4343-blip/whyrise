"""Vercel serverless — 관리자 상승이유 override 저장.

POST    : { date, ticker, rise_reason, theme_tag?, note? } → overrides/{date}.json 의 ticker 키 갱신
DELETE  : ?date=YYYYMMDD&ticker=NNNNNN → 해당 ticker 항목 삭제
GET     : ?date=YYYYMMDD → 해당 일자 overrides 전체 반환

저장: GitHub API 로 whyrise repo 의 public/data/overrides/{date}.json commit.
인증: HttpOnly 쿠키 wr_admin 검증 (admin-login.py 와 동일 HMAC).
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler

GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN', '')
REPO = os.environ.get('GITHUB_REPO', 'stockgame4343-blip/whyrise')
BRANCH = os.environ.get('GITHUB_BRANCH', 'master')
ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
SESSION_SECRET = os.environ.get('SESSION_SECRET', ADMIN_TOKEN)
COOKIE_NAME = 'wr_admin'

DATE_RE = re.compile(r'^\d{8}$')
TICKER_RE = re.compile(r'^\d{6}$')


def _sign():
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


def _gh(method, path, data=None):
    url = f'https://api.github.com{path}'
    headers = {
        'Authorization': f'Bearer {GITHUB_TOKEN}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'whyrise-admin',
    }
    body = json.dumps(data).encode('utf-8') if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _get_overrides(date):
    file_path = f'public/data/overrides/{date}.json'
    try:
        result = _gh('GET', f'/repos/{REPO}/contents/{file_path}?ref={BRANCH}')
        content = base64.b64decode(result['content']).decode('utf-8')
        return json.loads(content), result['sha']
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}, None
        raise


def _save_overrides(date, overrides, sha, message):
    file_path = f'public/data/overrides/{date}.json'
    content = json.dumps(overrides, ensure_ascii=False, indent=2)
    encoded = base64.b64encode(content.encode('utf-8')).decode('ascii')
    payload = {'message': message, 'content': encoded, 'branch': BRANCH}
    if sha:
        payload['sha'] = sha
    _gh('PUT', f'/repos/{REPO}/contents/{file_path}', payload)


def _trigger_rebuild():
    """admin override commit 후 인덱스 재빌드 트리거 (estimate-only 큐도 갱신).

    실패해도 무시 — 다음 cron 에서 자연 갱신.
    """
    try:
        _gh('POST', f'/repos/{REPO}/dispatches', {
            'event_type': 'override-saved',
            'client_payload': {},
        })
    except Exception:
        pass


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        date = (params.get('date', [None])[0] or '').strip()
        if not DATE_RE.match(date):
            self._respond(400, {'error': 'date 파라미터가 필요합니다 (YYYYMMDD)'})
            return
        try:
            overrides, _ = _get_overrides(date)
            self._respond(200, overrides)
        except Exception as e:
            self._respond(500, {'error': str(e)})

    def do_POST(self):
        if not _is_authed(self.headers):
            self._respond(401, {'error': '관리자 인증 필요'})
            return
        if not GITHUB_TOKEN:
            self._respond(500, {'error': 'GITHUB_TOKEN 미설정'})
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except (json.JSONDecodeError, ValueError):
            self._respond(400, {'error': '잘못된 요청 본문'})
            return

        date = (body.get('date') or '').strip()
        ticker = (body.get('ticker') or '').strip()
        if not DATE_RE.match(date) or not TICKER_RE.match(ticker):
            self._respond(400, {'error': 'date(YYYYMMDD), ticker(6자리) 형식 오류'})
            return

        rise_reason = (body.get('rise_reason') or '').strip()[:500]
        theme_tag = (body.get('theme_tag') or '').strip()[:100]
        note = (body.get('note') or '').strip()[:500]

        try:
            overrides, sha = _get_overrides(date)
            entry = {
                'rise_reason': rise_reason,
                'edited_at': datetime.now(timezone.utc).isoformat(),
            }
            if theme_tag:
                entry['theme_tag'] = theme_tag
            if note:
                entry['note'] = note
            overrides[ticker] = entry
            _save_overrides(date, overrides, sha,
                            f'admin: override {date} {ticker}')
            _trigger_rebuild()
            self._respond(200, {'ok': True, 'ticker': ticker, 'date': date})
        except Exception as e:
            self._respond(500, {'error': str(e)})

    def do_DELETE(self):
        if not _is_authed(self.headers):
            self._respond(401, {'error': '관리자 인증 필요'})
            return
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        date = (params.get('date', [None])[0] or '').strip()
        ticker = (params.get('ticker', [None])[0] or '').strip()
        if not DATE_RE.match(date) or not TICKER_RE.match(ticker):
            self._respond(400, {'error': 'date, ticker 형식 오류'})
            return
        try:
            overrides, sha = _get_overrides(date)
            if ticker in overrides:
                del overrides[ticker]
                _save_overrides(date, overrides, sha,
                                f'admin: remove override {date} {ticker}')
            self._respond(200, {'ok': True})
        except Exception as e:
            self._respond(500, {'error': str(e)})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
