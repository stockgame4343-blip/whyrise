"""종목별 1년치 인덱스 빌드 — 네이버 OHLC + 뉴스 + 추정 결합.

stock-rise 의 18일치도 머지 (운영 이후 사건은 stock-rise 의 정답 사용).

흐름:
  1. 네이버 시총 API 로 KOSPI+KOSDAQ 일반주식 ticker 리스트 (~2,000개)
  2. 각 ticker 에 대해 네이버 OHLC 1년치 한 번에 fetch
  3. 일별 등락률 계산 → 컷 +10% 이상만 events 추출
  4. stock-rise 의 그날 종목 데이터(rise_reason, news, theme_tag) 매칭
  5. 매칭 실패한 사건은 estimate_reasons 로 추정 (네이버 뉴스 + 패턴 + 메타)
  6. admin overrides 적용
  7. ticker 별 stock-history/{ticker}.json 저장 + index.json

사용:
  python scripts/build-history.py [--days 365] [--cutoff 10] [--limit-tickers 0]
  python scripts/build-history.py --incremental  # 오늘 1일치만 추가
  python scripts/build-history.py --estimate-only --limit 100  # 인덱스 있는 missing 만 추정
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from collector import naver_client  # noqa: E402
from collector.kr_holidays import is_kr_business_day  # noqa: E402
from scripts.estimate_reasons import estimate_reason  # noqa: E402

OUTPUT_DIR = _REPO / 'public' / 'data' / 'stock-history'
OVERRIDES_DIR = _REPO / 'public' / 'data' / 'overrides'
STOCK_RISE_RAW = 'https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data'

# ── OHLC 디스크 캐시 (백필 재시도 시 즉시 통과) ──────────────────────
# 워크플로우가 중간에 실패해도 캐시는 actions/cache 로 보존됨 → 재시작 빠름.
_OHLC_CACHE_DIR = _REPO / 'public' / 'data' / '_cache' / 'ohlc'
_OHLC_CACHE_TTL_S = 7 * 24 * 3600   # 7일 — 백필 재시도엔 충분, 과한 stale 방지
_ohlc_cache_stats = {'hit': 0, 'miss': 0}


def fetch_ohlc_cached(ticker: str, start: str, end: str) -> list[dict]:
    """ticker 별 OHLC fetch — 디스크 캐시 우선.

    캐시 키: ticker (start/end 는 백필 한 번 안에서 동일). 캐시된 범위가 요청 범위를
    포함하면 그대로 사용, 아니면 fresh fetch + 캐시 갱신.
    """
    _OHLC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _OHLC_CACHE_DIR / f'{ticker}.json'
    now = time.time()
    if p.exists():
        try:
            blob = json.loads(p.read_text(encoding='utf-8'))
            age = now - float(blob.get('fetched_at', 0))
            cs = str(blob.get('start') or '')
            ce = str(blob.get('end') or '')
            rows = blob.get('rows') or []
            # 캐시 범위가 요청 범위를 포함하고 TTL 안이면 hit
            if rows and age < _OHLC_CACHE_TTL_S and cs <= start and ce >= end:
                _ohlc_cache_stats['hit'] += 1
                return rows
        except Exception:
            pass
    _ohlc_cache_stats['miss'] += 1
    rows = naver_client.fetch_ohlc_daily(ticker, start, end)
    if rows:
        try:
            p.write_text(json.dumps({
                'ticker': ticker,
                'start': start, 'end': end,
                'fetched_at': now,
                'rows': rows,
            }, ensure_ascii=False), encoding='utf-8')
        except Exception:
            pass
    return rows

DEFAULT_CUTOFF = 10.0   # 인덱스에 저장할 최저 컷 (클라 토글 +10/15/20/29.9 호환)
DEFAULT_DAYS = 365


# ── 유틸 ───────────────────────────────────────────────

def _yyyymmdd(d: date) -> str:
    return d.strftime('%Y%m%d')


def _date_range_strs(start: date, end: date) -> list[str]:
    """start~end 사이 영업일 YYYYMMDD 배열."""
    out = []
    cur = start
    while cur <= end:
        if is_kr_business_day(cur):
            out.append(_yyyymmdd(cur))
        cur += timedelta(days=1)
    return out


# ── stock-rise 데이터 로드 ─────────────────────────────

def load_stockrise_dates() -> list[str]:
    return naver_client.fetch_json(f'{STOCK_RISE_RAW}/dates.json') or []


def load_stockrise_day(date_str: str) -> dict | None:
    return naver_client.fetch_json(f'{STOCK_RISE_RAW}/{date_str}.json')


def build_stockrise_lookup(dates: list[str]) -> dict[tuple[str, str], dict]:
    """(date, ticker) → stock-rise rankings 항목.

    dates 마다 1번 fetch.  운영 이후 사건의 rise_reason·news·theme_tag 정답 소스.
    """
    out: dict[tuple[str, str], dict] = {}
    for d in dates:
        data = load_stockrise_day(d)
        if not data:
            continue
        for r in data.get('rankings', []):
            t = r.get('ticker')
            if t:
                out[(d, t)] = r
    return out


# ── overrides ───────────────────────────────────────────

def load_overrides_for(date_str: str) -> dict[str, dict]:
    """public/data/overrides/{date}.json 로컬 파일 읽기."""
    p = OVERRIDES_DIR / f'{date_str}.json'
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return {}


# ── 메인 빌드 ───────────────────────────────────────────

def fetch_ticker_universe(stock_only: bool = True) -> list[dict]:
    """KOSPI + KOSDAQ 일반주식 universe."""
    print('  네이버 시총 API → 종목 리스트 ...')
    items = naver_client.list_all_tickers(stock_only=stock_only)
    print(f'    → {len(items)} 종목')
    return items


def calc_change_rate(prev_close: float, cur_close: float) -> float:
    if prev_close <= 0:
        return 0.0
    return round((cur_close - prev_close) / prev_close * 100, 2)


def is_52w_high(ohlc: list[dict], idx: int) -> bool:
    """ohlc[idx] 의 highPrice 가 직전 252일 내 최고치 경신했는지."""
    if idx < 1:
        return False
    cur = ohlc[idx].get('highPrice') or 0
    prior = ohlc[max(0, idx - 252):idx]
    if not prior:
        return False
    prior_max = max(p.get('highPrice', 0) or 0 for p in prior)
    return cur >= prior_max and cur > 0


def build_events_for_ticker(
    ticker: str,
    name: str,
    market: str,
    ohlc: list[dict],
    cutoff: float,
    stockrise_lookup: dict[tuple[str, str], dict],
    fetch_news_fn,
    meta: dict | None = None,
) -> list[dict]:
    """1년치 OHLC → 컷 이상 사건 events.

    fetch_news_fn(ticker, date_str) -> news_items_normalized (list of {title, link, source, date})
    """
    if len(ohlc) < 2:
        return []
    # OHLC 정렬 보장 (네이버는 오름차순으로 보내지만 안전)
    ohlc_sorted = sorted(ohlc, key=lambda r: r.get('localDate', ''))
    events: list[dict] = []
    for i in range(1, len(ohlc_sorted)):
        prev = ohlc_sorted[i - 1].get('closePrice') or 0
        cur = ohlc_sorted[i].get('closePrice') or 0
        if prev <= 0 or cur <= 0:
            continue
        rate = calc_change_rate(prev, cur)
        if rate < cutoff:
            continue
        d = ohlc_sorted[i].get('localDate', '')
        if not d:
            continue
        is_high = is_52w_high(ohlc_sorted, i)

        # 1) stock-rise 정답 우선
        sr = stockrise_lookup.get((d, ticker))
        if sr:
            events.append({
                'date': d,
                'change_rate': rate,
                'close_price': cur,
                'rise_reason': sr.get('rise_reason') or '',
                'reason_confidence': 'high',
                'reason_source': 'stockrise',
                'reason_status': 'filled' if sr.get('rise_reason') else 'missing',
                'theme_tag': sr.get('theme_tag') or '',
                'news': sr.get('news') or [],
                'sector': sr.get('sector') or (meta or {}).get('sector', ''),
                'is_52w_high': is_high,
                'source': 'stockrise',
            })
            continue

        # 2) 네이버 뉴스 + 추정
        news_items = fetch_news_fn(ticker, d)
        est = estimate_reason(
            news_items=news_items,
            change_rate=rate,
            is_52w_high=is_high,
            meta=meta,
        )
        events.append({
            'date': d,
            'change_rate': rate,
            'close_price': cur,
            'rise_reason': est['rise_reason'],
            'reason_confidence': est['reason_confidence'],
            'reason_source': est['reason_source'] or 'naver',
            'reason_status': est['reason_status'],
            'theme_tag': '',
            'news': [naver_client.normalize_news_item(n) for n in (news_items or [])[:5]],
            'sector': (meta or {}).get('sector', ''),
            'is_52w_high': is_high,
            'source': 'estimated',
        })
    # 최신 → 과거 정렬
    events.sort(key=lambda e: e['date'], reverse=True)
    return events


def apply_overrides(events: list[dict], ticker: str) -> list[dict]:
    """events 의 각 date 에 대해 overrides/{date}.json[ticker] 머지."""
    for ev in events:
        ov = load_overrides_for(ev['date']).get(ticker)
        if not ov:
            continue
        if ov.get('rise_reason'):
            ev['rise_reason'] = ov['rise_reason']
            ev['reason_confidence'] = 'high'
            ev['reason_source'] = 'admin'
            ev['reason_status'] = 'edited'
        if ov.get('theme_tag'):
            ev['theme_tag'] = ov['theme_tag']
    return events


def calc_stats(events: list[dict]) -> dict:
    if not events:
        return {'count_10': 0, 'count_15': 0, 'count_20': 0, 'count_limit': 0,
                'count_recent': 0, 'avg_rate': 0}
    today = date.today()
    cutoff_30d = (today - timedelta(days=30)).strftime('%Y%m%d')
    return {
        'count_10': sum(1 for e in events if e['change_rate'] >= 10),
        'count_15': sum(1 for e in events if e['change_rate'] >= 15),
        'count_20': sum(1 for e in events if e['change_rate'] >= 20),
        'count_limit': sum(1 for e in events if e['change_rate'] >= 29.9),
        'count_recent': sum(1 for e in events if e['date'] >= cutoff_30d),
        'avg_rate': round(sum(e['change_rate'] for e in events) / len(events), 2),
    }


def write_ticker_history(ticker: str, name: str, market: str,
                         events: list[dict], output_dir: Path) -> None:
    history = {
        'ticker': ticker,
        'name': name,
        'market': market,
        'events': events,
        'stats': calc_stats(events),
        'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f'{ticker}.json').write_text(
        json.dumps(history, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )


def write_index(name_by_ticker: dict[str, dict], output_dir: Path) -> None:
    """검색 자동완성용 index.json."""
    (output_dir / 'index.json').write_text(
        json.dumps(name_by_ticker, ensure_ascii=False),
        encoding='utf-8',
    )


def _parse_int(v):
    """문자열·숫자 어디서 와도 int 로 — 콤마 포함 문자열 대응."""
    if v is None:
        return None
    try:
        if isinstance(v, str):
            return int(v.replace(',', '').strip())
        return int(v)
    except (ValueError, TypeError):
        return None


# ── sitemap 생성 ─────────────────────────────────────────

def build_sitemap(stock_history_dir: Path, public_dir: Path,
                  site: str = 'https://whyrise.vercel.app') -> None:
    """sitemap.xml — 정적 + 종목별 페이지 (검색 인덱스의 ticker 들)."""
    today = date.today().strftime('%Y-%m-%d')
    static = [
        (f'{site}/', '1.0', 'daily'),
        (f'{site}/bubbles.html', '0.8', 'daily'),
        (f'{site}/treemap.html', '0.8', 'daily'),
        (f'{site}/bubbles2.html', '0.8', 'daily'),
        (f'{site}/report.html', '0.8', 'daily'),
    ]
    # 종목 페이지
    idx_path = stock_history_dir / 'index.json'
    tickers: list[str] = []
    if idx_path.exists():
        try:
            idx = json.loads(idx_path.read_text(encoding='utf-8'))
            tickers = sorted(idx.keys())
        except Exception:
            pass

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for url, prio, freq in static:
        parts.append(f'  <url><loc>{url}</loc><lastmod>{today}</lastmod>'
                     f'<changefreq>{freq}</changefreq><priority>{prio}</priority></url>')
    for t in tickers:
        parts.append(f'  <url><loc>{site}/stock/{t}</loc>'
                     f'<lastmod>{today}</lastmod>'
                     '<changefreq>weekly</changefreq><priority>0.6</priority></url>')
    parts.append('</urlset>')

    (public_dir / 'sitemap.xml').write_text('\n'.join(parts), encoding='utf-8')
    print(f'  sitemap.xml: {len(tickers) + len(static)} URL')


# ── 리포트 집계 ─────────────────────────────────────────

_PERIOD_DAYS = {
    'd1': 1,
    'w1': 7,
    'm1': 31,
    'm3': 92,
    'y1': 400,    # 1년치 전체
}


def build_report_summary(stock_history_dir: Path, output_path: Path) -> None:
    """모든 ticker 인덱스 → 기간별(1D/1W/1M/3M/1Y) 리포트 집계.

    잡주(시총 작음) 제거를 위해 marketmap.json (KOSPI+KOSDAQ 시총 TOP 200) 에
    포함된 ticker 만 종목 위젯에 노출. 섹터/이유는 전체 universe 그대로.

    각 기간 별로 위젯:
      sector_top    — 섹터별 +15% 누적 TOP 10
      limit_up_top  — 상한가 종목 TOP 20
      high_52w_top  — 52주 신고가 빈번 TOP 20
      frequent_top  — 그 기간 +15% 자주 친 종목 TOP 50
      reason_top    — 상승 이유 카테고리 분포 TOP 20
    """
    print('  build_report_summary (5 periods) ...')
    files = [f for f in sorted(stock_history_dir.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    print(f'    인덱스 파일 {len(files)} 개 집계')

    # marketmap.json — 시총 TOP 종목 ticker set (잡주 필터)
    marketmap_path = stock_history_dir.parent / 'marketmap.json'
    mkt_cap_lookup: dict[str, int] = {}
    if marketmap_path.exists():
        try:
            mm = json.loads(marketmap_path.read_text(encoding='utf-8'))
            for it in (mm.get('items') or []):
                t = it.get('ticker')
                c = it.get('market_cap')
                if t and c:
                    mkt_cap_lookup[t] = int(c)
            print(f'    시총 lookup: {len(mkt_cap_lookup)} 종목 (잡주 필터용)')
        except Exception as e:
            print(f'    marketmap.json 로드 실패: {e}')

    today = date.today()
    cutoff_yyyymmdd = {
        k: (today - timedelta(days=days)).strftime('%Y%m%d')
        for k, days in _PERIOD_DAYS.items()
    }

    # 기간별 누적 컨테이너
    def _empty_period():
        return {
            'sector_acc': {},          # sector → {count, sum_rate, tickers}
            'reason_acc': {},          # rise_reason → count
            'theme_acc': {},           # theme_tag → {count, sum_rate, tickers}
            'limit_up': [],
            'high_52w': [],
            'frequent': [],
            'total_events_15': 0,
            'total_events_all_universe': 0,    # 시총필터 무관, 전체 universe 의 +15% 사건
            'total_limit_count': 0,            # 상한가 사건 수
            'total_52w_count': 0,              # 신고가 사건 수
            'sum_rate_all': 0.0,               # 평균 상승률 계산용
        }
    periods = {k: _empty_period() for k in _PERIOD_DAYS}

    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        ticker = h.get('ticker') or ''
        name = h.get('name') or ticker
        events = h.get('events') or []

        # 각 기간 별 ticker-level count 집계 (events 한 번 순회)
        per_period_counts = {
            k: {'c15': 0, 'c_limit': 0, 'c_52w': 0,
                'sum_rate': 0.0, 'max_rate': 0.0}
            for k in _PERIOD_DAYS
        }

        for e in events:
            date_str = e.get('date', '')
            rate = e.get('change_rate') or 0
            # 단일일 +30% 한국 상한가 한도 → 35% 컷으로 액면분할·병합 등 비정상치 제외
            if rate < 15 or rate > 35:
                continue
            sec = (e.get('sector') or '').strip()
            theme = (e.get('theme_tag') or '').strip()
            reason_status = e.get('reason_status')
            reason = (e.get('rise_reason') or '').strip()
            is_high = bool(e.get('is_52w_high'))
            is_limit = rate >= 29.9

            for k, cutoff in cutoff_yyyymmdd.items():
                if date_str < cutoff:
                    continue
                pp = periods[k]
                per_period_counts[k]['c15'] += 1
                per_period_counts[k]['sum_rate'] += float(rate)
                if rate > per_period_counts[k]['max_rate']:
                    per_period_counts[k]['max_rate'] = float(rate)
                if is_limit:
                    per_period_counts[k]['c_limit'] += 1
                if is_high:
                    per_period_counts[k]['c_52w'] += 1
                # 헤더용 통계 (universe 전체 — 잡주 포함 = 전체 시장 활동)
                pp['total_events_all_universe'] += 1
                pp['sum_rate_all'] += float(rate)
                if is_limit:
                    pp['total_limit_count'] += 1
                if is_high:
                    pp['total_52w_count'] += 1
                # 섹터 집계
                if sec:
                    rec = pp['sector_acc'].setdefault(sec, {'count': 0, 'sum_rate': 0.0, 'tickers': set()})
                    rec['count'] += 1
                    rec['sum_rate'] += float(rate)
                    rec['tickers'].add(ticker)
                # 테마 태그 집계 (theme_tag — stock-rise 가 분류한 구체적 테마)
                if theme:
                    rec = pp['theme_acc'].setdefault(theme, {'count': 0, 'sum_rate': 0.0, 'tickers': set()})
                    rec['count'] += 1
                    rec['sum_rate'] += float(rate)
                    rec['tickers'].add(ticker)
                # 이유 카테고리 (자동 추정 라벨)
                if reason_status == 'filled' and reason and reason not in ('-', '상한가 — 사유 미수집'):
                    pp['reason_acc'][reason] = pp['reason_acc'].get(reason, 0) + 1

        # 종목별 리스트 (각 기간) — 잡주 제거: marketmap (시총 TOP 200) 포함 ticker 만
        # 마켓맵 없으면 (개발 환경) 전체 통과 (필터 생략)
        in_marketmap = (not mkt_cap_lookup) or (ticker in mkt_cap_lookup)
        market_cap = mkt_cap_lookup.get(ticker, 0)
        if not in_marketmap:
            continue
        for k, counts in per_period_counts.items():
            pp = periods[k]
            if counts['c15'] > 0:
                entry = {
                    'ticker': ticker,
                    'name': name,
                    'count': counts['c15'],
                    'sum_rate': round(counts['sum_rate'], 2),
                    'max_rate': round(counts['max_rate'], 2),
                    'market_cap': market_cap,
                }
                pp['frequent'].append(entry)
                pp['total_events_15'] += counts['c15']
            if counts['c_limit'] > 0:
                pp['limit_up'].append({
                    'ticker': ticker, 'name': name,
                    'count': counts['c_limit'],
                    'sum_rate': round(counts['sum_rate'], 2),
                    'max_rate': round(counts['max_rate'], 2),
                    'market_cap': market_cap,
                })
            if counts['c_52w'] > 0:
                pp['high_52w'].append({
                    'ticker': ticker, 'name': name,
                    'count': counts['c_52w'],
                    'sum_rate': round(counts['sum_rate'], 2),
                    'max_rate': round(counts['max_rate'], 2),
                    'market_cap': market_cap,
                })

    # 정렬·TOP N — 기간별 분리
    result_periods = {}
    for k, pp in periods.items():
        sector_top = sorted(
            ({'sector': s, 'count': r['count'],
              'avg_rate': round(r['sum_rate'] / max(1, r['count']), 2),
              'sum_rate': round(r['sum_rate'], 2),
              'tickers': len(r['tickers'])}
             for s, r in pp['sector_acc'].items()),
            key=lambda x: (-x['sum_rate'], -x['count']),
        )[:10]
        theme_top = sorted(
            ({'theme': t, 'count': r['count'],
              'avg_rate': round(r['sum_rate'] / max(1, r['count']), 2),
              'sum_rate': round(r['sum_rate'], 2),
              'tickers': len(r['tickers'])}
             for t, r in pp['theme_acc'].items()),
            key=lambda x: (-x['sum_rate'], -x['count']),
        )[:15]
        ticker_sort_key = lambda x: (-x['sum_rate'], -x['count'])
        pp['limit_up'].sort(key=ticker_sort_key)
        pp['high_52w'].sort(key=ticker_sort_key)
        pp['frequent'].sort(key=ticker_sort_key)
        reason_top = sorted(
            ({'reason': r, 'count': v} for r, v in pp['reason_acc'].items()),
            key=lambda x: -x['count'],
        )[:20]
        total_all = pp['total_events_all_universe']
        result_periods[k] = {
            'total_events_15': pp['total_events_15'],
            'total_events_all': total_all,
            'total_limit_count': pp['total_limit_count'],
            'total_52w_count': pp['total_52w_count'],
            'avg_rate_15': round(pp['sum_rate_all'] / total_all, 2) if total_all else 0,
            'sector_top': sector_top,
            'theme_top': theme_top,
            'limit_up_top': pp['limit_up'][:20],
            'high_52w_top': pp['high_52w'][:20],
            'frequent_top': pp['frequent'][:50],
            'reason_top': reason_top,
        }

    summary = {
        'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'total_tickers': len(files),
        'periods': result_periods,
        # 호환 (옛 프런트가 1년 키 그대로 참조 시) — y1 의 핵심 위젯 미러
        'total_events_15': result_periods.get('y1', {}).get('total_events_15', 0),
        'sector_top': result_periods.get('y1', {}).get('sector_top', []),
        'limit_up_top': result_periods.get('y1', {}).get('limit_up_top', []),
        'high_52w_top': result_periods.get('y1', {}).get('high_52w_top', []),
        'recent_30d_top': result_periods.get('m1', {}).get('frequent_top', [])[:20],
        'frequent_top': result_periods.get('y1', {}).get('frequent_top', []),
        'reason_top': result_periods.get('y1', {}).get('reason_top', []),
    }
    output_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                           encoding='utf-8')
    y1 = result_periods.get('y1', {})
    d1 = result_periods.get('d1', {})
    print(f"    -> {output_path.name}: 1Y 섹터 {len(y1.get('sector_top', []))} / "
          f"상한가 {len(y1.get('limit_up_top', []))} / "
          f"이유 {len(y1.get('reason_top', []))}  ·  1D 이벤트 {d1.get('total_events_15', 0)}")


# ── 진입점 ─────────────────────────────────────────────

def build_full(args) -> int:
    cutoff = args.cutoff
    days = args.days
    limit_tickers = args.limit_tickers
    output_dir = OUTPUT_DIR

    today = date.today()
    start = today - timedelta(days=days + 30)  # 52주 신고가 계산 위해 여유
    end = today

    print(f'== build-history full: days={days} cutoff={cutoff} ==')
    print(f'  기간: {_yyyymmdd(start)} ~ {_yyyymmdd(end)}')

    # 1. ticker universe
    universe = fetch_ticker_universe(stock_only=True)
    if limit_tickers:
        universe = universe[:limit_tickers]
        print(f'  --limit-tickers={limit_tickers} 적용')

    # 2. stock-rise dates → lookup (운영 이후 정답)
    sr_dates = load_stockrise_dates()
    print(f'  stock-rise dates: {len(sr_dates)} 거래일')
    sr_lookup = build_stockrise_lookup(sr_dates)
    print(f'  stock-rise lookup 항목: {len(sr_lookup)}')

    # 3. 뉴스 캐시 (같은 ticker 한 번만 fetch — 최신 40건 기준)
    news_cache_by_ticker: dict[str, list[dict]] = {}

    def fetch_news_fn(ticker: str, date_str: str) -> list[dict]:
        if ticker not in news_cache_by_ticker:
            try:
                news_cache_by_ticker[ticker] = naver_client.fetch_stock_news(ticker, page_size=40)
            except Exception as e:
                print(f'    news fetch fail {ticker}: {e}')
                news_cache_by_ticker[ticker] = []
        items = news_cache_by_ticker[ticker]
        if not items:
            return []
        target = int(date_str)
        out = []
        for it in items:
            dt = (it.get('datetime') or '')[:8]
            if dt.isdigit() and abs(int(dt) - target) <= 1:
                out.append(it)
        return out[:5]

    # 4. 종목별 OHLC + events
    index_meta: dict[str, dict] = {}
    total = len(universe)
    success = 0
    skipped = 0
    start_str = _yyyymmdd(start)
    end_str = _yyyymmdd(end)
    t_start = time.time()

    for i, item in enumerate(universe):
        ticker = item.get('itemCode') or ''
        name = item.get('stockName') or ticker
        market = 'KOSPI' if (item.get('sosok') == 'KOSPI' or item.get('stockExchangeType', {}).get('code') == 'KS') else 'KOSDAQ'
        if not ticker or len(ticker) != 6:
            skipped += 1
            continue
        if i % 50 == 0:
            elapsed = time.time() - t_start
            eta = (elapsed / max(1, i + 1)) * (total - i - 1)
            print(f'  [{i + 1}/{total}] {ticker} {name} (elapsed {elapsed:.0f}s, ETA {eta:.0f}s)')
        try:
            ohlc = naver_client.fetch_ohlc_daily(ticker, start_str, end_str)
        except Exception as e:
            print(f'    OHLC fail {ticker}: {e}')
            skipped += 1
            continue
        if not ohlc or len(ohlc) < 2:
            skipped += 1
            continue

        events = build_events_for_ticker(
            ticker=ticker, name=name, market=market,
            ohlc=ohlc, cutoff=cutoff,
            stockrise_lookup=sr_lookup,
            fetch_news_fn=fetch_news_fn,
            meta={'sector': item.get('industryName') or ''},
        )
        if not events:
            skipped += 1
            continue
        events = apply_overrides(events, ticker)
        write_ticker_history(ticker, name, market, events, output_dir)
        index_meta[ticker] = {
            'name': name,
            'count': len([e for e in events if e['change_rate'] >= 15]),
            'count_recent': sum(1 for e in events if e['date'] >=
                                _yyyymmdd(today - timedelta(days=30))),
        }
        success += 1

    write_index(index_meta, output_dir)
    build_report_summary(output_dir, output_dir.parent / 'report-summary.json')
    build_sitemap(output_dir, output_dir.parent.parent)
    build_marketmap(output_dir.parent.parent)
    elapsed = time.time() - t_start
    print(f'== 완료: {success}/{total} 종목, skip {skipped}, elapsed {elapsed:.0f}s ==')
    return 0


def build_estimate_only(args) -> int:
    """이미 빌드된 인덱스에서 reason_status: missing 만 재추정."""
    output_dir = OUTPUT_DIR
    if not output_dir.exists():
        print('인덱스 디렉토리 없음 — 먼저 풀빌드 실행')
        return 1
    limit = args.limit
    files = sorted(output_dir.glob('*.json'))
    files = [f for f in files if f.name != 'index.json']
    print(f'== estimate-only: {len(files)} ticker 파일 검사 (limit={limit}) ==')
    processed = 0
    updated = 0
    for f in files:
        if limit and processed >= limit:
            break
        try:
            history = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        ticker = history.get('ticker')
        if not ticker:
            continue
        missing_events = [e for e in history.get('events', [])
                          if e.get('reason_status') == 'missing']
        if not missing_events:
            continue
        # 한 ticker 의 모든 missing 한 번에 처리
        try:
            news_items = naver_client.fetch_stock_news(ticker, page_size=40)
        except Exception:
            news_items = []
        any_updated = False
        for ev in missing_events:
            target = int(ev['date'])
            related = [n for n in news_items
                       if (n.get('datetime') or '')[:8].isdigit() and
                       abs(int((n.get('datetime') or '00000000')[:8]) - target) <= 1]
            est = estimate_reason(
                news_items=related[:5],
                change_rate=ev['change_rate'],
                is_52w_high=ev.get('is_52w_high', False),
                meta={'sector': ev.get('sector', '')},
            )
            if est['reason_status'] == 'filled':
                ev.update({
                    'rise_reason': est['rise_reason'],
                    'reason_confidence': est['reason_confidence'],
                    'reason_source': est['reason_source'],
                    'reason_status': 'filled',
                    'news': [naver_client.normalize_news_item(n) for n in related[:5]],
                })
                any_updated = True
        if any_updated:
            history['built_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            f.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding='utf-8')
            updated += 1
        processed += 1
        if processed % 20 == 0:
            print(f'  processed {processed}, updated {updated}')
    print(f'== estimate 완료: {updated}/{processed} ticker 갱신 ==')
    build_report_summary(output_dir, output_dir.parent / 'report-summary.json')
    build_sitemap(output_dir, output_dir.parent.parent)
    return 0


# ── marketmap (시총 TOP 100 트리맵) ────────────────────

def _fetch_industry_name_map() -> dict[str, str]:
    """네이버 산업 그룹 목록 → industryCode(str) → industryName 매핑.

    /api/stocks/industry?pageSize=200 응답의 groups[] 에 no/name 쌍.
    기본 pageSize 20 이라 큰 값으로 명시.
    """
    out: dict[str, str] = {}
    try:
        data = naver_client.fetch_json(
            'https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100'
        )
        for g in (data or {}).get('groups', []):
            no = g.get('no')
            name = g.get('name')
            if no is not None and name:
                out[str(no)] = name
    except Exception:
        pass
    return out


def _fetch_stock_industry_code(ticker: str) -> str:
    """종목 integration API → industryCode (문자열). 실패 시 빈 문자열."""
    try:
        url = f'https://m.stock.naver.com/api/stock/{ticker}/integration'
        data = naver_client.fetch_json(url)
        code = (data or {}).get('industryCode')
        return str(code) if code is not None else ''
    except Exception:
        return ''


def _calc_period_rates_at(ohlc_sorted: list[dict], idx: int) -> dict[str, float]:
    """ohlc[idx] 시점 기준 1d/1w/1m/3m/1y 등락률."""
    if idx < 1 or idx >= len(ohlc_sorted):
        return {}
    cur = float(ohlc_sorted[idx].get('closePrice') or 0)
    if cur <= 0:
        return {}
    windows = {'1d': 1, '1w': 5, '1m': 21, '3m': 63, '1y': 252}
    out: dict[str, float] = {}
    for k, w in windows.items():
        pi = idx - w
        if pi >= 0:
            pp = float(ohlc_sorted[pi].get('closePrice') or 0)
            if pp > 0:
                out[k] = calc_change_rate(pp, cur)
    return out


def _calc_period_rates(ohlc_sorted: list[dict]) -> dict[str, float]:
    """마지막 영업일 기준 다중 기간 등락률."""
    return _calc_period_rates_at(ohlc_sorted, len(ohlc_sorted) - 1)


def build_marketmap(public_dir: Path | None = None, top_per_market: int = 100) -> dict | None:
    """marketmap.json + 최신 일별 스냅샷 빌드 (전종목 universe + union TOP).

    universe = KOSPI/KOSDAQ 전종목. 각 종목 OHLC 1년치 fetch (캐시 사용).
    마지막 영업일 기준 (시총/거래대금/양수 상승률) TOP n union 만 저장.
    """
    target_dir = (public_dir or _REPO / 'public') / 'data'
    target_dir.mkdir(parents=True, exist_ok=True)
    snap_dir = target_dir / 'marketmap'
    snap_dir.mkdir(parents=True, exist_ok=True)

    today = date.today()
    # 1Y 정확 산정 위해 영업일 252개 + 휴장일 마진 — 500일 윈도우
    start = today - timedelta(days=500)
    start_str = _yyyymmdd(start)
    end_str = _yyyymmdd(today)

    print(f'== marketmap: 전종목 universe (KOSPI+KOSDAQ) → union TOP {top_per_market} ==')
    universe = fetch_ticker_universe(stock_only=True)
    pool: list[tuple[dict, str]] = []
    for x in universe:
        ticker = x.get('itemCode') or ''
        if not ticker or len(ticker) != 6:
            continue
        mc = _parse_int(x.get('marketValue')) or 0
        if mc <= 0:
            continue
        is_kospi = (x.get('sosok') == 'KOSPI' or
                    x.get('stockExchangeType', {}).get('code') == 'KS')
        pool.append((x, 'KOSPI' if is_kospi else 'KOSDAQ'))
    print(f'  universe: {len(pool)} 종목')

    industry_name = _fetch_industry_name_map()
    print(f'  산업명 매핑: {len(industry_name)} 개')
    existing_sector: dict[str, str] = {}
    existing_path = target_dir / 'marketmap.json'
    if existing_path.exists():
        try:
            old = json.loads(existing_path.read_text(encoding='utf-8'))
            for old_it in (old.get('items') or []):
                t = old_it.get('ticker')
                s = old_it.get('sector')
                if t and s:
                    existing_sector[t] = s
        except Exception:
            pass

    items_data: list[dict] = []
    latest_date = ''
    skipped = 0
    t_start = time.time()
    total = len(pool)
    log_every = max(50, total // 20)
    for i, (it, market) in enumerate(pool):
        ticker = it.get('itemCode') or ''
        name = it.get('stockName') or ticker
        market_cap = _parse_int(it.get('marketValue')) or 0
        sector = it.get('industryName') or existing_sector.get(ticker) or ''
        try:
            ohlc = fetch_ohlc_cached(ticker, start_str, end_str)
        except Exception:
            skipped += 1
            continue
        ohlc_sorted = [r for r in (ohlc or []) if (r.get('closePrice') or 0) > 0]
        ohlc_sorted.sort(key=lambda r: r.get('localDate', ''))
        if len(ohlc_sorted) < 2:
            skipped += 1
            continue
        d = ohlc_sorted[-1].get('localDate', '')
        if d and d > latest_date:
            latest_date = d
        items_data.append({
            'ticker': ticker, 'name': name, 'market': market, 'sector': sector,
            'market_cap': market_cap, 'ohlc_sorted': ohlc_sorted,
            'today_close': float(ohlc_sorted[-1].get('closePrice') or 0),
        })
        if (i + 1) % log_every == 0 or i + 1 == total:
            el = time.time() - t_start
            eta = (el / max(1, i + 1)) * (total - i - 1)
            hit = _ohlc_cache_stats['hit']; miss = _ohlc_cache_stats['miss']
            print(f'  [{i + 1}/{total}] OHLC 진행 el={el:.0f}s ETA={eta:.0f}s cache={hit}/{hit + miss}')

    if not latest_date or not items_data:
        print(f'== marketmap 실패: 데이터 부족 (items={len(items_data)}) ==')
        return None

    # 최신 일자 스냅샷 (union) → 그 결과를 marketmap.json 으로 사본
    ok = _write_marketmap_snapshot(latest_date, items_data, snap_dir, top_n=top_per_market)
    if not ok:
        print('== marketmap 실패: 스냅샷 생성 실패 ==')
        return None
    snap_path = snap_dir / f'{latest_date}.json'
    out_path = target_dir / 'marketmap.json'
    out_path.write_text(snap_path.read_text(encoding='utf-8'), encoding='utf-8')
    output = json.loads(out_path.read_text(encoding='utf-8'))
    items = output.get('items') or []

    # 인덱스 갱신 (일별 파일은 _write_marketmap_snapshot 이 이미 저장)
    idx_path = snap_dir / 'index.json'
    dates: list[str] = []
    if idx_path.exists():
        try:
            dates = json.loads(idx_path.read_text(encoding='utf-8'))
            if not isinstance(dates, list):
                dates = []
        except Exception:
            dates = []
    if latest_date not in dates:
        dates.append(latest_date)
    dates = sorted(set(dates), reverse=True)
    idx_path.write_text(json.dumps(dates), encoding='utf-8')
    hit = _ohlc_cache_stats['hit']; miss = _ohlc_cache_stats['miss']
    print(f'  스냅샷: marketmap/{latest_date}.json (인덱스 {len(dates)}일)  OHLC cache={hit}/{hit + miss}')

    print(f'== marketmap 완료: union {len(items)} 종목 (skip {skipped}), 기준일 {latest_date} ==')
    return output


def build_marketmap_only(args) -> int:
    if getattr(args, 'backfill_days', 0) and args.backfill_days > 0:
        build_marketmap_backfill(backfill_days=args.backfill_days)
        return 0
    build_marketmap()
    return 0


def _write_marketmap_snapshot(
    target_date: str,
    items_data: list[dict],
    snap_dir: Path,
    top_n: int = 100,
) -> bool:
    """주어진 영업일의 marketmap snapshot 저장.

    items_data 각 원소: { ticker, name, market, sector, market_cap(=오늘 시총),
                          today_close, ohlc_sorted }

    스냅샷 universe = KOSPI/KOSDAQ 별 (시총 TOP n + 거래대금 TOP n + 양수 상승률 TOP n) union.
    그날 시총 ≈ 오늘 시총 × (그날 종가 / 오늘 종가).
    """
    candidates: list[dict] = []
    for td in items_data:
        ohlc = td['ohlc_sorted']
        idx = -1
        for j, r in enumerate(ohlc):
            d = r.get('localDate', '')
            if d and d <= target_date:
                idx = j
            else:
                break
        if idx < 1:
            continue
        cur = float(ohlc[idx].get('closePrice') or 0)
        prev = float(ohlc[idx - 1].get('closePrice') or 0)
        if cur <= 0 or prev <= 0:
            continue
        rates = _calc_period_rates_at(ohlc, idx)
        # 거래대금 = volume × close_price (OHLC 에 거래대금 필드 없음)
        tvol = int(ohlc[idx].get('accumulatedTradingVolume') or 0)
        tv = int(tvol * cur)
        # 그 시점 시총 근사 (오늘 시총 × 종가 비율)
        today_close = td.get('today_close') or cur
        ratio = (cur / today_close) if today_close > 0 else 1.0
        mc_at_t = max(1, int(td['market_cap'] * ratio))
        candidates.append({
            'ticker': td['ticker'],
            'name': td['name'],
            'market': td['market'],
            'sector': td['sector'],
            'market_cap': mc_at_t,
            'close_price': cur,
            'change_rate': rates.get('1d', calc_change_rate(prev, cur)),
            'rates': rates,
            'trading_value': tv,
            'trading_volume': tvol,
        })
    if not candidates:
        return False
    # 시장별 (시총/거래량/양수 상승률) TOP n union — 어떤 정렬에서도 진짜 TOP 100 보장
    selected: dict[str, dict] = {}
    for market in ('KOSPI', 'KOSDAQ'):
        ms = [c for c in candidates if c['market'] == market]
        if not ms:
            continue
        for it in sorted(ms, key=lambda x: x['market_cap'], reverse=True)[:top_n]:
            selected[it['ticker']] = it
        for it in sorted(ms, key=lambda x: x['trading_value'], reverse=True)[:top_n]:
            selected[it['ticker']] = it
        rise = [c for c in ms if (c.get('change_rate') or 0) > 0]
        for it in sorted(rise, key=lambda x: x['change_rate'], reverse=True)[:top_n]:
            selected[it['ticker']] = it
    items = list(selected.values())
    items.sort(key=lambda x: x['market_cap'], reverse=True)
    output = {
        'date': target_date,
        'updated_at': datetime.now().isoformat(timespec='seconds'),
        'universe': 'union',   # (시총·거래량·양수 상승률) TOP n union
        'items': items,
    }
    snap_path = snap_dir / f'{target_date}.json'
    snap_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    return True


def build_marketmap_backfill(public_dir: Path | None = None,
                              top_per_market: int = 100,
                              backfill_days: int = 14) -> list[str]:
    """과거 N 영업일치 marketmap 일별 스냅샷 일괄 빌드.

    universe = KOSPI/KOSDAQ 전종목. 종목별 OHLC 1년치 한 번 fetch 로 일자별
    (시총/거래대금/상승률) TOP 100 union 스냅샷 산출 → 어떤 정렬에서도 진짜 TOP.
    """
    target_dir = (public_dir or _REPO / 'public') / 'data'
    target_dir.mkdir(parents=True, exist_ok=True)
    snap_dir = target_dir / 'marketmap'
    snap_dir.mkdir(parents=True, exist_ok=True)

    today = date.today()
    start = today - timedelta(days=500)
    start_str = _yyyymmdd(start)
    end_str = _yyyymmdd(today)

    print(f'== marketmap backfill: 과거 {backfill_days} 영업일 (전종목 universe) ==')
    universe = fetch_ticker_universe(stock_only=True)
    # 전종목 분류 + 시총 0 제외
    pool: list[tuple[dict, str]] = []
    for x in universe:
        ticker = x.get('itemCode') or ''
        if not ticker or len(ticker) != 6:
            continue
        mc = _parse_int(x.get('marketValue')) or 0
        if mc <= 0:
            continue
        is_kospi = (x.get('sosok') == 'KOSPI' or
                    x.get('stockExchangeType', {}).get('code') == 'KS')
        pool.append((x, 'KOSPI' if is_kospi else 'KOSDAQ'))
    print(f'  universe: {len(pool)} 종목 (KOSPI+KOSDAQ 전체)')

    industry_name = _fetch_industry_name_map()
    print(f'  산업명 매핑: {len(industry_name)} 개')
    existing_sector: dict[str, str] = {}
    existing_path = target_dir / 'marketmap.json'
    if existing_path.exists():
        try:
            old = json.loads(existing_path.read_text(encoding='utf-8'))
            for it in (old.get('items') or []):
                if it.get('ticker') and it.get('sector'):
                    existing_sector[it['ticker']] = it['sector']
        except Exception:
            pass

    items_data: list[dict] = []
    skipped = 0
    t_start = time.time()
    total = len(pool)
    log_every = max(50, total // 20)
    for i, (it, market) in enumerate(pool):
        ticker = it.get('itemCode') or ''
        name = it.get('stockName') or ticker
        market_cap = _parse_int(it.get('marketValue')) or 0
        # sector: (1) universe industryName → (2) 기존 캐시. integration API 호출은 비용 큼 → backfill 에선 생략
        sector = it.get('industryName') or existing_sector.get(ticker) or ''
        try:
            ohlc = fetch_ohlc_cached(ticker, start_str, end_str)
        except Exception:
            skipped += 1
            continue
        ohlc_sorted = [r for r in (ohlc or []) if (r.get('closePrice') or 0) > 0]
        ohlc_sorted.sort(key=lambda r: r.get('localDate', ''))
        if len(ohlc_sorted) < 2:
            skipped += 1
            continue
        items_data.append({
            'ticker': ticker, 'name': name, 'market': market, 'sector': sector,
            'market_cap': market_cap, 'ohlc_sorted': ohlc_sorted,
            'today_close': float(ohlc_sorted[-1].get('closePrice') or 0),
        })
        if (i + 1) % log_every == 0 or i + 1 == total:
            el = time.time() - t_start
            eta = (el / max(1, i + 1)) * (total - i - 1)
            hit = _ohlc_cache_stats['hit']; miss = _ohlc_cache_stats['miss']
            print(f'  [{i + 1}/{total}] OHLC 진행 el={el:.0f}s ETA={eta:.0f}s cache={hit}/{hit + miss}')

    print(f'  OHLC 수집: {len(items_data)} 종목 (skip {skipped})')

    # 영업일 합집합 — 마지막 N
    all_dates = sorted({r.get('localDate') for td in items_data for r in td['ohlc_sorted']
                        if r.get('localDate')})
    target_dates = all_dates[-backfill_days:] if len(all_dates) > backfill_days else all_dates

    saved: list[str] = []
    skipped_existing = 0
    for td_str in target_dates:
        if not (len(td_str) == 8 and td_str.isdigit()):
            continue
        # union 으로 이미 빌드된 스냅샷은 skip (재시도 가속)
        snap_path = snap_dir / f'{td_str}.json'
        if snap_path.exists():
            try:
                old = json.loads(snap_path.read_text(encoding='utf-8'))
                if (old.get('universe') == 'union'
                        and old.get('items') and 'trading_value' in old['items'][0]):
                    saved.append(td_str)
                    skipped_existing += 1
                    continue
            except Exception:
                pass
        if _write_marketmap_snapshot(td_str, items_data, snap_dir, top_n=top_per_market):
            saved.append(td_str)
    if skipped_existing:
        print(f'  skip (이미 union 빌드됨): {skipped_existing} 일')
    print(f'  OHLC 캐시: hit {_ohlc_cache_stats["hit"]} / miss {_ohlc_cache_stats["miss"]}')

    # index.json 갱신
    idx_path = snap_dir / 'index.json'
    dates_existing: list[str] = []
    if idx_path.exists():
        try:
            d_ = json.loads(idx_path.read_text(encoding='utf-8'))
            if isinstance(d_, list):
                dates_existing = d_
        except Exception:
            pass
    dates_list = sorted(set(dates_existing) | set(saved), reverse=True)
    idx_path.write_text(json.dumps(dates_list), encoding='utf-8')

    # 최신 marketmap.json = 가장 최근 일자 스냅샷
    if saved:
        latest = max(saved)
        latest_snap = snap_dir / f'{latest}.json'
        if latest_snap.exists():
            (target_dir / 'marketmap.json').write_text(
                latest_snap.read_text(encoding='utf-8'), encoding='utf-8'
            )

    print(f'== 백필 완료: {len(saved)} 영업일 저장, 인덱스 {len(dates_list)} 일 ==')
    return saved


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--days', type=int, default=DEFAULT_DAYS)
    p.add_argument('--cutoff', type=float, default=DEFAULT_CUTOFF)
    p.add_argument('--limit-tickers', type=int, default=0,
                   help='상위 N 종목만 빌드 (0=전체)')
    p.add_argument('--estimate-only', action='store_true',
                   help='인덱스 missing 만 재추정')
    p.add_argument('--marketmap-only', action='store_true',
                   help='시총 TOP 100 + 등락률 → marketmap.json 만 빠르게 빌드 (~30s)')
    p.add_argument('--backfill-days', type=int, default=0,
                   help='--marketmap-only 와 함께: 과거 N 영업일치 일별 스냅샷 일괄 빌드')
    p.add_argument('--report-only', action='store_true',
                   help='기존 stock-history/*.json 만 읽어서 report-summary.json 재집계 (~30s)')
    p.add_argument('--limit', type=int, default=0,
                   help='estimate-only 시 처리 개수 한도')
    args = p.parse_args()

    if args.marketmap_only:
        sys.exit(build_marketmap_only(args))
    if args.estimate_only:
        sys.exit(build_estimate_only(args))
    if args.report_only:
        build_report_summary(OUTPUT_DIR, OUTPUT_DIR.parent / 'report-summary.json')
        sys.exit(0)
    sys.exit(build_full(args))


if __name__ == '__main__':
    main()
