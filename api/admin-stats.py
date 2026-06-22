"""관리자 전용 방문 통계 대시보드 데이터 — Upstash/Vercel KV.

GET (wr_admin 쿠키 필요) →
  {
    ok, online, unique, signups,
    days: [{day, visitors, new, pageviews, avg_dwell, sessions}],   # 최근 7일(오늘 먼저)
    referrers: [{host, count}]                                       # 최근 7일 합산 TOP
  }
admin-login.py 와 동일한 wr_admin HMAC 쿠키로 보호.
"""
import hashlib
import hmac
import json
import os
import time
import urllib.request
from collections import Counter
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler


KV_URL = os.environ.get('KV_REST_API_URL', '').rstrip('/')
KV_TOKEN = os.environ.get('KV_REST_API_TOKEN', '')
ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
SESSION_SECRET = os.environ.get('SESSION_SECRET', ADMIN_TOKEN)
COOKIE_NAME = 'wr_admin'


def _sign():
    if not SESSION_SECRET or not ADMIN_TOKEN:
        return ''
    return hmac.new(SESSION_SECRET.encode('utf-8'), ADMIN_TOKEN.encode('utf-8'),
                    hashlib.sha256).hexdigest()


def _is_admin(headers):
    raw = headers.get('Cookie', '') or ''
    if not raw:
        return False
    cookie = SimpleCookie()
    cookie.load(raw)
    val = cookie.get(COOKIE_NAME)
    expected = _sign()
    return bool(val and expected and hmac.compare_digest(val.value, expected))


def _kv_pipeline(commands):
    if not KV_URL or not KV_TOKEN:
        return None
    req = urllib.request.Request(
        f'{KV_URL}/pipeline',
        data=json.dumps(commands).encode('utf-8'),
        method='POST',
        headers={'Authorization': f'Bearer {KV_TOKEN}', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


def _r(results, i):
    try:
        return results[i].get('result')
    except Exception:
        return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not _is_admin(self.headers):
            self._respond(401, {'ok': False, 'error': '관리자 인증 필요'})
            return
        if not KV_URL or not KV_TOKEN:
            self._respond(200, {'ok': False, 'reason': 'kv_not_connected'})
            return

        now = int(time.time())
        days = [time.strftime('%Y%m%d', time.gmtime(now + 9 * 3600 - i * 86400))
                for i in range(7)]

        cmds = [
            ['ZCOUNT', 'wr:online', str(now - 300), '+inf'],
            ['SCARD', 'wr:unique'],
            ['GET', 'wr:signups'],
        ]
        base = len(cmds)
        for d in days:                       # 일별 5개씩
            cmds += [
                ['SCARD', f'wr:visitors:{d}'],
                ['GET', f'wr:new:{d}'],
                ['GET', f'wr:pv:{d}'],
                ['ZRANGE', f'wr:dur:{d}', '0', '-1', 'WITHSCORES'],
                ['ZRANGE', f'wr:ref:{d}', '0', '-1', 'WITHSCORES'],
            ]
        res = _kv_pipeline(cmds)
        if res is None:
            self._respond(200, {'ok': False, 'reason': 'kv_error'})
            return

        def to_int(v):
            try:
                return int(v)
            except (TypeError, ValueError):
                return 0

        online = to_int(_r(res, 0))
        unique = to_int(_r(res, 1))
        signups = to_int(_r(res, 2))

        day_rows = []
        ref_total = Counter()
        for k, d in enumerate(days):
            off = base + k * 5
            visitors = to_int(_r(res, off))
            new = to_int(_r(res, off + 1))
            pv = to_int(_r(res, off + 2))
            dur_flat = _r(res, off + 3) or []
            ref_flat = _r(res, off + 4) or []
            # WITHSCORES → [member, score, member, score, ...]
            scores = []
            for j in range(1, len(dur_flat), 2):
                try:
                    scores.append(float(dur_flat[j]))
                except (TypeError, ValueError):
                    pass
            avg_dwell = round(sum(scores) / len(scores)) if scores else 0
            for j in range(0, len(ref_flat) - 1, 2):
                try:
                    ref_total[str(ref_flat[j])] += int(float(ref_flat[j + 1]))
                except (TypeError, ValueError):
                    pass
            day_rows.append({
                'day': d, 'visitors': visitors, 'new': new,
                'pageviews': pv, 'avg_dwell': avg_dwell, 'sessions': len(scores),
            })

        referrers = [{'host': h, 'count': c} for h, c in ref_total.most_common(12)]
        self._respond(200, {
            'ok': True, 'online': online, 'unique': unique, 'signups': signups,
            'days': day_rows, 'referrers': referrers,
        })

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
