"""IndexNow 핑 — 바뀐 페이지를 네이버·Bing(및 IndexNow 참여 검색엔진)에 즉시 알린다.

네이버 서치어드바이저는 2023-07부터 IndexNow 를 지원한다. 사이트맵만으로는 수집까지
며칠~몇 주가 걸리지만, 핑을 보내면 검색로봇이 해당 URL 을 우선 방문한다.

입력: 변경 파일 목록(줄바꿈 구분, 기본 stdin) — 워크플로가 커밋 직전 `git diff --staged --name-only` 로 넘긴다.
  public/stock/005930.html → https://orgo.kr/stock/005930
  public/day/20260930.html → https://orgo.kr/day/20260930
홈·날짜 아카이브는 무언가 바뀌면 함께 보낸다.

    git diff --staged --name-only | python scripts/indexnow_ping.py
    python scripts/indexnow_ping.py --urls https://orgo.kr/day/20260930
    python scripts/indexnow_ping.py --dry-run < changed.txt

키 파일: public/{KEY}.txt (내용 = KEY). 프로토콜상 공개 값이라 비밀이 아니다.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

SITE = 'https://orgo.kr'
HOST = 'orgo.kr'
KEY = 'c5c5c3341dd949e51f3510e23099bd55'
KEY_LOCATION = f'{SITE}/{KEY}.txt'
# api.indexnow.org 는 참여 엔진 전체로 공유한다. 네이버는 자체 엔드포인트도 함께 보낸다.
ENDPOINTS = ('https://api.indexnow.org/indexnow', 'https://searchadvisor.naver.com/indexnow')
MAX_URLS = 10000


def urls_from_paths(paths: list[str]) -> list[str]:
    out: list[str] = []
    for p in paths:
        p = p.strip()
        m = re.fullmatch(r'public/stock/([0-9A-Z]{6})\.html', p)
        if m:
            out.append(f'{SITE}/stock/{m.group(1)}')
            continue
        m = re.fullmatch(r'public/day/(\d{8})\.html', p)
        if m:
            out.append(f'{SITE}/day/{m.group(1)}')
            continue
        if p == 'public/day/index.html':
            out.append(f'{SITE}/day/')
    if out:
        out[:0] = [f'{SITE}/', f'{SITE}/day/']
    return list(dict.fromkeys(out))[:MAX_URLS]


def key_is_live(timeout: int = 10) -> bool:
    try:
        with urllib.request.urlopen(KEY_LOCATION, timeout=timeout) as r:
            return r.status == 200 and r.read().decode('utf-8').strip() == KEY
    except Exception:
        return False


def ping(urls: list[str], endpoint: str, timeout: int = 20) -> int:
    body = json.dumps({'host': HOST, 'key': KEY, 'keyLocation': KEY_LOCATION, 'urlList': urls}).encode('utf-8')
    req = urllib.request.Request(endpoint, data=body, method='POST',
                                 headers={'Content-Type': 'application/json; charset=utf-8'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--urls', nargs='*', default=None)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--wait-live', type=int, default=0,
                    help='키 파일이 배포될 때까지 최대 N초 대기(커밋 직후 Vercel 배포 지연 대비)')
    args = ap.parse_args()
    urls = args.urls if args.urls is not None else urls_from_paths(sys.stdin.read().splitlines())
    if not urls:
        print('indexnow: 보낼 URL 없음')
        return 0
    print(f'indexnow: {len(urls)} URL (예: {urls[:3]})')
    if args.dry_run:
        return 0
    deadline = time.time() + max(0, args.wait_live)
    while not key_is_live():
        if time.time() >= deadline:
            print('::warning::indexnow 키 파일이 아직 배포되지 않음 — 핑 생략(다음 실행에서 재시도)')
            return 0
        time.sleep(15)
    ok = False
    for ep in ENDPOINTS:
        status = ping(urls, ep)
        # 200/202 = 접수. 422 등은 URL·키 불일치 — 실패로 남기되 빌드는 막지 않는다.
        print(f'indexnow: {ep} → HTTP {status}')
        ok = ok or status in (200, 202)
    if not ok:
        print('::warning::indexnow 접수 실패 — 다음 빌드에서 재시도')
    return 0


if __name__ == '__main__':
    sys.exit(main())
