import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
from http.cookies import SimpleCookie


SESSION_COOKIE = 'wr_user'
STATE_COOKIE = 'wr_oauth_state'
NEXT_COOKIE = 'wr_oauth_next'
SESSION_MAX_AGE = 60 * 60 * 24 * 30
STATE_MAX_AGE = 60 * 10

GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET', '')
AUTH_SECRET = (
    os.environ.get('AUTH_SECRET')
    or os.environ.get('AUTH_SESSION_SECRET')
    or os.environ.get('SESSION_SECRET')
    or ''
)


def login_configured():
    return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and AUTH_SECRET)


def cookie_secure(headers):
    host = (headers.get('X-Forwarded-Host') or headers.get('Host') or '').lower()
    proto = (headers.get('X-Forwarded-Proto') or '').lower()
    if proto == 'http':
        return False
    return not (host.startswith('localhost') or host.startswith('127.0.0.1'))


def origin_from_headers(headers):
    host = headers.get('X-Forwarded-Host') or headers.get('Host') or ''
    proto = headers.get('X-Forwarded-Proto')
    if not proto:
        proto = 'http' if host.startswith(('localhost', '127.0.0.1')) else 'https'
    return f'{proto}://{host}'


def redirect_uri(headers):
    return (
        os.environ.get('GOOGLE_REDIRECT_URI')
        or os.environ.get('AUTH_REDIRECT_URI')
        or f'{origin_from_headers(headers)}/api/auth-callback'
    )


def safe_next(value):
    value = (value or '/').strip()
    if not value.startswith('/') or value.startswith('//'):
        return '/'
    return value


def parse_cookie(headers):
    cookie = SimpleCookie()
    raw = headers.get('Cookie', '') or ''
    if raw:
        try:
            cookie.load(raw)
        except Exception:
            return SimpleCookie()
    return cookie


def cookie_header(name, value, max_age, headers=None, http_only=True):
    parts = [
        f'{name}={value}',
        'Path=/',
        f'Max-Age={int(max_age)}',
        'SameSite=Lax',
    ]
    if http_only:
        parts.append('HttpOnly')
    if headers is None or cookie_secure(headers):
        parts.append('Secure')
    return '; '.join(parts)


def clear_cookie_header(name, headers=None):
    return cookie_header(name, '', 0, headers=headers)


def _b64e(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _b64d(value):
    pad = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + pad).encode('ascii'))


def _signature(body):
    return hmac.new(AUTH_SECRET.encode('utf-8'), body.encode('ascii'), hashlib.sha256).hexdigest()


def sign_session(user):
    now = int(time.time())
    payload = {
        'sub': str(user.get('sub') or ''),
        'email': str(user.get('email') or ''),
        'name': str(user.get('name') or user.get('email') or ''),
        'picture': str(user.get('picture') or ''),
        'iat': now,
        'exp': now + SESSION_MAX_AGE,
    }
    body = _b64e(json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))
    return body + '.' + _signature(body)


def verify_session(token):
    if not token or not AUTH_SECRET or '.' not in token:
        return None
    body, sig = token.rsplit('.', 1)
    if not hmac.compare_digest(_signature(body), sig):
        return None
    try:
        payload = json.loads(_b64d(body).decode('utf-8'))
    except Exception:
        return None
    if int(payload.get('exp') or 0) < int(time.time()):
        return None
    if not payload.get('sub'):
        return None
    return payload


def get_session_user(headers):
    cookie = parse_cookie(headers)
    morsel = cookie.get(SESSION_COOKIE)
    if not morsel:
        return None
    return verify_session(morsel.value)


def user_key(user):
    sub = str((user or {}).get('sub') or '')
    cleaned = re.sub(r'[^A-Za-z0-9_-]+', '_', sub).strip('_')
    return cleaned or 'unknown'


def redirect_response(handler, location, headers=None):
    handler.send_response(302)
    handler.send_header('Location', location)
    handler.send_header('Cache-Control', 'no-store')
    for key, value in headers or []:
        handler.send_header(key, value)
    handler.end_headers()


def with_auth_query(next_url, reason):
    parsed = urllib.parse.urlsplit(next_url)
    qs = urllib.parse.parse_qs(parsed.query)
    qs['auth'] = [reason]
    query = urllib.parse.urlencode(qs, doseq=True)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', query, parsed.fragment))
