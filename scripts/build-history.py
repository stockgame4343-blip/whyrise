"""종목별 급등 인덱스 빌드.

stock-rise 의 dates.json + 각 일자 JSON 을 순회하여:
  - public/data/stock-history/{ticker}.json — 그 종목의 모든 +15% 이상 events
  - public/data/stock-history/index.json    — 검색 자동완성용 ticker→{name, count, ...}

whyrise repo 의 overrides 도 머지(있으면 우선).

사용:
  python scripts/build-history.py [--days 365] [--cutoff 15]
  python scripts/build-history.py --output-dir public/data/stock-history --days 365
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from collections import defaultdict


STOCK_RISE_RAW = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data'
DEFAULT_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                  'public', 'data', 'stock-history')
OVERRIDES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             'public', 'data', 'overrides')
USER_AGENT = 'whyrise-build-history/1.0'


def fetch_json(url, retries=3):
    last_exc = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last_exc = e
        except Exception as e:
            last_exc = e
        time.sleep(1 + i)
    if last_exc:
        raise last_exc
    return None


def load_local_overrides(date):
    path = os.path.join(OVERRIDES_DIR, f'{date}.json')
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def build(days, cutoff, output_dir):
    print(f'== build-history: days={days} cutoff={cutoff} output={output_dir} ==')
    os.makedirs(output_dir, exist_ok=True)

    dates = fetch_json(f'{STOCK_RISE_RAW}/dates.json') or []
    if not dates:
        print('dates.json 없음 — 중단')
        return 1
    target_dates = dates[:days]
    print(f'대상 거래일: {len(target_dates)} 개 (가장 최근: {target_dates[0]})')

    # ticker → events list
    events_by_ticker = defaultdict(list)
    name_by_ticker = {}
    market_by_ticker = {}

    for i, date in enumerate(target_dates):
        if i % 20 == 0:
            print(f'  {i}/{len(target_dates)}: {date}')
        data = fetch_json(f'{STOCK_RISE_RAW}/{date}.json')
        if not data or not data.get('rankings'):
            continue
        overrides = load_local_overrides(date)
        for r in data['rankings']:
            rate = r.get('change_rate')
            if rate is None or rate < cutoff:
                continue
            ticker = r.get('ticker')
            if not ticker:
                continue
            ov = overrides.get(ticker, {})
            event = {
                'date': date,
                'change_rate': float(rate),
                'close_price': r.get('close_price'),
                'rise_reason': ov.get('rise_reason') or r.get('rise_reason') or '',
                'theme_tag': ov.get('theme_tag') or r.get('theme_tag') or '',
                'sector': r.get('sector') or '',
                'news': (r.get('news') or [])[:5],
            }
            if ov:
                event['_edited'] = True
                if ov.get('note'):
                    event['note'] = ov['note']
            events_by_ticker[ticker].append(event)
            name_by_ticker[ticker] = r.get('name', ticker)
            market_by_ticker[ticker] = r.get('market', '')

    # 종목별 파일 + 통계 계산
    index = {}
    cutoff_30d_set = set(target_dates[:22])  # 최근 30일 ≈ 거래일 22

    for ticker, events in events_by_ticker.items():
        events.sort(key=lambda e: e['date'], reverse=True)
        count_15 = sum(1 for e in events if e['change_rate'] >= 15)
        count_20 = sum(1 for e in events if e['change_rate'] >= 20)
        count_limit = sum(1 for e in events if e['change_rate'] >= 29.9)
        count_recent = sum(1 for e in events if e['date'] in cutoff_30d_set)
        avg_rate = sum(e['change_rate'] for e in events) / len(events) if events else 0
        history = {
            'ticker': ticker,
            'name': name_by_ticker.get(ticker, ticker),
            'market': market_by_ticker.get(ticker, ''),
            'events': events,
            'stats': {
                'count_15': count_15,
                'count_20': count_20,
                'count_limit': count_limit,
                'count_recent': count_recent,
                'avg_rate': round(avg_rate, 2),
            },
            'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        out_path = os.path.join(output_dir, f'{ticker}.json')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
        index[ticker] = {
            'name': name_by_ticker.get(ticker, ticker),
            'count': count_15,
            'count_recent': count_recent,
        }

    # index.json (검색 자동완성용)
    index_path = os.path.join(output_dir, 'index.json')
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False)

    print(f'== 완료: {len(events_by_ticker)} 종목, index.json {len(index)} 항목 ==')
    return 0


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--days', type=int, default=365, help='몇 일치 거래일을 볼지 (기본 365)')
    p.add_argument('--cutoff', type=float, default=15.0, help='상승률 컷오프 (기본 15)')
    p.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR)
    args = p.parse_args()
    sys.exit(build(args.days, args.cutoff, args.output_dir))


if __name__ == '__main__':
    main()
