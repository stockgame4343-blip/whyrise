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

DATE_RE = re.compile(r'^[0-9]{8}$')
TICKER_RE = re.compile(r'^[0-9]{6}$')

# 입력 필드 최대 길이
REASON_MAXLEN = 500
THEME_MAXLEN = 100
NOTE_MAXLEN = 500


def _param_str(v):
    """요청 파라미터 문자열화 — 문자열만 수용(숫자·배열 등은 빈 값 → 형식 오류로 수렴)."""
    return v.strip() if isinstance(v, str) else ''


def _valid_date(value):
    """ASCII YYYYMMDD 형식과 실제 달력 날짜를 함께 검증."""
    if not DATE_RE.fullmatch(value or ''):
        return False
    try:
        datetime.strptime(value, '%Y%m%d')
        return True
    except ValueError:
        return False


def _sanitize(value, maxlen):
    """입력 정제 — HTML/JS 태그 strip (저장 시점 방어).

    임의 타입 방어: 문자열이 아니면(숫자·배열·객체·null) 빈 값 취급 —
    .strip() 크래시로 500 이 되지 않게 한다.
    """
    if not isinstance(value, str):
        return ''
    s = value.strip()
    if not s:
        return ''
    # <...> 패턴 제거 (escape 보다 강한 strip — 마크업 자체 거부)
    s = re.sub(r'<[^>]*>', '', s)
    # 제어 문자 제거
    s = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', s)
    return s[:maxlen]


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


def _trigger_rebuild(date='', ticker=''):
    """admin override 저장/삭제 후 재빌드 트리거.

    date/ticker payload → build-history.yml 이 override-sync 모드로 해당 종목만
    대상 종목/날짜를 경량 동기화한다. 실패 여부는 호출자 응답의 sync_queued 로 노출하고,
    데이터 저장 자체는 성공으로 유지한다(다음 incremental/full 빌드에서도 자연 수렴).
    """
    try:
        _gh('POST', f'/repos/{REPO}/dispatches', {
            'event_type': 'override-saved',
            'client_payload': {'date': date, 'ticker': ticker},
        })
        return True
    except Exception:
        return False


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        date = _param_str(params.get('date', [None])[0])
        if not _valid_date(date):
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
        if not isinstance(body, dict):
            # 배열·문자열·숫자 등 비객체 JSON — .get 크래시(500) 대신 400
            self._respond(400, {'error': '요청 본문은 JSON 객체여야 합니다'})
            return

        date = _param_str(body.get('date'))
        ticker = _param_str(body.get('ticker'))
        if not _valid_date(date) or not TICKER_RE.fullmatch(ticker):
            self._respond(400, {'error': 'date(YYYYMMDD), ticker(6자리) 형식 오류'})
            return

        rise_reason = _sanitize(body.get('rise_reason'), REASON_MAXLEN)
        theme_tag = _sanitize(body.get('theme_tag'), THEME_MAXLEN)
        note = _sanitize(body.get('note'), NOTE_MAXLEN)

        try:
            overrides, sha = _get_overrides(date)
            entry = {
                'rise_reason': rise_reason,
                'edited_at': datetime.now(timezone.utc).isoformat(),
            }
            # 빈 theme_tag/note 는 키 생략 = '지움' — 저장은 항상 entry 전체 교체(replace)라
            # 빌드(apply_overrides)/JS 소비자가 생략된 필드의 원본 값/부재를 복원한다.
            if theme_tag:
                entry['theme_tag'] = theme_tag
            if note:
                entry['note'] = note
            overrides[ticker] = entry
            _save_overrides(date, overrides, sha,
                            f'admin: override {date} {ticker}')
            sync_queued = _trigger_rebuild(date, ticker)
            self._respond(200, {'ok': True, 'ticker': ticker, 'date': date,
                                'sync_queued': sync_queued})
        except Exception as e:
            self._respond(500, {'error': str(e)})

    def do_DELETE(self):
        if not _is_authed(self.headers):
            self._respond(401, {'error': '관리자 인증 필요'})
            return
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        date = _param_str(params.get('date', [None])[0])
        ticker = _param_str(params.get('ticker', [None])[0])
        if not _valid_date(date) or not TICKER_RE.fullmatch(ticker):
            self._respond(400, {'error': 'date, ticker 형식 오류'})
            return
        try:
            overrides, sha = _get_overrides(date)
            if ticker in overrides:
                del overrides[ticker]
                _save_overrides(date, overrides, sha,
                                f'admin: remove override {date} {ticker}')
            # 삭제도 재빌드 필요 — bake 된 admin 사유를 원본으로 원복(override-sync).
            # ticker 가 이미 없어도 dispatch 는 항상 — 이전 삭제의 dispatch 가 실패해
            # bake 만 잔존한 경우, 같은 DELETE 재시도로 원복을 다시 걸 수 있어야 한다.
            sync_queued = _trigger_rebuild(date, ticker)
            self._respond(200, {'ok': True, 'sync_queued': sync_queued})
        except Exception as e:
            self._respond(500, {'error': str(e)})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
