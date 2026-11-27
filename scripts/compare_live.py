"""자체 수집(public/data/live) ↔ stock-rise 수집 대조 — 전환 전 병행 기간용 (stock-rise 독립 2단계, 2026-11-27)

    python scripts/compare_live.py [YYYYMMDD ...]     # 인자 없으면 live/dates.json 의 최근 5일

날짜마다: 종목 수, 종목 겹침, 상위 20 겹침, 사유 일치율, 업종·테마 채움, 제네릭 사유 수, 확정 여부.
전환 기준(plan.md): 종목 겹침 ≥ 95%, 업종 채움 ≥ stock-rise.
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIVE = ROOT / 'public' / 'data' / 'live'
UPSTREAM = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data/'
TIMEOUT_S = 20
RETRIES = 3
TOP_N = 20
DEFAULT_DAYS = 5
GENERIC = {'개별 종목 상승', '시장 관심 증가', '거래량 증가', '거래량 급증', '거래대금 증가', '상한가 — 사유 미수집', '이유 분석 대기중', ''}


def fetch_upstream(date):
    last = None
    for _ in range(RETRIES):
        try:
            with urllib.request.urlopen(UPSTREAM + date + '.json', timeout=TIMEOUT_S) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:  # 네트워크
            last = e
    raise RuntimeError(f'{date} 상류 읽기 실패: {last}')


def stats(day):
    rk = (day or {}).get('rankings') or []
    return {
        'n': len(rk),
        'tickers': [r.get('ticker') for r in rk],
        'reason': {r.get('ticker'): (r.get('rise_reason') or '').strip() for r in rk},
        'sector': sum(1 for r in rk if (r.get('sector') or '').strip()),
        'theme': sum(1 for r in rk if (r.get('theme_tag') or '').strip()),
        'generic': sum(1 for r in rk if (r.get('rise_reason') or '').strip() in GENERIC),
        'final': bool((day or {}).get('is_final')),
    }


def compare(date):
    live_path = LIVE / f'{date}.json'
    live = json.loads(live_path.read_text(encoding='utf-8')) if live_path.exists() else None
    up = fetch_upstream(date)
    a, b = stats(live), stats(up)
    common = set(a['tickers']) & set(b['tickers'])
    union = set(a['tickers']) | set(b['tickers'])
    top = len(set(a['tickers'][:TOP_N]) & set(b['tickers'][:TOP_N]))
    same_reason = sum(1 for t in common if a['reason'].get(t) == b['reason'].get(t))
    return {
        'date': date, 'live_n': a['n'], 'sr_n': b['n'],
        'overlap_pct': round(len(common) * 100 / len(union), 1) if union else 0.0,
        f'top{TOP_N}_overlap': top,
        'same_reason_pct': round(same_reason * 100 / len(common), 1) if common else 0.0,
        'sector_live/sr': f"{a['sector']}/{b['sector']}", 'theme_live/sr': f"{a['theme']}/{b['theme']}",
        'generic_live/sr': f"{a['generic']}/{b['generic']}", 'final_live/sr': f"{a['final']}/{b['final']}",
    }


def main(argv):
    dates = [d for d in argv if len(d) == 8 and d.isdigit()]
    if not dates:
        try:
            dates = sorted(json.loads((LIVE / 'dates.json').read_text(encoding='utf-8')), reverse=True)[:DEFAULT_DAYS]
        except Exception:
            print('live/dates.json 없음 — 날짜를 인자로 주세요')
            return 1
    rows = [compare(d) for d in sorted(dates)]
    keys = list(rows[0].keys())
    print('| ' + ' | '.join(keys) + ' |')
    print('|' + '---|' * len(keys))
    for r in rows:
        print('| ' + ' | '.join(str(r[k]) for k in keys) + ' |')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
