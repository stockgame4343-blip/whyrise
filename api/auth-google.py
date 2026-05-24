import os
import secrets
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler


sys.path.append(os.path.dirname(__file__))
from _auth import (  # noqa: E402
    GOOGLE_AUTH_URL,
    GOOGLE_CLIENT_ID,
    NEXT_COOKIE,
    STATE_COOKIE,
    STATE_MAX_AGE,
    cookie_header,
    login_configured,
    redirect_response,
    redirect_uri,
    safe_next,
    with_auth_query,
)


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        next_url = safe_next((qs.get('next') or ['/'])[0])

        if not login_configured():
            redirect_response(self, with_auth_query(next_url, 'setup_missing'))
            return

        state = secrets.token_urlsafe(32)
        params = {
            'client_id': GOOGLE_CLIENT_ID,
            'redirect_uri': redirect_uri(self.headers),
            'response_type': 'code',
            'scope': 'openid email profile',
            'state': state,
            'prompt': 'select_account',
        }
        headers = [
            ('Set-Cookie', cookie_header(STATE_COOKIE, state, STATE_MAX_AGE, headers=self.headers)),
            ('Set-Cookie', cookie_header(
                NEXT_COOKIE,
                urllib.parse.quote(next_url, safe=''),
                STATE_MAX_AGE,
                headers=self.headers,
            )),
        ]
        redirect_response(self, GOOGLE_AUTH_URL + '?' + urllib.parse.urlencode(params), headers)
