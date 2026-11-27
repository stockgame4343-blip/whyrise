"""Vercel serverless — 외부 cron(cron-job.org, 5분 간격)이 부르면 KST 스케줄에 맞춰 whyrise Actions 를 깨운다.

stock-rise api/cron-trigger.py 를 whyrise 로 옮긴 것 (stock-rise 의존 단계적 독립 2단계, 2026-11-27).
  - live-collect      : 자체 수집(.github/workflows/live-collect.yml) — 장중 15분 + 마감 2회
  - marketmap-intraday: 장중 marketmap 빠른 갱신(build-history.yml) — 예전엔 stock-rise 쪽 트리거가 대신 걸어 줬다
GitHub cron 은 몇 시간씩 밀려서 정시 시계는 외부 cron 에 둔다. 주말·한국 휴장일은 건너뛴다.

호출: GET /api/collect-trigger?secret=<COLLECT_TRIGGER_SECRET>[&force=collect-intra|collect-close|marketmap]
환경변수:
  GITHUB_TOKEN           — repository_dispatch 권한 PAT (threads-cron·admin-override 와 같은 것)
  COLLECT_TRIGGER_SECRET — 무단 호출 방지(필수, 없으면 모든 호출 403)
"""
import hmac
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

# Vercel 번들엔 collector/ 가 없다(.vercelignore) — 휴장일은 공용 단일 소스(collector/kr_holidays.json)를 raw 로 읽는다.
# 못 읽으면 평일로 보고 깨운다(fail-open): 수집·빌드 워크플로가 각자 휴장일 게이트를 한 번 더 건다.
HOLIDAYS_URL = 'https://raw.githubusercontent.com/stockgame4343-blip/whyrise/master/collector/kr_holidays.json'
HOLIDAYS_TIMEOUT_SEC = 2

KST = timezone(timedelta(hours=9))
REPO = os.environ.get('GITHUB_REPO', 'stockgame4343-blip/whyrise')
TRIGGER_WINDOW_MIN = 3        # 외부 cron 호출 지연 흡수
DISPATCH_TIMEOUT_SEC = 3      # 휴장일 조회 2초 + dispatch 최대 2회 → Vercel 함수 10초 한도 안

_INTRADAY_SLOTS = [(h, m) for h in range(9, 16) for m in (6, 21, 36, 51) if (h, m) <= (15, 21)]
_CLOSING_SLOTS = [(15, 36), (16, 6)]
# (KST 시, 분) → [(event_type, payload)]
SCHEDULE = {}
for _hm in _INTRADAY_SLOTS:
    SCHEDULE.setdefault(_hm, []).extend([('live-collect', {'mode': 'intraday'}), ('marketmap-intraday', {})])
for _hm in _CLOSING_SLOTS:
    SCHEDULE.setdefault(_hm, []).extend([('live-collect', {'mode': 'closing'}), ('marketmap-intraday', {})])
FORCE_MAP = {
    'collect-intra': ('live-collect', {'mode': 'intraday'}),
    'collect-close': ('live-collect', {'mode': 'closing'}),
    'marketmap': ('marketmap-intraday', {}),
}


def is_kr_holiday(day):
    try:
        req = urllib.request.Request(HOLIDAYS_URL, headers={'User-Agent': 'orgo-collect-trigger'})
        with urllib.request.urlopen(req, timeout=HOLIDAYS_TIMEOUT_SEC) as resp:
            return day.strftime('%Y%m%d') in (json.loads(resp.read().decode('utf-8')).get('holidays') or {})
    except Exception:
        return False


def _due(now_kst):
    """지금 시각(±3분)에 걸리는 이벤트 목록 — 가까운 슬롯 하나만."""
    cur = now_kst.hour * 60 + now_kst.minute
    for (h, m), events in sorted(SCHEDULE.items()):
        if abs(cur - (h * 60 + m)) <= TRIGGER_WINDOW_MIN:
            return events
    return []


def _authorized(params):
    expected = os.environ.get('COLLECT_TRIGGER_SECRET', '')
    got = (params.get('secret') or [''])[0]
    return bool(expected) and hmac.compare_digest(got.encode('utf-8'), expected.encode('utf-8'))


def _dispatch(event_type, payload):
    token = os.environ.get('GITHUB_TOKEN', '')
    if not token:
        return False, 'GITHUB_TOKEN 미설정'
    body = json.dumps({'event_type': event_type, 'client_payload': {**payload, 'source': 'collect-trigger'}}).encode('utf-8')
    req = urllib.request.Request(f'https://api.github.com/repos/{REPO}/dispatches', data=body, method='POST', headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'orgo-collect-trigger',
    })
    try:
        with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT_SEC) as resp:
            return True, f'dispatched ({resp.status})'
    except urllib.error.HTTPError as e:
        return False, f'HTTP {e.code}: {e.read().decode("utf-8", "replace")[:200]}'
    except Exception as e:  # 네트워크·타임아웃
        return False, str(e)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        if not _authorized(params):
            self._respond(403, {'error': 'forbidden'})
            return
        now = datetime.now(KST)
        stamp = now.strftime('%Y-%m-%d %H:%M KST')
        if now.weekday() >= 5 or is_kr_holiday(now.date()):
            self._respond(200, {'status': 'skip', 'reason': 'weekend' if now.weekday() >= 5 else 'kr_holiday', 'time': stamp})
            return
        force = (params.get('force') or [''])[0]
        if force:
            if force not in FORCE_MAP:
                self._respond(400, {'error': 'unknown force', 'allowed': list(FORCE_MAP)})
                return
            events = [FORCE_MAP[force]]
        else:
            events = _due(now)
        if not events:
            self._respond(200, {'status': 'skip', 'reason': 'not scheduled', 'time': stamp})
            return
        results = []
        for event_type, payload in events:
            ok, detail = _dispatch(event_type, payload)
            results.append({'event': event_type, 'payload': payload, 'ok': ok, 'detail': detail})
        ok_all = all(r['ok'] for r in results)
        self._respond(200 if ok_all else 502, {'status': 'triggered' if ok_all else 'error', 'events': results, 'time': stamp})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False).encode('utf-8'))
