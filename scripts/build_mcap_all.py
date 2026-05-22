"""모든 종목 시총 lookup 파일 빌더 — screening 미집계 보강용.

네이버 m.stock.naver.com/api/stocks/marketValue/{market} 를 시총 정렬로
totalCount 까지 페이지네이션해서 KOSPI·KOSDAQ 의 모든 일반 종목 수집.
산출 파일은 트리맵·버블맵용 marketmap.json 과 별개 — 시총 lookup 만 담는
가벼운 파일 (압축 후 ~30KB).

산출:
  public/data/mcap-all.json
  {
    "built_at": "2026-05-22T...Z",
    "count": 2700,
    "items": { "005930": 17100365, "000660": 1850000, ... }   # 억원
  }

수동 실행:
  python scripts/build_mcap_all.py

GitHub Actions 자동 실행 시 일 1회 cron 권장.
"""
from __future__ import annotations

import io
import json
import sys
import time

# Windows cp949 콘솔에서도 한글·em-dash 출력 가능하도록 utf-8 강제
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
except Exception:
    pass
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path


UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
URL = 'https://m.stock.naver.com/api/stocks/marketValue/{mkt}?page={page}&pageSize=100'
PAGE_TIMEOUT = 8
PAGE_DELAY_SEC = 0.3   # 네이버 rate-limit 안전 마진
MAX_PAGES = 30         # safety — totalCount 신뢰하되 한도


def _parse_int(v) -> int:
    if v is None:
        return 0
    try:
        if isinstance(v, str):
            return int(v.replace(',', '').strip())
        return int(v)
    except (ValueError, TypeError):
        return 0


def _fetch_page(mkt: str, page: int) -> dict | None:
    url = URL.format(mkt=mkt, page=page)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=PAGE_TIMEOUT) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        print(f'  ! {mkt} page {page} ERR: {e}', file=sys.stderr)
        return None


def collect_market(mkt: str) -> dict[str, int]:
    """{ticker: 시총(억원)} 반환. ETF/ETN 등 제외 (stockEndType=='stock' 만)."""
    items: dict[str, int] = {}
    page = 1
    total = None
    while page <= MAX_PAGES:
        data = _fetch_page(mkt, page)
        if not data:
            break
        if total is None:
            total = data.get('totalCount') or 0
        stocks = data.get('stocks') or []
        if not stocks:
            break
        added = 0
        for s in stocks:
            if s.get('stockEndType') != 'stock':
                continue
            ticker = s.get('itemCode') or ''
            if not ticker or len(ticker) != 6:
                continue
            # marketValueRaw 가 원 단위 정확값. marketValue 는 백만원 단위 콤마 문자열.
            mc_won = _parse_int(s.get('marketValueRaw')) or (
                _parse_int(s.get('marketValue')) * 1_000_000
            )
            if mc_won <= 0:
                continue
            # marketmap.json·screening.json 과 단위 통일 → 억원
            mc_eok = mc_won // 100_000_000
            if mc_eok <= 0:
                mc_eok = 1   # 1억 미만은 1억으로 표시
            items[ticker] = mc_eok
            added += 1
        print(f'  {mkt} page {page}: +{added} (누적 {len(items)} / total {total})')
        if added == 0:
            break
        if total and len(items) >= total:
            break
        page += 1
        time.sleep(PAGE_DELAY_SEC)
    return items


def main() -> int:
    print('Building mcap-all.json — 모든 종목 시총 lookup')
    all_items: dict[str, int] = {}
    for mkt in ('KOSPI', 'KOSDAQ'):
        print(f'\n[{mkt}]')
        ms = collect_market(mkt)
        all_items.update(ms)

    out = {
        'built_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'count': len(all_items),
        'items': all_items,
    }
    target = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'mcap-all.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    # 사이즈 최소화 — separators 압축
    target.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    size_kb = target.stat().st_size / 1024
    print(f'\n총 {len(all_items)} 종목 → {target}  ({size_kb:.1f} KB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
