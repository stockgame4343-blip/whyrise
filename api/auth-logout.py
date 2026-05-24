import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler


sys.path.append(os.path.dirname(__file__))
from _auth import (  # noqa: E402
    NEXT_COOKIE,
    SESSION_COOKIE,
    STATE_COOKIE,
    clear_cookie_header,
    redirect_response,
    safe_next,
)


class handler(BaseHTTPRequestHandler):

    def _clear_headers(self):
        return [
            ('Set-Cookie', clear_cookie_header(SESSION_COOKIE, headers=self.headers)),
            ('Set-Cookie', clear_cookie_header(STATE_COOKIE, headers=self.headers)),
            ('Set-Cookie', clear_cookie_header(NEXT_COOKIE, headers=self.headers)),
        ]

    def do_GET(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        next_url = safe_next((qs.get('next') or ['/'])[0])
        redirect_response(self, next_url, self._clear_headers())

    def do_POST(self):
        self._respond()

    def do_DELETE(self):
        self._respond()

    def _respond(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        for key, value in self._clear_headers():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True}).encode('utf-8'))
