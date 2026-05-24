import json
import os
import sys
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler


sys.path.append(os.path.dirname(__file__))
from _auth import (  # noqa: E402
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_TOKEN_URL,
    GOOGLE_TOKENINFO_URL,
    NEXT_COOKIE,
    SESSION_COOKIE,
    SESSION_MAX_AGE,
    STATE_COOKIE,
    clear_cookie_header,
    cookie_header,
    login_configured,
    parse_cookie,
    redirect_response,
    redirect_uri,
    sign_session,
    safe_next,
    with_auth_query,
)


def _post_form(url, data, timeout=8):
    body = urllib.parse.urlencode(data).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        method='POST',
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _get_json(url, params, timeout=8):
    req = urllib.request.Request(url + '?' + urllib.parse.urlencode(params), method='GET')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


class handler(BaseHTTPRequestHandler):

    def _next_from_cookie(self):
        cookie = parse_cookie(self.headers)
        val = cookie.get(NEXT_COOKIE)
        if not val:
            return '/'
        return safe_next(urllib.parse.unquote(val.value))

    def _redirect_done(self, next_url, reason=None, extra_headers=None):
        headers = [
            ('Set-Cookie', clear_cookie_header(STATE_COOKIE, headers=self.headers)),
            ('Set-Cookie', clear_cookie_header(NEXT_COOKIE, headers=self.headers)),
        ]
        headers.extend(extra_headers or [])
        redirect_response(self, with_auth_query(next_url, reason) if reason else next_url, headers)

    def do_GET(self):
        next_url = self._next_from_cookie()
        if not login_configured():
            self._redirect_done(next_url, 'setup_missing')
            return

        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        if qs.get('error'):
            self._redirect_done(next_url, 'cancelled')
            return

        code = (qs.get('code') or [''])[0]
        state = (qs.get('state') or [''])[0]
        cookie = parse_cookie(self.headers)
        expected_state = cookie.get(STATE_COOKIE).value if cookie.get(STATE_COOKIE) else ''
        if not code or not state or not expected_state or state != expected_state:
            self._redirect_done(next_url, 'state')
            return

        try:
            token = _post_form(GOOGLE_TOKEN_URL, {
                'code': code,
                'client_id': GOOGLE_CLIENT_ID,
                'client_secret': GOOGLE_CLIENT_SECRET,
                'redirect_uri': redirect_uri(self.headers),
                'grant_type': 'authorization_code',
            })
            id_token = token.get('id_token')
            if not id_token:
                self._redirect_done(next_url, 'token')
                return
            info = _get_json(GOOGLE_TOKENINFO_URL, {'id_token': id_token})
        except Exception:
            self._redirect_done(next_url, 'token')
            return

        if str(info.get('aud') or '') != GOOGLE_CLIENT_ID:
            self._redirect_done(next_url, 'audience')
            return
        if str(info.get('email_verified') or '').lower() not in ('true', '1'):
            self._redirect_done(next_url, 'email')
            return

        user = {
            'sub': info.get('sub') or '',
            'email': info.get('email') or '',
            'name': info.get('name') or info.get('email') or '',
            'picture': info.get('picture') or '',
        }
        session = sign_session(user)
        headers = [
            ('Set-Cookie', cookie_header(
                SESSION_COOKIE,
                session,
                SESSION_MAX_AGE,
                headers=self.headers,
            )),
        ]
        self._redirect_done(next_url, None, headers)
