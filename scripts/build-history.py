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
# stock-history 빌드 신선도 마커 — 워크플로우의 stale 판정(intraday → incremental 승격)에 사용.
# stock-history 디렉토리 밖에 두는 이유: build_report_summary 가 그 안의 *.json 을 종목 파일로 순회함.
BUILD_META_PATH = _REPO / 'public' / 'data' / 'build-meta.json'

# ── OHLC 디스크 캐시 (백필 재시도 시 즉시 통과) ──────────────────────
# 워크플로우가 중간에 실패해도 캐시는 actions/cache 로 보존됨 → 재시작 빠름.
_OHLC_CACHE_DIR = _REPO / 'public' / 'data' / '_cache' / 'ohlc'
_OHLC_CACHE_TTL_S = 7 * 24 * 3600       # 백필 기본 7일
_OHLC_CACHE_TTL_INTRADAY_S = 20 * 60    # 장중 빌드 — 20분 (오늘 row 자주 갱신)
_ohlc_cache_stats = {'hit': 0, 'miss': 0}


def fetch_ohlc_cached(ticker: str, start: str, end: str, ttl_s: int | None = None) -> list[dict]:
    """ticker 별 OHLC fetch — 디스크 캐시 우선.

    ttl_s: None 이면 _OHLC_CACHE_TTL_S 사용 (백필 7일). 장중 매시 빌드는 짧게 전달.
    """
    _OHLC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _OHLC_CACHE_DIR / f'{ticker}.json'
    now = time.time()
    ttl = ttl_s if ttl_s is not None else _OHLC_CACHE_TTL_S
    if p.exists():
        try:
            blob = json.loads(p.read_text(encoding='utf-8'))
            age = now - float(blob.get('fetched_at', 0))
            cs = str(blob.get('start') or '')
            ce = str(blob.get('end') or '')
            rows = blob.get('rows') or []
            if rows and age < ttl and cs <= start and ce >= end:
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

# 최근 이벤트 뉴스 풀 보강 — 오늘/최근 급등은 사이트의 핵심이라, stock-rise 뉴스가 얇아도
# 네이버 종목 뉴스(당일 타깃)로 풀을 채워 상세페이지 카드가 더 자주 '이유 기사'를 갖게 한다.
RECENT_SUPPLEMENT_DAYS = 14   # 이벤트가 앵커(오늘)로부터 N일 이내면 보강 대상
RECENT_NEWS_SPAN = 4          # 보강 뉴스 허용 날짜 범위(±일) — 상세페이지 카드 게이트와 동일
RECENT_NEWS_MAX = 12          # 보강 후 이벤트당 뉴스 풀 상한


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


def write_build_meta(sr_dates: list[str]) -> None:
    """stock-history 빌드(full/incremental) 완료 마커.

    워크플로우 Determine mode 단계가 latest_stockrise_date 를 업스트림 dates.json 과
    비교해 stale 이면 marketmap-intraday 런을 incremental 로 승격한다.
    """
    try:
        BUILD_META_PATH.write_text(json.dumps({
            'built_at': datetime.now().isoformat(timespec='seconds'),
            'latest_stockrise_date': max(sr_dates) if sr_dates else '',
        }, ensure_ascii=False), encoding='utf-8')
        print(f'  build-meta 기록: latest_stockrise_date={max(sr_dates) if sr_dates else "n/a"}')
    except Exception as e:
        print(f'  build-meta 기록 실패 (무시): {e}')


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


def _recent_mover_tickers(sr_lookup: dict[tuple[str, str], dict],
                          window_start: str, cutoff: float) -> set[str]:
    """incremental 축소 유니버스 — 윈도우 내 컷 이상 움직인 종목 집합.

    incremental 은 최근 days+30 윈도우만 재빌드하므로, 그 안에서 컷 이상 급등한 적 없는
    종목은 새로 기록할 이벤트가 없다 → 전종목 OHLC fetch(30분 가드 초과 원인) 대신 이 집합만 처리.

    커버리지 두 소스 union:
      A) stock-rise 일별 랭킹(윈도우) 등장 종목 — 일 top 급등주 정답 소스
      B) 자체 marketmap 일별 스냅샷(윈도우) 중 상승률 >= cutoff — 상승률 top-300/시장, 깊은 커버
    드문 엣지(그날 커버리지 밖 애매한 중소 급등)는 주간 full 리빌드(전종목)가 재수집해 복구한다.
    """
    wanted: set[str] = set()
    # A) stock-rise 윈도우 랭킹
    for (_d, t) in sr_lookup.keys():
        if t and _d >= window_start:
            wanted.add(t)
    # B) marketmap 일별 스냅샷 (로컬 파일 — 네트워크 없음)
    snap_dir = OUTPUT_DIR.parent / 'marketmap'
    if snap_dir.exists():
        for p in snap_dir.glob('*.json'):
            ds = p.stem
            if not (len(ds) == 8 and ds.isdigit() and ds >= window_start):
                continue  # index.json 등 비-일자 파일 skip
            try:
                snap = json.loads(p.read_text(encoding='utf-8'))
            except Exception:
                continue
            for it in snap.get('items', []):
                t = it.get('ticker')
                if t and (it.get('change_rate') or 0) >= cutoff:
                    wanted.add(t)
    return wanted


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


def _days_from_anchor(date_str: str, anchor_str: str) -> int | None:
    """event date(YYYYMMDD) 와 anchor(YYYYMMDD) 사이 일수(절대값). 파싱 실패 시 None."""
    try:
        a = date(int(anchor_str[0:4]), int(anchor_str[4:6]), int(anchor_str[6:8]))
        e = date(int(date_str[0:4]), int(date_str[4:6]), int(date_str[6:8]))
        return abs((a - e).days)
    except Exception:
        return None


def _merge_news(primary: list[dict], extra: list[dict], cap: int = RECENT_NEWS_MAX) -> list[dict]:
    """primary(우선) 뒤에 extra 를 붙이되 link/title 중복 제거, cap 개로 제한."""
    out: list[dict] = []
    seen: set[str] = set()
    for n in list(primary) + list(extra):
        if not isinstance(n, dict):
            continue
        title = (n.get('title') or '').strip()
        link = (n.get('link') or '').split('#')[0].strip()
        key = link.lower() or title.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(n)
        if len(out) >= cap:
            break
    return out


def build_events_for_ticker(
    ticker: str,
    name: str,
    market: str,
    ohlc: list[dict],
    cutoff: float,
    stockrise_lookup: dict[tuple[str, str], dict],
    fetch_news_fn,
    meta: dict | None = None,
    supplement_news_fn=None,
    anchor_str: str = '',
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
        vol = ohlc_sorted[i].get('accumulatedTradingVolume') or 0
        tval = int(vol * cur)   # 거래대금 근사 (원)
        is_high = is_52w_high(ohlc_sorted, i)
        # 최근(앵커±N일) 이벤트는 당일 타깃 뉴스로 풀 보강 — 오늘치 카드 커버리지↑
        _gap = _days_from_anchor(d, anchor_str) if anchor_str else None
        recent = bool(supplement_news_fn and _gap is not None and _gap <= RECENT_SUPPLEMENT_DAYS)

        # 1) stock-rise 정답 우선
        sr = stockrise_lookup.get((d, ticker))
        if sr:
            sr_news = sr.get('news') or []
            if recent:
                sr_news = _merge_news(sr_news, supplement_news_fn(ticker, d))
            events.append({
                'date': d,
                'change_rate': rate,
                'close_price': cur,
                'trading_volume': int(vol),
                'trading_value': tval,
                'rise_reason': sr.get('rise_reason') or '',
                'reason_confidence': 'high',
                'reason_source': 'stockrise',
                'reason_status': 'filled' if sr.get('rise_reason') else 'missing',
                'theme_tag': sr.get('theme_tag') or '',
                'news': sr_news,
                'sector': sr.get('sector') or (meta or {}).get('sector', ''),
                'is_52w_high': is_high,
                'source': 'stockrise',
            })
            continue

        # 2) 네이버 뉴스 + 추정 (estimate_reason 입력은 ±1 그대로 — 사유 추정 회귀 방지)
        news_items = fetch_news_fn(ticker, d)
        est = estimate_reason(
            news_items=news_items,
            change_rate=rate,
            is_52w_high=is_high,
            meta=meta,
        )
        est_news = [naver_client.normalize_news_item(n) for n in (news_items or [])[:5]]
        if recent:
            est_news = _merge_news(est_news, supplement_news_fn(ticker, d))
        events.append({
            'date': d,
            'change_rate': rate,
            'close_price': cur,
            'trading_volume': int(vol),
            'trading_value': tval,
            'rise_reason': est['rise_reason'],
            'reason_confidence': est['reason_confidence'],
            'reason_source': est['reason_source'] or 'naver',
            'reason_status': est['reason_status'],
            'theme_tag': (meta or {}).get('theme_tag', ''),
            'news': est_news,
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
    cutoff_1y = (today - timedelta(days=365)).strftime('%Y%m%d')
    # 횟수 통계는 '최근 1년' 윈도우만 — 1년 이전(백필) 이벤트는 영구 보관하되 카운트엔 미포함.
    recent = [e for e in events if (e.get('date') or '') >= cutoff_1y]
    base = recent or events
    return {
        'count_10': sum(1 for e in recent if e['change_rate'] >= 10),
        'count_15': sum(1 for e in recent if e['change_rate'] >= 15),
        'count_20': sum(1 for e in recent if e['change_rate'] >= 20),
        'count_limit': sum(1 for e in recent if e['change_rate'] >= 29.9),
        'count_recent': sum(1 for e in events if e['date'] >= cutoff_30d),
        'avg_rate': round(sum(e['change_rate'] for e in base) / len(base), 2),
    }


def recompute_all_stats(stock_history_dir: Path) -> int:
    """전 종목 파일의 stats=calc_stats(events) 재계산(순수 로컬). 변경된 파일 수 반환.

    calc_stats 1년 윈도우 변경 등을 빌드 없이 즉시 반영할 때 사용(--report-only).
    """
    files = [f for f in sorted(stock_history_dir.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    changed = 0
    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        new_stats = calc_stats(h.get('events') or [])
        if h.get('stats') != new_stats:
            h['stats'] = new_stats
            f.write_text(json.dumps(h, ensure_ascii=False, indent=2), encoding='utf-8')
            changed += 1
    print(f'  recompute_all_stats: {changed} 종목 stats 갱신')
    return changed


def load_existing_events(ticker: str, output_dir: Path) -> list[dict]:
    """기존 {ticker}.json 의 events (없거나 깨졌으면 빈 리스트)."""
    p = output_dir / f'{ticker}.json'
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding='utf-8')).get('events', []) or []
    except Exception:
        return []


def merge_ticker_events(old: list[dict], new: list[dict], window_start: str) -> list[dict]:
    """무한 누적 병합.

    window_start(YYYYMMDD) 이후(>=)는 이번 빌드가 권위 — stock-rise 갱신·override·
    컷 미달 삭제를 그대로 반영하려고 new 만 사용.
    그 이전(<) 과거 이벤트는 이번 빌드 윈도우 밖이므로 기존 파일에서 보존
    → 증분(--days 30)이 백필한 과거를 지우지 않음.
    """
    kept_old = [e for e in old if (e.get('date') or '') < window_start]
    return sorted(new + kept_old, key=lambda e: e.get('date', ''), reverse=True)


def write_ticker_history(ticker: str, name: str, market: str,
                         events: list[dict], output_dir: Path) -> None:
    history = {
        'ticker': ticker,
        'name': name,
        'market': market,
        'events': events,
        'stats': calc_stats(events),
        # KST timezone-naive ISO — runner 의 TZ=Asia/Seoul 가정 (yml env 에서 설정)
        'built_at': datetime.now().isoformat(timespec='seconds'),
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
                  site: str = 'https://orgo.kr') -> None:
    """sitemap.xml — 정적 + 종목별 페이지 (검색 인덱스의 ticker 들)."""
    today = date.today().strftime('%Y-%m-%d')
    static = [
        (f'{site}/', '1.0', 'daily'),
        (f'{site}/report.html', '0.8', 'daily'),
        (f'{site}/treemap.html', '0.8', 'daily'),
        (f'{site}/bubbles2.html', '0.8', 'daily'),
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

# rise_reason 텍스트 → 카테고리 매핑 (가장 먼저 매치되는 카테고리 우선)
# 어디에도 안 맞으면 '기타'. 키워드는 사용자 피드백·실 데이터 분포 보고 보강.
_REASON_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ('실적·공시',   ('실적', '매출', '영업이익', '잠정', '공시', '연간')),
    ('계약·수주',   ('수주', '계약', '공급', '납품', 'MOU', '체결')),
    ('지배구조',    ('자사주', '소각', '합병', '인수', '분할', '자회사')),
    ('신고가·돌파', ('신고가', '52주', '돌파', '최고')),
    ('정책·정부',   ('정부', '예산', '승인', '허가', '법안', '지원')),
    ('테마·이슈',   ('테마', '강세', '이슈', '모멘텀', '관련주')),
)
_REASON_OTHER = '기타'


def _categorize_reason(reason: str) -> str:
    if not reason:
        return _REASON_OTHER
    for cat, kws in _REASON_CATEGORIES:
        for kw in kws:
            if kw in reason:
                return cat
    return _REASON_OTHER


def build_report_summary(stock_history_dir: Path, output_path: Path) -> None:
    """모든 ticker 인덱스 → 기간별(1D/1W/1M/3M/1Y) 리포트 집계.

    전체 universe 포함 (시총 필터 없음 — 다양한 상승 종목 노출이 사이트 컨셉).
    marketmap.json 은 시총 정보 보조 용도만.

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

    # marketmap.json — 시총 정보 보조 (필터 X, 표시용)
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
            print(f'    시총 lookup: {len(mkt_cap_lookup)} 종목 (표시용)')
        except Exception as e:
            print(f'    marketmap.json 로드 실패: {e}')

    # 'd1' 정의 — "오늘" 이 아니라 "가장 최근 거래일" 기준.
    # 주말·휴장·데이터 지연 시 today 로 잡으면 빈 결과가 되므로,
    # events 가 실제 존재하는 최신 날짜를 앵커로 사용. (사용자 피드백 2026-05-16)
    latest_event_date = ''
    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        for e in (h.get('events') or []):
            d_ = e.get('date', '')
            if d_ and d_ > latest_event_date:
                latest_event_date = d_
    anchor = today = date.today()
    if latest_event_date and len(latest_event_date) == 8:
        try:
            anchor = date(int(latest_event_date[0:4]), int(latest_event_date[4:6]), int(latest_event_date[6:8]))
        except Exception:
            anchor = today
    print(f"    기간 anchor: latest_event={latest_event_date or 'n/a'} → {anchor.isoformat()} (today={today.isoformat()})")
    cutoff_yyyymmdd = {
        # d1 만 anchor 일자 그대로(=마지막 거래일만 포함), 나머지는 anchor-기간
        k: (anchor if k == 'd1' else anchor - timedelta(days=days - 1)).strftime('%Y%m%d')
        for k, days in _PERIOD_DAYS.items()
    }
    # 이전 기간 윈도우 — "현 기간 vs 직전 같은 길이" 비교용. d1 은 직전 1일.
    # 현재: [anchor-(days-1), anchor]  /  이전: [anchor-(2*days-1), anchor-days]
    prev_window = {
        k: {
            'start': (anchor - timedelta(days=(2 * days) - 1)).strftime('%Y%m%d'),
            'end':   (anchor - timedelta(days=days)).strftime('%Y%m%d'),
        } for k, days in _PERIOD_DAYS.items()
    }

    # 기간별 누적 컨테이너
    def _empty_period():
        return {
            'sector_acc': {},          # sector → {count, sum_rate, tickers}
            'reason_acc': {},          # rise_reason → count
            'theme_acc': {},           # theme_tag → {count, sum_rate, tickers}
            'reason_cat_acc': {},      # category → count (현재 윈도우)
            # 이전 윈도우 누적 — 카테고리·종목 단위는 빼고 group(섹터/테마/총량)만
            'prev_sector_acc': {},     # sector → {count, sum_rate}
            'prev_theme_acc': {},      # theme_tag → {count, sum_rate}
            'prev_total_events_15': 0,
            'prev_total_limit_count': 0,
            'prev_total_52w_count': 0,
            'prev_sum_rate_all': 0.0,
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
                pp = periods[k]
                # ── 현재 윈도우 (기존 로직) ──
                if date_str >= cutoff:
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
                    # generic 추정 fallback('시장 관심 증가', '{섹터} 강세')은 top-reason 랭킹에서 제외 —
                    # 의미 있는 촉매만 집계(섹터 강세는 sector_acc 에서 별도 집계). 이벤트 카드엔 그대로 표시됨.
                    _generic_reason = (reason in ('-', '상한가 — 사유 미수집', '시장 관심 증가')
                                       or reason == f'{sec} 강세')
                    if reason_status == 'filled' and reason and not _generic_reason:
                        pp['reason_acc'][reason] = pp['reason_acc'].get(reason, 0) + 1
                        # NEW — 같은 이유 텍스트를 5+1 카테고리로 그룹화
                        cat = _categorize_reason(reason)
                        pp['reason_cat_acc'][cat] = pp['reason_cat_acc'].get(cat, 0) + 1
                # ── 이전 윈도우 누적 (현재 기간 vs 이전 기간 비교용) ──
                pw = prev_window[k]
                if pw['start'] <= date_str <= pw['end']:
                    pp['prev_total_events_15'] += 1
                    pp['prev_sum_rate_all'] += float(rate)
                    if is_limit:
                        pp['prev_total_limit_count'] += 1
                    if is_high:
                        pp['prev_total_52w_count'] += 1
                    if sec:
                        rec = pp['prev_sector_acc'].setdefault(sec, {'count': 0, 'sum_rate': 0.0})
                        rec['count'] += 1
                        rec['sum_rate'] += float(rate)
                    if theme:
                        rec = pp['prev_theme_acc'].setdefault(theme, {'count': 0, 'sum_rate': 0.0})
                        rec['count'] += 1
                        rec['sum_rate'] += float(rate)

        # 종목별 리스트 — 전체 universe 포함 (시총 필터 없음).
        # 시총 정보는 marketmap (TOP 200) 에 있는 것만 표시, 그 외는 0.
        market_cap = mkt_cap_lookup.get(ticker, 0)
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
        prev_sec = pp['prev_sector_acc']
        prev_thm = pp['prev_theme_acc']

        sector_top = []
        for s, r in pp['sector_acc'].items():
            ps = prev_sec.get(s) or {'count': 0, 'sum_rate': 0.0}
            sector_top.append({
                'sector': s, 'count': r['count'],
                'avg_rate': round(r['sum_rate'] / max(1, r['count']), 2),
                'sum_rate': round(r['sum_rate'], 2),
                'tickers': len(r['tickers']),
                'prev_count': ps['count'],
                'prev_sum_rate': round(ps['sum_rate'], 2),
            })
        sector_top.sort(key=lambda x: (-x['sum_rate'], -x['count']))
        sector_top = sector_top[:10]

        theme_top = []
        for t, r in pp['theme_acc'].items():
            pt = prev_thm.get(t) or {'count': 0, 'sum_rate': 0.0}
            theme_top.append({
                'theme': t, 'count': r['count'],
                'avg_rate': round(r['sum_rate'] / max(1, r['count']), 2),
                'sum_rate': round(r['sum_rate'], 2),
                'tickers': len(r['tickers']),
                'prev_count': pt['count'],
                'prev_sum_rate': round(pt['sum_rate'], 2),
            })
        theme_top.sort(key=lambda x: (-x['sum_rate'], -x['count']))
        theme_top = theme_top[:15]

        ticker_sort_key = lambda x: (-x['sum_rate'], -x['count'])
        pp['limit_up'].sort(key=ticker_sort_key)
        pp['high_52w'].sort(key=ticker_sort_key)
        pp['frequent'].sort(key=ticker_sort_key)
        reason_top = sorted(
            ({'reason': r, 'count': v} for r, v in pp['reason_acc'].items()),
            key=lambda x: -x['count'],
        )[:20]

        # reason_categories — 정의된 6 카테고리 + '기타' 고정 순서로 출력 (count=0 도 포함)
        cat_total = sum(pp['reason_cat_acc'].values())
        cat_order = [c for c, _ in _REASON_CATEGORIES] + [_REASON_OTHER]
        reason_categories = []
        for cat in cat_order:
            cnt = pp['reason_cat_acc'].get(cat, 0)
            reason_categories.append({
                'category': cat,
                'count': cnt,
                'ratio': round(cnt / cat_total, 4) if cat_total else 0,
            })

        total_all = pp['total_events_all_universe']
        prev_total = pp['prev_total_events_15']
        result_periods[k] = {
            'total_events_15': pp['total_events_15'],
            'total_events_all': total_all,
            'total_limit_count': pp['total_limit_count'],
            'total_52w_count': pp['total_52w_count'],
            'avg_rate_15': round(pp['sum_rate_all'] / total_all, 2) if total_all else 0,
            # NEW — 이전 기간 같은 길이 윈도우 통계
            'prev_total_events_15': prev_total,
            'prev_total_limit_count': pp['prev_total_limit_count'],
            'prev_total_52w_count': pp['prev_total_52w_count'],
            'prev_avg_rate_15': round(pp['prev_sum_rate_all'] / prev_total, 2) if prev_total else 0,
            'sector_top': sector_top,
            'theme_top': theme_top,
            'limit_up_top': pp['limit_up'][:20],
            'high_52w_top': pp['high_52w'][:20],
            'frequent_top': pp['frequent'][:50],
            'reason_top': reason_top,
            'reason_categories': reason_categories,
        }

    summary = {
        'built_at': datetime.now().isoformat(timespec='seconds'),   # KST (runner TZ=Seoul)
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


# ── 스크리닝 인덱스 ─────────────────────────────────────

# 테마 빈도 TOP N 추출 시 사용
_SCREENING_THEMES_PER_TICKER = 3
_SCREENING_THEMES_GLOBAL_TOP = 150


def _theme_freq(events: list[dict], top_n: int = _SCREENING_THEMES_PER_TICKER) -> list[str]:
    """events 의 theme_tag 빈도 TOP N — 스크리닝 필터 matching 용."""
    if not events:
        return []
    counts: dict[str, int] = {}
    for ev in events:
        t = (ev.get('theme_tag') or '').strip()
        if t:
            counts[t] = counts.get(t, 0) + 1
    if not counts:
        return []
    return [t for t, _ in sorted(counts.items(), key=lambda x: -x[1])[:top_n]]


def build_rise_history(stock_history_dir: Path, out_dir: Path) -> None:
    """종목별 stock-history → 날짜별 상승 순위 파일.

    홈/리포트의 날짜 탐색은 stock-rise raw(2026-04-13~)를 직접 읽으므로 그 이전
    백필 일자가 안 보인다. 여기서 종목별 events 를 날짜별로 역변환해
    /data/rise-history/{date}.json (getRankings 소비 스키마) + dates.json 을 만들고,
    프론트가 stock-rise 에 없는 과거 일자는 이 파일로 폴백한다.
    거래대금·거래량·시총은 이벤트에 채워진 값 사용(--enrich-ohlc). 없으면 시총은 marketmap(현재값) 폴백.
    """
    print('  build_rise_history (날짜별 역변환) ...')
    files = [f for f in sorted(stock_history_dir.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    cap_won_fb: dict[str, int] = {}    # marketmap 현재 시총(원) 폴백 (억원→원)
    mp = stock_history_dir.parent / 'marketmap.json'
    if mp.exists():
        try:
            for it in (json.loads(mp.read_text(encoding='utf-8')).get('items') or []):
                if it.get('ticker') and it.get('market_cap'):
                    cap_won_fb[it['ticker']] = int(it['market_cap']) * 10**8
        except Exception:
            pass
    by_date: dict[str, list[dict]] = {}
    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        ticker = h.get('ticker') or f.stem
        name = h.get('name') or ticker
        market = h.get('market') or ''
        for e in h.get('events', []):
            d = e.get('date')
            if not d:
                continue
            by_date.setdefault(d, []).append({
                'ticker': ticker,
                'name': name,
                'market': market,
                'change_rate': e.get('change_rate'),
                'close_price': e.get('close_price'),
                'trading_value': int(e.get('trading_value') or 0),   # 원 (volume×close)
                'trading_volume': int(e.get('trading_volume') or 0),
                'market_cap': int(e.get('market_cap') or cap_won_fb.get(ticker, 0)),  # 원
                'rise_reason': e.get('rise_reason') or '',
                'reason_confidence': e.get('reason_confidence') or '',
                'reason_source': e.get('reason_source') or '',
                'reason_status': e.get('reason_status') or '',
                'theme_tag': e.get('theme_tag') or '',
                'sector': e.get('sector') or '',
                'news': e.get('news') or [],
                'is_52w_high': bool(e.get('is_52w_high')),
            })
    out_dir.mkdir(parents=True, exist_ok=True)
    for d, rows in by_date.items():
        rows.sort(key=lambda r: (r.get('change_rate') or 0), reverse=True)
        for i, r in enumerate(rows, 1):
            r['rank'] = i
        (out_dir / f'{d}.json').write_text(
            json.dumps({
                'date': d,
                'collected_at': '',
                'is_final': True,
                'mode': 'backfill',
                'pullbacks': [],
                'rankings': rows,
            }, ensure_ascii=False),
            encoding='utf-8',
        )
    # stock-rise dates.json 과 동일하게 내림차순(최신 먼저) — 프론트는 dates[0]=최신 가정.
    dates_sorted = sorted(by_date.keys(), reverse=True)
    (out_dir / 'dates.json').write_text(
        json.dumps(dates_sorted, ensure_ascii=False), encoding='utf-8')
    print(f'    rise-history: {len(dates_sorted)} 일자 파일 + dates.json '
          f'({dates_sorted[0] if dates_sorted else "-"} ~ {dates_sorted[-1] if dates_sorted else "-"})')


# generic 추정 라벨 — 테마/섹터 보강으로 업그레이드 대상
_GENERIC_REASONS = {'시장 관심 증가', '상한가 — 사유 미수집'}


def build_pref_themes(stock_history_dir: Path, out_path: Path) -> None:
    """우선주 ticker → {theme_tag, sector} (보통주에서 상속) → /data/pref-themes.json.

    홈/리포트는 stock-rise 라이브(getRankings)를 직접 쓰는데, stock-rise 가 우선주에
    테마를 안 주거나 '분야' placeholder 를 주므로, 프론트(api.js)가 이 맵으로 보정한다.
    """
    files = [f for f in sorted(stock_history_dir.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    tmap: dict[str, dict] = {}
    names: dict[str, str] = {}
    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        t = h.get('ticker') or f.stem
        names[t] = h.get('name') or ''
        rec = tmap.setdefault(t, {})
        for e in h.get('events', []):
            th = (e.get('theme_tag') or '').strip()
            se = (e.get('sector') or '').strip()
            if th and th != '분야' and (not rec.get('theme_tag') or e.get('source') == 'stockrise'):
                rec['theme_tag'] = th
            if se and (not rec.get('sector') or e.get('source') == 'stockrise'):
                rec['sector'] = se
    out: dict[str, dict] = {}
    for t, nm in names.items():
        if len(t) == 6 and (nm.endswith('우') or nm.endswith('우B')):
            cm = tmap.get(t[:5] + '0') or {}
            rec = {}
            if cm.get('theme_tag'):
                rec['theme_tag'] = cm['theme_tag']
            if cm.get('sector'):
                rec['sector'] = cm['sector']
            if rec:
                out[t] = rec
    out_path.write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    print(f'  pref-themes: {len(out)} 우선주 → 보통주 테마 맵')


def build_meta_lookup(stock_history_dir: Path, use_naver: bool = False) -> dict[str, dict]:
    """ticker → {theme_tag, sector} (테마는 종목 단위로 정적).

    ① 기존 stock-history 이벤트(특히 source=stockrise)에서 theme_tag/sector 수집 (무료).
    ② use_naver: sector 가 비는 종목만 m.stock basic 으로 보강 (basic 은 테마 안 줌).
    """
    files = [f for f in sorted(stock_history_dir.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    meta: dict[str, dict] = {}
    have_events: set[str] = set()
    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        t = h.get('ticker') or f.stem
        rec = meta.setdefault(t, {})
        for e in h.get('events', []):
            have_events.add(t)
            th = (e.get('theme_tag') or '').strip()
            se = (e.get('sector') or '').strip()
            if th and (not rec.get('theme_tag') or e.get('source') == 'stockrise'):
                rec['theme_tag'] = th
            if se and (not rec.get('sector') or e.get('source') == 'stockrise'):
                rec['sector'] = se
    print(f'  meta lookup(무료): theme {sum(1 for r in meta.values() if r.get("theme_tag"))} / '
          f'sector {sum(1 for r in meta.values() if r.get("sector"))} 종목')
    if use_naver:
        miss = [t for t in sorted(have_events) if not meta.get(t, {}).get('sector')]
        print(f'  Naver 메타 보강 대상(sector 없음): {len(miss)} 종목')
        for i, t in enumerate(miss):
            if i % 200 == 0:
                print(f'    meta {i}/{len(miss)} ...')
            try:
                m = naver_client.fetch_stock_meta(t)
            except Exception:
                m = {}
            se = (m.get('sector') or '').strip()
            if se:
                meta.setdefault(t, {})['sector'] = se
        print(f'  meta lookup(+Naver): sector {sum(1 for r in meta.values() if r.get("sector"))} 종목')
    return meta


def enrich_events_meta(stock_history_dir: Path, meta: dict[str, dict]) -> int:
    """기존 이벤트에 theme_tag/sector 채우고 generic 사유를 테마/섹터화. 갱신 종목 수 반환.

    저신뢰 추정(reason_source∈{pattern,estimated,theme,naver}) + generic 라벨만 손댐.
    stockrise·뉴스 사유, '52주 신고가 도달' 은 불변. 필드만 채우므로 병합 안전.
    """
    files = [f for f in sorted(stock_history_dir.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    changed = 0
    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        ticker = h.get('ticker') or f.stem
        name = h.get('name') or ''
        m = meta.get(ticker) or {}
        theme = (m.get('theme_tag') or '').strip()
        sector = (m.get('sector') or '').strip()
        # 우선주(이름이 '우'/'우B'로 끝)는 보통주(앞5자리+'0') 태그를 물려받음.
        # stock-rise 가 우선주에 테마를 안 주거나 '분야' placeholder 를 주는 경우 보정.
        is_pref = len(ticker) == 6 and (name.endswith('우') or name.endswith('우B'))
        common = ticker[:5] + '0' if is_pref else ''
        if common:
            cm = meta.get(common) or {}
            if cm.get('theme_tag'):
                theme = cm['theme_tag'].strip()
            if cm.get('sector'):
                sector = cm['sector'].strip()
        if not theme and not sector and not is_pref:
            continue
        dirty = False
        for e in h.get('events', []):
            cur_th = (e.get('theme_tag') or '').strip()
            # 우선주: 보통주 테마로 강제 일치. 보통주: 빈 곳/‘분야’ placeholder 만 채움.
            if theme and (is_pref or not cur_th or cur_th == '분야'):
                if e.get('theme_tag') != theme:
                    e['theme_tag'] = theme
                    dirty = True
            elif cur_th == '분야':            # 채울 테마 없으면 placeholder 제거
                e['theme_tag'] = ''
                dirty = True
            cur_se = (e.get('sector') or '').strip()
            if sector and (is_pref or not cur_se):
                if e.get('sector') != sector:
                    e['sector'] = sector
                    dirty = True
            src = e.get('reason_source')
            rr = (e.get('rise_reason') or '').strip()
            if src in ('pattern', 'estimated', 'theme', 'naver') and rr in _GENERIC_REASONS:
                if rr == '상한가 — 사유 미수집':
                    new = f'{theme} 테마 상한가' if theme else (f'{sector} 상한가' if sector else '')
                else:  # '시장 관심 증가'
                    new = f'{theme} 테마 강세' if theme else (f'{sector} 강세' if sector else '')
                if new and new != rr:
                    e['rise_reason'] = new
                    e['reason_source'] = 'theme'
                    e['reason_status'] = 'filled'
                    dirty = True
        if dirty:
            h['stats'] = calc_stats(h.get('events') or [])
            f.write_text(json.dumps(h, ensure_ascii=False, indent=2), encoding='utf-8')
            changed += 1
    print(f'  enrich: {changed} 종목 파일 갱신')
    return changed


def build_enrich_meta(args) -> int:
    """기존 stock-history 에 테마/섹터 보강 + 사유 테마화 후 파생 산출물 재생성 (OHLC 재빌드 없음)."""
    print('== enrich-meta: 테마/섹터 보강 ==')
    meta = build_meta_lookup(OUTPUT_DIR, use_naver=not getattr(args, 'no_naver', False))
    enrich_events_meta(OUTPUT_DIR, meta)
    build_report_summary(OUTPUT_DIR, OUTPUT_DIR.parent / 'report-summary.json')
    build_rise_history(OUTPUT_DIR, OUTPUT_DIR.parent / 'rise-history')
    build_pref_themes(OUTPUT_DIR, OUTPUT_DIR.parent / 'pref-themes.json')
    build_screening_index(OUTPUT_DIR, OUTPUT_DIR.parent / 'screening.json')
    return 0


def build_enrich_ohlc(args) -> int:
    """이벤트에 거래량·거래대금·시총(역산) 채움 — OHLC 재수집 (전종목).

    trading_volume = OHLC accumulatedTradingVolume[date]
    trading_value  ≈ volume × close (원, 전종목)
    market_cap     ≈ 현재시총(원) × (과거종가 / 최근종가) — marketmap 보유 종목(억원→원).
    """
    today = date.today()
    start = _yyyymmdd(today - timedelta(days=400))
    end = _yyyymmdd(today)
    # 현재 시총(원) — 전종목 universe(marketValue 억원). marketmap(top100)보다 커버리지 넓음.
    cap_won: dict[str, int] = {}
    try:
        for it in fetch_ticker_universe(stock_only=True):
            t = it.get('itemCode')
            mv = _parse_int(it.get('marketValue')) or 0
            if t and mv:
                cap_won[t] = mv * 10**8        # 억원 → 원
    except Exception as e:
        print(f'  universe 시총 fetch 실패({e}) — marketmap 폴백')
    if not cap_won:
        mp = OUTPUT_DIR.parent / 'marketmap.json'
        if mp.exists():
            try:
                for it in (json.loads(mp.read_text(encoding='utf-8')).get('items') or []):
                    if it.get('ticker') and it.get('market_cap'):
                        cap_won[it['ticker']] = int(it['market_cap']) * 10**8
            except Exception:
                pass
    limit = getattr(args, 'limit', 0) or 0
    files = [f for f in sorted(OUTPUT_DIR.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    if limit:
        files = files[:limit]
    print(f'== enrich-ohlc: {len(files)} 종목, 시총맵 {len(cap_won)} (period {start}~{end}) ==')
    n_tickers = n_ev = n_vol = n_cap = 0
    t0 = time.time()
    for i, f in enumerate(files):
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        evs = h.get('events') or []
        if not evs:
            continue
        ticker = h.get('ticker') or f.stem
        if i % 100 == 0:
            print(f'  [{i}/{len(files)}] {ticker} vol={n_vol} cap={n_cap} {time.time() - t0:.0f}s')
        try:
            ohlc = naver_client.fetch_ohlc_daily(ticker, start, end)
        except Exception as e:
            print(f'    ohlc fail {ticker}: {e}')
            continue
        if not ohlc:
            continue
        by: dict[str, tuple] = {}
        latest_close = 0
        for r in ohlc:                      # 오름차순 → 마지막이 최신
            d = (r.get('localDate') or '')[:8]
            cl = r.get('closePrice') or 0
            vol = r.get('accumulatedTradingVolume') or 0
            if d:
                by[d] = (cl, vol)
                if cl:
                    latest_close = cl
        cw = cap_won.get(ticker, 0)
        dirty = False
        for e in evs:
            rec = by.get(e.get('date'))
            if not rec:
                continue
            cl, vol = rec
            cl = cl or e.get('close_price') or 0
            n_ev += 1
            if vol:
                e['trading_volume'] = int(vol)
                e['trading_value'] = int(vol * cl)
                n_vol += 1
                dirty = True
            if cw and latest_close and cl:
                e['market_cap'] = int(cw * (cl / latest_close))
                n_cap += 1
                dirty = True
        if dirty:
            h['stats'] = calc_stats(h.get('events') or [])
            f.write_text(json.dumps(h, ensure_ascii=False, indent=2), encoding='utf-8')
            n_tickers += 1
    print(f'== enrich-ohlc 완료: vol {n_vol}, cap {n_cap} / {n_ev} 매칭이벤트, '
          f'{n_tickers} 종목, {time.time() - t0:.0f}s ==')
    if not getattr(args, 'no_regen', False):
        build_report_summary(OUTPUT_DIR, OUTPUT_DIR.parent / 'report-summary.json')
        build_rise_history(OUTPUT_DIR, OUTPUT_DIR.parent / 'rise-history')
        build_pref_themes(OUTPUT_DIR, OUTPUT_DIR.parent / 'pref-themes.json')
        build_screening_index(OUTPUT_DIR, OUTPUT_DIR.parent / 'screening.json')
    return 0


def _dates_around(date_str: str, span: int = 1) -> set:
    """date_str(YYYYMMDD) ±span 일 집합 (월경계 정확)."""
    base = datetime.strptime(date_str, '%Y%m%d')
    return {(base + timedelta(days=k)).strftime('%Y%m%d') for k in range(-span, span + 1)}


def build_enrich_news(args) -> int:
    """백필 저신뢰 사유를 종목별 과거 뉴스(페이지네이션) 키워드 매칭으로 업그레이드 — stock-rise 방식.

    대상: reason_source ∈ {pattern,estimated,theme,naver} 이고 date < news_before 인 이벤트.
    종목당 max_pages 페이지까지 뉴스 수집 → 각 이벤트 날짜 ±1일 기사 제목 키워드 매칭(reason_from_news).
    stockrise/news 정답 사유는 불변.
    """
    from estimate_reasons import reason_from_news  # noqa: E402
    cutoff_date = getattr(args, 'news_before', None) or '20260413'
    max_pages = getattr(args, 'news_pages', 0) or 20
    limit = getattr(args, 'limit', 0) or 0
    LOW = {'pattern', 'estimated', 'theme', 'naver'}
    files = [f for f in sorted(OUTPUT_DIR.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]
    targets = []
    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        evs = [e for e in h.get('events', [])
               if (e.get('date') or '') < cutoff_date and e.get('reason_source') in LOW]
        if evs:
            targets.append((f, h, evs))
    if limit:
        targets = targets[:limit]
    print(f'== enrich-news: 대상 {len(targets)} 종목 (max_pages={max_pages}, before={cutoff_date}, limit={limit}) ==')
    n_tickers = n_events = n_up = 0
    min_reached = '99999999'
    t0 = time.time()
    for i, (f, h, evs) in enumerate(targets):
        ticker = h.get('ticker') or f.stem
        if i % 50 == 0:
            print(f'  [{i}/{len(targets)}] {ticker} up={n_up}/{n_events} '
                  f'minNews={min_reached} elapsed={time.time() - t0:.0f}s')
        # 이 종목의 가장 오래된 대상일까지만 페이지(조기중단) — 전체 런타임 대폭 단축
        stop_before = min(e['date'] for e in evs)
        try:
            raw = naver_client.fetch_stock_news_paged(
                ticker, max_pages=max_pages, stop_before=stop_before)
        except Exception as e:
            print(f'    news fail {ticker}: {e}')
            continue
        dated = []
        for it in raw:
            dt = (it.get('datetime') or '')[:8]
            if dt.isdigit() and len(dt) == 8:
                dated.append((dt, it))
                if dt < min_reached:
                    min_reached = dt
        if not dated:
            continue
        dirty = False
        for e in evs:
            n_events += 1
            around = _dates_around(e['date'], 1)
            near = [it for dt, it in dated if dt in around]
            if not near:
                continue
            hit = reason_from_news([{'title': it.get('title', '')} for it in near])
            if hit:
                label, conf, src = hit
                e['rise_reason'] = label
                e['reason_confidence'] = conf
                e['reason_source'] = 'news'
                e['reason_status'] = 'filled'
                e['news'] = [naver_client.normalize_news_item(it) for it in near[:5]]
                n_up += 1
                dirty = True
        if dirty:
            h['stats'] = calc_stats(h.get('events') or [])
            f.write_text(json.dumps(h, ensure_ascii=False, indent=2), encoding='utf-8')
            n_tickers += 1
    print(f'== enrich-news 완료: {n_up}/{n_events} 이벤트 사유 업그레이드, {n_tickers} 종목 갱신, '
          f'뉴스 최소도달일 {min_reached}, {time.time() - t0:.0f}s ==')
    if not getattr(args, 'no_regen', False):
        build_report_summary(OUTPUT_DIR, OUTPUT_DIR.parent / 'report-summary.json')
        build_rise_history(OUTPUT_DIR, OUTPUT_DIR.parent / 'rise-history')
        build_pref_themes(OUTPUT_DIR, OUTPUT_DIR.parent / 'pref-themes.json')
        build_screening_index(OUTPUT_DIR, OUTPUT_DIR.parent / 'screening.json')
    return 0


def build_screening_index(
    stock_history_dir: Path,
    output_path: Path,
    marketmap_path: Path | None = None,
) -> None:
    """종목별 스크리닝 인덱스 빌드 → /data/screening.json.

    각 ticker 의 stats(count_10/15/20/limit/recent) + sector + market_cap + themes TOP 3 +
    가장 최근 +10% event 메타를 한 행으로 정리. 클라이언트가 횟수·섹터·테마·시총 필터 적용.
    count_10 == 0 (1년간 +10% 0회) 종목은 스크리닝 의미 없어 스킵.
    """
    print('  build_screening_index ...')
    files = [f for f in sorted(stock_history_dir.glob('*.json'))
             if f.name not in ('index.json', 'report-summary.json')]

    mkt_lookup: dict[str, dict] = {}
    mp = marketmap_path or (stock_history_dir.parent / 'marketmap.json')
    if mp.exists():
        try:
            mm = json.loads(mp.read_text(encoding='utf-8'))
            for it in (mm.get('items') or []):
                t = it.get('ticker')
                if t:
                    mkt_lookup[t] = {
                        'sector': (it.get('sector') or '').strip(),
                        'market_cap': it.get('market_cap') or 0,
                    }
        except Exception as e:
            print(f'    marketmap 로드 실패: {e}')

    tickers_data: list[dict] = []
    sectors_set: set[str] = set()
    theme_ticker_counts: dict[str, int] = {}

    for f in files:
        try:
            h = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        ticker = h.get('ticker') or ''
        if not ticker:
            continue
        stats = h.get('stats') or {}
        if (stats.get('count_10') or 0) == 0:   # 최근 1년 +10% 0회 → 스크리닝 제외
            continue
        events = h.get('events') or []
        # 테마 빈도도 최근 1년 윈도우만 (1년 이전 백필 제외 — 횟수/스크리닝 일관)
        _cut1y = (date.today() - timedelta(days=365)).strftime('%Y%m%d')
        events_1y = [e for e in events if (e.get('date') or '') >= _cut1y] or events
        themes_top = _theme_freq(events_1y)
        latest = events[0] if events else {}
        latest_sector = (latest.get('sector') or '').strip()
        mkt = mkt_lookup.get(ticker, {})
        sector = latest_sector or mkt.get('sector', '')
        market_cap = mkt.get('market_cap', 0) or 0

        tickers_data.append({
            'ticker': ticker,
            'name': h.get('name') or ticker,
            'market': h.get('market') or '',
            'sector': sector,
            'market_cap': market_cap,
            'count_10': stats.get('count_10') or 0,
            'count_15': stats.get('count_15') or 0,
            'count_20': stats.get('count_20') or 0,
            'count_limit': stats.get('count_limit') or 0,
            'count_recent': stats.get('count_recent') or 0,
            'avg_rate': stats.get('avg_rate') or 0,
            'themes': themes_top,
            'latest_date': latest.get('date') or '',
            'latest_change_rate': latest.get('change_rate') or 0,
            'latest_reason': latest.get('rise_reason') or '',
            'latest_theme': (latest.get('theme_tag') or '').strip(),
        })
        if sector:
            sectors_set.add(sector)
        for t in themes_top:
            theme_ticker_counts[t] = theme_ticker_counts.get(t, 0) + 1

    # 디폴트 표시 순서: count_15 desc → count_10 desc → market_cap desc
    tickers_data.sort(key=lambda x: (
        -(x['count_15'] or 0), -(x['count_10'] or 0), -(x['market_cap'] or 0)
    ))

    themes_top_global = sorted(
        ({'theme': t, 'tickers': c} for t, c in theme_ticker_counts.items()),
        key=lambda x: -x['tickers'],
    )[:_SCREENING_THEMES_GLOBAL_TOP]

    output = {
        'built_at': datetime.now().isoformat(timespec='seconds'),
        'total_tickers': len(tickers_data),
        'sectors': sorted(sectors_set),
        'themes': themes_top_global,
        'tickers': tickers_data,
    }
    output_path.write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')
    size_kb = output_path.stat().st_size // 1024
    print(f'    -> {output_path.name}: {len(tickers_data)} 종목, '
          f'{len(sectors_set)} 섹터, {len(themes_top_global)} 테마 ({size_kb}KB)')


# ── 진입점 ─────────────────────────────────────────────

def build_full(args) -> int:
    cutoff = args.cutoff
    days = args.days
    limit_tickers = args.limit_tickers
    output_dir = OUTPUT_DIR

    incremental = getattr(args, 'incremental', False)
    today = date.today()
    start = today - timedelta(days=days + 30)  # 52주 신고가 계산 위해 여유
    end = today
    window_start = _yyyymmdd(start)

    print(f'== build-history {"incremental" if incremental else "full"}: days={days} cutoff={cutoff} ==')
    print(f'  기간: {window_start} ~ {_yyyymmdd(end)}', flush=True)

    # 1. ticker universe (전종목 메타 — OHLC fetch 아님, 가벼움)
    universe = fetch_ticker_universe(stock_only=True)
    if limit_tickers:
        universe = universe[:limit_tickers]
        print(f'  --limit-tickers={limit_tickers} 적용')

    # 2. stock-rise dates → lookup (운영 이후 정답)
    #    incremental 은 윈도우 안 날짜만 fetch — 전체 250여일 fetch 회피.
    sr_dates = load_stockrise_dates()
    lookup_dates = [d for d in sr_dates if d >= window_start] if incremental else sr_dates
    print(f'  stock-rise dates: {len(sr_dates)} 거래일 (lookup {len(lookup_dates)})', flush=True)
    sr_lookup = build_stockrise_lookup(lookup_dates)
    print(f'  stock-rise lookup 항목: {len(sr_lookup)}', flush=True)

    # 2-b. incremental: 최근 급등 종목만 처리 — 전종목 OHLC fetch(가드 30분 초과 원인) 회피.
    #      빠지는 종목 = 윈도우에 컷 이상 급등이 없던 종목 → 새 이벤트 없음(손실 없음).
    if incremental:
        wanted = _recent_mover_tickers(sr_lookup, window_start, cutoff)
        before = len(universe)
        universe = [it for it in universe if (it.get('itemCode') or '') in wanted]
        print(f'  [incremental] 유니버스 축소: {before} → {len(universe)} 종목 (최근 급등만)', flush=True)

    # ticker → {theme_tag, sector} (테마는 종목 단위로 정적) — 추정 이벤트(과거 포함)에 태그·테마 사유 부여.
    theme_by_ticker: dict[str, dict] = {}
    for (_d, _t), _sr in sr_lookup.items():
        rec = theme_by_ticker.setdefault(_t, {})
        if not rec.get('theme_tag') and _sr.get('theme_tag'):
            rec['theme_tag'] = _sr.get('theme_tag')
        if not rec.get('sector') and _sr.get('sector'):
            rec['sector'] = _sr.get('sector')
    print(f'  theme/sector lookup: {len(theme_by_ticker)} 종목')

    # 3. 뉴스 캐시 (같은 ticker 한 번만 fetch — 최신 40건 기준)
    news_cache_by_ticker: dict[str, list[dict]] = {}

    def _raw_news(ticker: str) -> list[dict]:
        if ticker not in news_cache_by_ticker:
            try:
                news_cache_by_ticker[ticker] = naver_client.fetch_stock_news(ticker, page_size=40)
            except Exception as e:
                print(f'    news fetch fail {ticker}: {e}')
                news_cache_by_ticker[ticker] = []
        return news_cache_by_ticker[ticker]

    def _news_within(ticker: str, date_str: str, span: int) -> list[dict]:
        target = int(date_str)
        out = []
        for it in _raw_news(ticker):
            dt = (it.get('datetime') or '')[:8]
            if dt.isdigit() and abs(int(dt) - target) <= span:
                out.append(it)
        return out

    # 추정 경로 입력 — 기존과 동일(±1, raw, 5건). estimate_reason 회귀 방지로 윈도우 유지.
    def fetch_news_fn(ticker: str, date_str: str) -> list[dict]:
        return _news_within(ticker, date_str, 1)[:5]

    # 최근 이벤트 풀 보강용 — 당일±SPAN 네이버 종목뉴스를 표준형으로. (캐시는 위와 공유)
    def supplement_news_fn(ticker: str, date_str: str) -> list[dict]:
        return [naver_client.normalize_news_item(it)
                for it in _news_within(ticker, date_str, RECENT_NEWS_SPAN)]

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
            meta={'sector': (theme_by_ticker.get(ticker, {}).get('sector')
                             or item.get('industryName') or ''),
                  'theme_tag': theme_by_ticker.get(ticker, {}).get('theme_tag', '')},
            supplement_news_fn=supplement_news_fn,
            anchor_str=today.strftime('%Y%m%d'),
        )
        events = apply_overrides(events, ticker)
        # 무한 누적: 이번 윈도우(start_str~) 밖 과거 이벤트는 기존 파일에서 보존.
        # → 증분 빌드가 백필한 과거를 덮어쓰지 않음.
        old_events = load_existing_events(ticker, output_dir)
        events = merge_ticker_events(old_events, events, start_str)
        # events 비어도 stock-history 빌드 — 종목 페이지가 "기록 없음" 안내라도 보여주도록.
        # 검색 자동완성·sitemap 도 모든 종목 포함.
        write_ticker_history(ticker, name, market, events, output_dir)
        index_meta[ticker] = {
            'name': name,
            'count': len([e for e in events if e['change_rate'] >= 15]),
            'count_recent': sum(1 for e in events if e['date'] >=
                                _yyyymmdd(today - timedelta(days=30))),
        }
        success += 1

    # incremental 은 처리한 종목만 index_meta 에 있으므로 기존 index.json 에 병합한다.
    # (병합 안 하면 검색 자동완성 인덱스가 처리분으로 쪼그라듦.) full 은 전량이라 그대로 덮어씀.
    if incremental:
        idx_path = output_dir / 'index.json'
        merged: dict[str, dict] = {}
        if idx_path.exists():
            try:
                merged = json.loads(idx_path.read_text(encoding='utf-8')) or {}
            except Exception:
                merged = {}
        merged.update(index_meta)
        index_meta = merged
        print(f'  [incremental] index 병합: {len(index_meta)} 종목 유지', flush=True)
    write_index(index_meta, output_dir)
    write_build_meta(sr_dates)
    build_report_summary(output_dir, output_dir.parent / 'report-summary.json')
    build_rise_history(output_dir, output_dir.parent / 'rise-history')
    build_pref_themes(output_dir, output_dir.parent / 'pref-themes.json')
    build_sitemap(output_dir, output_dir.parent.parent)
    build_marketmap(output_dir.parent.parent)
    build_screening_index(output_dir, output_dir.parent / 'screening.json')
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
            history['built_at'] = datetime.now().isoformat(timespec='seconds')   # KST
            f.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding='utf-8')
            updated += 1
        processed += 1
        if processed % 20 == 0:
            print(f'  processed {processed}, updated {updated}')
    print(f'== estimate 완료: {updated}/{processed} ticker 갱신 ==')
    build_report_summary(output_dir, output_dir.parent / 'report-summary.json')
    build_rise_history(output_dir, output_dir.parent / 'rise-history')
    build_pref_themes(output_dir, output_dir.parent / 'pref-themes.json')
    build_sitemap(output_dir, output_dir.parent.parent)
    build_screening_index(output_dir, output_dir.parent / 'screening.json')
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
            # 장중 빌드 — 짧은 TTL 로 오늘 row 자주 갱신
            ohlc = fetch_ohlc_cached(ticker, start_str, end_str, ttl_s=_OHLC_CACHE_TTL_INTRADAY_S)
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


def build_marketmap_intraday(public_dir: Path | None = None, top_n: int = 100) -> int:
    """라이브 m.stock API 만으로 marketmap.json 빠르게 갱신 (~60s).

    1년치 OHLC fetch 안 함 — 기존 marketmap.json 의 rates 1w/1m/3m/1y 그대로 유지.
    오늘 1d (market_cap, close_price, change_rate, trading_value/volume, rates['1d']) 만
    라이브 값으로 update.

    universe: KOSPI/KOSDAQ 전종목 시총 페이지 (list_market_tickers) — 시총·거래대금·양수
    상승률 union TOP n 후보를 시총과 무관하게 확보 (시총 작은 급등주 누락 방지).

    매시 :10 cron 용. 장중 빠른 갱신.
    """
    target_dir = (public_dir or _REPO / 'public') / 'data'
    target_dir.mkdir(parents=True, exist_ok=True)
    snap_dir = target_dir / 'marketmap'
    snap_dir.mkdir(parents=True, exist_ok=True)

    def parse_float(v):
        if v is None: return 0.0
        try:
            return float(v.replace(',', '').strip()) if isinstance(v, str) else float(v)
        except (ValueError, TypeError):
            return 0.0

    print('== marketmap-intraday: m.stock 전종목 universe fetch ==')
    pool: list[dict] = []
    first_meta: dict = {}
    for market in ('KOSPI', 'KOSDAQ'):
        try:
            stocks = naver_client.list_market_tickers(market)
        except Exception as e:
            print(f'  {market} fetch 실패: {e}')
            stocks = []
        # ETF/ETN/리츠 제외 — build_marketmap (full) 의 fetch_ticker_universe(stock_only=True) 와 정합
        stocks = [s for s in stocks if s.get('stockEndType') == 'stock']
        if market == 'KOSPI' and stocks:
            first_meta = stocks[0]
        if stocks:
            print(f'  {market}: {len(stocks)} 종목 fetch')
        for s in stocks:
            ticker = s.get('itemCode') or ''
            if not ticker or len(ticker) != 6:
                continue
            mc_won = _parse_int(s.get('marketValueRaw')) or (
                (_parse_int(s.get('marketValue')) or 0) * 1_000_000
            )
            if mc_won <= 0:
                continue
            mc = max(1, mc_won // 100_000_000)   # 원 → 억원 (정적 marketmap.json 과 단위 일치)
            rate = parse_float(s.get('fluctuationsRatio'))
            close = _parse_int(s.get('closePriceRaw')) or _parse_int(s.get('closePrice')) or 0
            tv = _parse_int(s.get('accumulatedTradingValueRaw'))
            if not tv:
                tv = (_parse_int(s.get('accumulatedTradingValue')) or 0) * 1000
            tvol = (_parse_int(s.get('accumulatedTradingVolumeRaw'))
                    or _parse_int(s.get('accumulatedTradingVolume')) or 0)
            pool.append({
                'ticker': ticker,
                'name': s.get('stockName') or ticker,
                'market': market,
                'market_cap': mc,
                'close_price': close,
                'change_rate': round(rate, 2),
                'trading_value': tv or 0,
                'trading_volume': tvol,
            })
    if not pool:
        print('== marketmap-intraday 실패: 라이브 fetch 결과 없음 ==')
        return 1

    # union TOP n per market (시총·거래량·양수상승률)
    def union_top(market):
        ms = [x for x in pool if x['market'] == market]
        selected = {}
        for it in sorted(ms, key=lambda x: x['market_cap'], reverse=True)[:top_n]:
            selected[it['ticker']] = it
        for it in sorted(ms, key=lambda x: x['trading_value'], reverse=True)[:top_n]:
            selected[it['ticker']] = it
        rise = [c for c in ms if (c.get('change_rate') or 0) > 0]
        for it in sorted(rise, key=lambda x: x['change_rate'], reverse=True)[:top_n]:
            selected[it['ticker']] = it
        return list(selected.values())
    union = union_top('KOSPI') + union_top('KOSDAQ')

    target_date = (first_meta.get('localTradedAt') or '')[:10].replace('-', '') or _yyyymmdd(date.today())

    # 기존 marketmap.json 의 rates / sector 보존
    existing_by_ticker: dict[str, dict] = {}
    existing_path = target_dir / 'marketmap.json'
    if existing_path.exists():
        try:
            old = json.loads(existing_path.read_text(encoding='utf-8'))
            for it in (old.get('items') or []):
                if it.get('ticker'):
                    existing_by_ticker[it['ticker']] = it
        except Exception:
            pass

    items: list[dict] = []
    for it in union:
        old_it = existing_by_ticker.get(it['ticker']) or {}
        rates = dict(old_it.get('rates') or {})
        rates['1d'] = it['change_rate']
        items.append({
            'ticker': it['ticker'],
            'name': it['name'],
            'market': it['market'],
            'sector': old_it.get('sector', ''),
            'market_cap': it['market_cap'],
            'close_price': it['close_price'],
            'change_rate': it['change_rate'],
            'rates': rates,
            'trading_value': it['trading_value'],
            'trading_volume': it['trading_volume'],
        })
    items.sort(key=lambda x: x['market_cap'], reverse=True)
    output = {
        'date': target_date,
        'updated_at': datetime.now().isoformat(timespec='seconds'),
        'universe': 'union',
        'items': items,
    }
    existing_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    snap_path = snap_dir / f'{target_date}.json'
    snap_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')

    # 일별 인덱스 갱신
    idx_path = snap_dir / 'index.json'
    dates_existing: list[str] = []
    if idx_path.exists():
        try:
            d_ = json.loads(idx_path.read_text(encoding='utf-8'))
            if isinstance(d_, list):
                dates_existing = d_
        except Exception:
            pass
    if target_date not in dates_existing:
        dates_existing.append(target_date)
    dates_existing = sorted(set(dates_existing), reverse=True)
    idx_path.write_text(json.dumps(dates_existing), encoding='utf-8')

    print(f'== marketmap-intraday 완료: {len(items)} 종목, 기준일 {target_date} ==')

    # report-summary.json 의 built_at 도 같이 갱신 — 사용자에게 "최신" 인상
    # (stock-history/*.json 이 15:40 까지 안 바뀌니 통계 수치는 동일, built_at 만 새로 찍힘)
    try:
        build_report_summary(OUTPUT_DIR, OUTPUT_DIR.parent / 'report-summary.json')
    except Exception as e:
        print(f'  report-summary 갱신 실패 (무시): {e}')
    # screening.json 도 같이 — marketmap 의 최신 시총 반영 위해
    try:
        build_screening_index(OUTPUT_DIR, OUTPUT_DIR.parent / 'screening.json')
    except Exception as e:
        print(f'  screening 갱신 실패 (무시): {e}')

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
    p.add_argument('--incremental', action='store_true',
                   help='경량 증분 — 최근 윈도우에 급등한 종목만 처리(전종목 OHLC fetch 회피). '
                        'index.json 은 기존과 병합. 파생물은 전 디렉토리 기반이라 영향 없음.')
    p.add_argument('--estimate-only', action='store_true',
                   help='인덱스 missing 만 재추정')
    p.add_argument('--marketmap-only', action='store_true',
                   help='전종목 OHLC 1년치 + union → marketmap.json (5~15분, rates 다 갱신)')
    p.add_argument('--marketmap-intraday', action='store_true',
                   help='라이브 m.stock 만으로 marketmap.json 1d 빠르게 갱신 (~30s, rates 1w/1m/3m/1y 유지)')
    p.add_argument('--backfill-days', type=int, default=0,
                   help='--marketmap-only 와 함께: 과거 N 영업일치 일별 스냅샷 일괄 빌드')
    p.add_argument('--report-only', action='store_true',
                   help='기존 stock-history/*.json 만 읽어서 report-summary.json 재집계 (~30s)')
    p.add_argument('--enrich-meta', action='store_true',
                   help='기존 stock-history 에 테마/섹터 보강 + generic 사유 테마화 (OHLC 재빌드 없음)')
    p.add_argument('--no-naver', action='store_true',
                   help='--enrich-meta 시 Naver 메타 보강 생략(무료 propagation 만)')
    p.add_argument('--enrich-ohlc', action='store_true',
                   help='이벤트에 거래량·거래대금·시총(역산) 채움 — OHLC 재수집 (전종목)')
    p.add_argument('--enrich-news', action='store_true',
                   help='백필 저신뢰 사유를 종목별 과거 뉴스 키워드 매칭으로 업그레이드 (stock-rise 방식)')
    p.add_argument('--news-pages', type=int, default=20,
                   help='--enrich-news 종목당 최대 뉴스 페이지 수')
    p.add_argument('--news-before', type=str, default='20260413',
                   help='--enrich-news 대상: 이 날짜(YYYYMMDD) 이전 이벤트만')
    p.add_argument('--no-regen', action='store_true',
                   help='--enrich-news 후 파생 산출물(rise-history 등) 재생성 생략(샘플 테스트용)')
    p.add_argument('--limit', type=int, default=0,
                   help='estimate-only 시 처리 개수 한도')
    args = p.parse_args()

    if args.marketmap_intraday:
        sys.exit(build_marketmap_intraday())
    if args.marketmap_only:
        sys.exit(build_marketmap_only(args))
    if args.estimate_only:
        sys.exit(build_estimate_only(args))
    if args.enrich_meta:
        sys.exit(build_enrich_meta(args))
    if args.enrich_ohlc:
        sys.exit(build_enrich_ohlc(args))
    if args.enrich_news:
        sys.exit(build_enrich_news(args))
    if args.report_only:
        recompute_all_stats(OUTPUT_DIR)
        build_report_summary(OUTPUT_DIR, OUTPUT_DIR.parent / 'report-summary.json')
        build_rise_history(OUTPUT_DIR, OUTPUT_DIR.parent / 'rise-history')
        build_pref_themes(OUTPUT_DIR, OUTPUT_DIR.parent / 'pref-themes.json')
        build_screening_index(OUTPUT_DIR, OUTPUT_DIR.parent / 'screening.json')
        sys.exit(0)
    sys.exit(build_full(args))


if __name__ == '__main__':
    main()
