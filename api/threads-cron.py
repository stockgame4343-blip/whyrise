"""Vercel Cron — 평일 16:30 KST 에 marketing-daily.yml 을 깨운다 (repository_dispatch 'threads-publish').

GitHub 자체 schedule 크론은 수 시간씩 밀려서(10/2 16:37 크론이 23:06 실행) 정시 트리거를 Vercel 크론에 둔다.
여기서는 깨우기만 한다 — 거래일·마감 확정·중복 게시 판정은 워크플로 게이트와 scripts/threads_publish.js 가 한다.
그래서 여러 번 불려도 게시는 하루 1번이다.

환경변수:
  GITHUB_TOKEN — admin-override.py 와 같은 PAT (repository_dispatch 권한)
  CRON_SECRET  — 선택. 설정하면 Vercel 이 'Authorization: Bearer <값>' 으로 보내고 그것만 받는다.
                 없으면 Vercel 크론 User-Agent + 평일 16~18시 KST 호출만 받는다.
"""
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

REPO = os.environ.get('GITHUB_REPO', 'stockgame4343-blip/whyrise')
EVENT_TYPE = 'threads-publish'
KST = timezone(timedelta(hours=9))
CRON_USER_AGENT = 'vercel-cron/'
OPEN_HOURS_KST = (16, 19)        # CRON_SECRET 없을 때만 적용 — 크론 시각 주변으로 무단 호출 범위를 줄인다
DISPATCH_TIMEOUT_SEC = 4
DISPATCH_ATTEMPTS = 2            # 4초 × 2 — Vercel 함수 10초 한도 안
RETRY_WAIT_SEC = 1


def _authorized(headers, now_kst):
    secret = os.environ.get('CRON_SECRET', '')
    if secret:
        got = headers.get('Authorization', '') or ''
        return hmac.compare_digest(got.encode('utf-8'), f'Bearer {secret}'.encode('utf-8'))
    ua = headers.get('User-Agent', '') or ''
    return (ua.startswith(CRON_USER_AGENT) and now_kst.weekday() < 5
            and OPEN_HOURS_KST[0] <= now_kst.hour < OPEN_HOURS_KST[1])


def _dispatch():
    token = os.environ.get('GITHUB_TOKEN', '')
    if not token:
        return False, 'GITHUB_TOKEN 미설정'
    body = json.dumps({'event_type': EVENT_TYPE, 'client_payload': {'source': 'vercel-cron'}}).encode('utf-8')
    last = ''
    for attempt in range(DISPATCH_ATTEMPTS):
        if attempt:
            time.sleep(RETRY_WAIT_SEC)
        req = urllib.request.Request(f'https://api.github.com/repos/{REPO}/dispatches', data=body, method='POST', headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'whyrise-threads-cron',
        })
        try:
            with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT_SEC) as resp:
                return True, f'dispatched ({resp.status})'
        except urllib.error.HTTPError as e:
            last = f'HTTP {e.code}: {e.read().decode("utf-8", "replace")[:200]}'
            if e.code < 500:
                break
        except Exception as e:
            last = str(e)
    return False, last


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        now = datetime.now(KST)
        if not _authorized(self.headers, now):
            self._respond(403, {'error': 'forbidden'})
            return
        ok, detail = _dispatch()
        self._respond(200 if ok else 502, {
            'status': 'dispatched' if ok else 'error',
            'event': EVENT_TYPE,
            'time': now.strftime('%Y-%m-%d %H:%M KST'),
            'detail': detail,
        })

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
