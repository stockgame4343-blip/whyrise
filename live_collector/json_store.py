"""JSON 파일 기반 데이터 저장/조회 (SQLite 대체)"""
import json
import os
import logging
from datetime import datetime, timedelta

from config import DATA_DIR, DATA_RETENTION_DAYS, SECTOR_CACHE_PATH, NEWS_HISTORY_PATH, NEWS_HISTORY_DAYS, THEME_CACHE_PATH, THEME_CACHE_DAYS, TAG_OVERRIDES_PATH, TAG_FEEDBACK_PATH

logger = logging.getLogger(__name__)


def _ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def save_daily_data(date_str, data):
    """날짜별 JSON 파일 저장"""
    _ensure_data_dir()
    path = os.path.join(DATA_DIR, f'{date_str}.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"  저장 완료: {path}")


def load_daily_data(date_str):
    """날짜별 JSON 파일 로드"""
    path = os.path.join(DATA_DIR, f'{date_str}.json')
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def update_dates_index():
    """data/dates.json 갱신"""
    _ensure_data_dir()
    dates = []
    for fname in os.listdir(DATA_DIR):
        if fname.endswith('.json') and fname != 'dates.json' and len(fname) == 13:
            dates.append(fname.replace('.json', ''))

    dates.sort(reverse=True)

    path = os.path.join(DATA_DIR, 'dates.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(dates, f, ensure_ascii=False)
    logger.info(f"  dates.json 갱신: {len(dates)}개 날짜")


def cleanup_old_data():
    """보관 기간 초과 JSON 삭제. DATA_RETENTION_DAYS<=0 이면 비활성화 (무한 보관)."""
    if not DATA_RETENTION_DAYS or DATA_RETENTION_DAYS <= 0:
        return

    cutoff = (datetime.now() - timedelta(days=DATA_RETENTION_DAYS)).strftime('%Y%m%d')
    removed = 0

    for fname in os.listdir(DATA_DIR):
        if fname.endswith('.json') and fname != 'dates.json' and len(fname) == 13:
            date_part = fname.replace('.json', '')
            if date_part < cutoff:
                os.remove(os.path.join(DATA_DIR, fname))
                removed += 1

    if removed:
        logger.info(f"  오래된 데이터 {removed}개 삭제")
        update_dates_index()


# ── 섹터 캐시 ──

def load_sector_cache():
    if not os.path.exists(SECTOR_CACHE_PATH):
        return {}
    try:
        with open(SECTOR_CACHE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def save_sector_cache(sector_map):
    with open(SECTOR_CACHE_PATH, 'w', encoding='utf-8') as f:
        json.dump(sector_map, f, ensure_ascii=False, indent=2)


# ── 테마 태그 캐시 ──

def load_theme_cache():
    """테마 태그 캐시 로드
    Returns:
        dict: { ticker: { 'tag': str, 'date': 'YYYYMMDD' } }
    """
    if not os.path.exists(THEME_CACHE_PATH):
        return {}
    try:
        with open(THEME_CACHE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def save_theme_cache(cache):
    with open(THEME_CACHE_PATH, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def get_cached_theme_tags(tickers, date_str):
    """캐시에서 유효한 테마 태그 조회, 미스 목록 반환

    Returns:
        tuple: (cached_tags: dict, uncached_tickers: list)
    """
    cache = load_theme_cache()
    cutoff = (datetime.now() - timedelta(days=THEME_CACHE_DAYS)).strftime('%Y%m%d')

    cached_tags = {}
    uncached = []

    for t in tickers:
        entry = cache.get(t)
        if entry and entry.get('tag') and entry.get('date', '') >= cutoff:
            cached_tags[t] = entry['tag']
        else:
            uncached.append(t)

    return cached_tags, uncached


def update_theme_cache(date_str, tag_map):
    """새로 추출한 테마 태그를 캐시에 저장"""
    cache = load_theme_cache()
    for ticker, tag in tag_map.items():
        if tag:
            cache[ticker] = {'tag': tag, 'date': date_str}
    save_theme_cache(cache)
    logger.info(f"  테마 캐시 갱신: {len(tag_map)}개 종목")


# ── 뉴스 이력 (7일 지속성 판단용) ──

def load_news_history():
    """뉴스 이력 로드

    Returns:
        dict: { ticker: [{'date': 'YYYYMMDD', 'count': int, 'titles': [...]}] }
    """
    if not os.path.exists(NEWS_HISTORY_PATH):
        return {}
    try:
        with open(NEWS_HISTORY_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def save_news_history(history):
    with open(NEWS_HISTORY_PATH, 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


def update_news_history(date_str, news_map):
    """오늘의 뉴스를 이력에 추가하고 오래된 이력 정리

    Args:
        date_str: 'YYYYMMDD'
        news_map: { ticker: [article, ...] }
    """
    history = load_news_history()

    cutoff = (datetime.now() - timedelta(days=NEWS_HISTORY_DAYS)).strftime('%Y%m%d')

    for ticker, articles in news_map.items():
        if ticker not in history:
            history[ticker] = []

        # 오래된 이력 제거
        history[ticker] = [
            entry for entry in history[ticker]
            if entry.get('date', '') >= cutoff
        ]

        # 오늘 중복 추가 방지
        existing_dates = {entry['date'] for entry in history[ticker]}
        if date_str not in existing_dates:
            history[ticker].append({
                'date': date_str,
                'count': len(articles),
                'titles': [a.get('title', '')[:50] for a in articles[:5]],
            })

    # 이력이 없는 종목 정리
    history = {t: entries for t, entries in history.items() if entries}

    save_news_history(history)
    logger.info(f"  뉴스 이력 갱신: {len(history)}개 종목")

    return history


# ── 백테스트 데이터 ──

BACKTEST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest.json')


def load_backtest_data():
    if not os.path.exists(BACKTEST_PATH):
        return []
    try:
        with open(BACKTEST_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return []


def append_backtest_data(date_str, rankings):
    """백테스트용 데이터 기록 (점수 vs 이후 등락률 비교용)

    매일 수집 시 대장점수를 기록하고, 다음 수집 시 전일 종가 변화를 역으로 기록.
    """
    data = load_backtest_data()

    # 이전 기록에 후속 등락률 기입
    if data:
        last_entry = data[-1]
        if not last_entry.get('next_day_filled'):
            price_map = {r['ticker']: r['close_price'] for r in rankings}
            for item in last_entry.get('stocks', []):
                next_price = price_map.get(item['ticker'])
                if next_price and item.get('close_price', 0) > 0:
                    item['next_change_pct'] = round(
                        (next_price - item['close_price']) / item['close_price'] * 100, 2
                    )
            last_entry['next_day_filled'] = True

    # 오늘 기록 추가
    stocks = []
    for r in rankings:
        stocks.append({
            'ticker': r['ticker'],
            'name': r['name'],
            'score': r['score'],
            'close_price': r['close_price'],
            'change_rate': r['change_rate'],
        })

    data.append({
        'date': date_str,
        'stocks': stocks,
        'next_day_filled': False,
    })

    # 최근 90일만 보관
    if len(data) > 90:
        data = data[-90:]

    with open(BACKTEST_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    logger.info(f"  백테스트 데이터 기록: {len(stocks)}개 종목")


# ── 사용자 태그 오버라이드 ──

def load_tag_overrides():
    """사용자가 수동 지정한 테마 태그 로드
    Returns:
        dict: { ticker: tag_string }
    """
    if not os.path.exists(TAG_OVERRIDES_PATH):
        return {}
    try:
        with open(TAG_OVERRIDES_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


# ── 태그 피드백 (사용자 학습) ──

def load_tag_feedback():
    """사용자 태그 피드백 로드 (수동 수정/삭제 이력)

    Returns:
        dict: {
            'overrides': { ticker: tag },   # 수동 수정한 태그
            'bad_tags': ['잘못된태그', ...], # 삭제된 태그 (다시 생성 방지)
        }
    """
    if not os.path.exists(TAG_FEEDBACK_PATH):
        return {'overrides': {}, 'bad_tags': []}
    try:
        with open(TAG_FEEDBACK_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # 구조 보장
        if 'overrides' not in data:
            data['overrides'] = {}
        if 'bad_tags' not in data:
            data['bad_tags'] = []
        return data
    except (json.JSONDecodeError, IOError):
        return {'overrides': {}, 'bad_tags': []}


def save_tag_feedback(feedback):
    """태그 피드백 저장"""
    with open(TAG_FEEDBACK_PATH, 'w', encoding='utf-8') as f:
        json.dump(feedback, f, ensure_ascii=False, indent=2)


# ── 요약 인덱스 ──

def update_summary_index():
    """public/data/summary.json 갱신 — 모든 날짜별 JSON에서 요약 통계 추출"""
    _ensure_data_dir()

    skip = {'dates.json', 'summary.json'}
    date_files = []
    for fname in os.listdir(DATA_DIR):
        if fname.endswith('.json') and fname not in skip and len(fname) == 13:
            date_files.append(fname.replace('.json', ''))

    date_files.sort(reverse=True)
    date_files = date_files[:90]

    summary_list = []
    for date_str in date_files:
        data = load_daily_data(date_str)
        if not data:
            continue
        rankings = data.get('rankings', [])
        if not rankings:
            continue

        count = len(rankings)
        avg_rate = sum(r.get('change_rate', 0) for r in rankings) / count if count else 0
        limit_up = sum(1 for r in rankings if r.get('change_rate', 0) >= 29.9)
        total_volume = sum(r.get('trading_value', 0) for r in rankings)

        # topSectors: 종목 수 기준 상위 10개 섹터명
        sector_counts = {}
        for r in rankings:
            sec = r.get('sector', '')
            if sec:
                sector_counts[sec] = sector_counts.get(sec, 0) + 1
        top_sectors = sorted(sector_counts.keys(), key=lambda s: sector_counts[s], reverse=True)[:10]

        # topThemes: 테마 태그 빈도 상위 10개
        theme_counts = {}
        for r in rankings:
            tag = r.get('theme_tag', '')
            if not tag:
                continue
            for t in tag.replace('/', ',').split(','):
                t = t.strip()
                if t:
                    theme_counts[t] = theme_counts.get(t, 0) + 1
        top_themes = sorted(theme_counts.keys(), key=lambda t: theme_counts[t], reverse=True)[:10]

        summary_list.append({
            'date': date_str,
            'count': count,
            'avgRate': round(avg_rate, 2),
            'limitUp': limit_up,
            'totalVolume': total_volume,
            'topSectors': top_sectors,
            'topThemes': top_themes,
        })

    path = os.path.join(DATA_DIR, 'summary.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(summary_list, f, ensure_ascii=False, indent=2)
    logger.info(f"  summary.json 갱신: {len(summary_list)}개 날짜")


if __name__ == '__main__':
    update_summary_index()
