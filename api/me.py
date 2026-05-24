import json
import os
import sys
from http.server import BaseHTTPRequestHandler


sys.path.append(os.path.dirname(__file__))
from _auth import get_session_user, login_configured  # noqa: E402


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        user = get_session_user(self.headers)
        body = {
            'ok': True,
            'login_enabled': login_configured(),
            'authed': bool(user),
            'user': None,
        }
        if user:
            body['user'] = {
                'id': user.get('sub') or '',
                'email': user.get('email') or '',
                'name': user.get('name') or user.get('email') or '',
                'picture': user.get('picture') or '',
            }
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
