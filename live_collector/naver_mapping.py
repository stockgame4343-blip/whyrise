"""네이버 증권 테마/업종 API 매핑 빌드

네이버 공식 테마(263개)·업종(79개) API에서 종목 소속 정보를 가져와
ticker → [themes], ticker → industry 역매핑을 구축한다.
매일 수집 전 1회 빌드하고 naver_mapping.json에 캐시.
"""
import json
import os
import re
import time
import logging
from datetime import datetime

import requests

from config import COLLECTOR_DIR, THEME_KEYWORD_MATCH_BOOST, THEME_KEYWORD_PARTIAL_BOOST

logger = logging.getLogger(__name__)

MAPPING_PATH = os.path.join(COLLECTOR_DIR, 'naver_mapping.json')
BASE_URL = 'https://m.stock.naver.com/api/stocks'
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
PAGE_SIZE = 100
REQUEST_DELAY = 0.08  # 80ms between API calls


def _get_json(url, params=None):
    """GET 요청 → JSON 파싱. 실패 시 None."""
    try:
        r = requests.get(url, headers=HEADERS, params=params, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        logger.warning(f"API 실패: {url} — {e}")
        return None


def _fetch_all_groups(group_type):
    """테마 or 업종 전체 목록을 페이지네이션으로 가져온다.
    group_type: 'theme' | 'industry'
    Returns: [{no, name, totalCount, changeRate, ...}, ...]
    """
    all_groups = []
    page = 1
    while True:
        data = _get_json(f'{BASE_URL}/{group_type}', {'page': page, 'pageSize': PAGE_SIZE})
        if not data or 'groups' not in data:
            break
        all_groups.extend(data['groups'])
        if len(all_groups) >= data.get('totalCount', 0):
            break
        page += 1
        time.sleep(REQUEST_DELAY)
    return all_groups


def _fetch_group_stocks(group_type, group_no):
    """특정 테마/업종의 소속 종목 ticker 리스트를 가져온다.
    Returns: [ticker, ...]
    """
    tickers = []
    page = 1
    while True:
        data = _get_json(
            f'{BASE_URL}/{group_type}/{group_no}',
            {'page': page, 'pageSize': PAGE_SIZE},
        )
        if not data or 'stocks' not in data:
            break
        for s in data['stocks']:
            tickers.append(s['itemCode'])
        if len(tickers) >= data.get('totalCount', 0):
            break
        page += 1
        time.sleep(REQUEST_DELAY)
    return tickers


def build_mapping():
    """테마/업종 전체 매핑을 빌드하고 저장한다.

    Returns:
        dict: {
            'built_date': 'YYYYMMDD',
            'themes': {ticker: [{no, name}, ...]},        # 종목→테마 역매핑
            'industries': {ticker: {no, name}},            # 종목→업종
            'theme_list': [{no, name, totalCount, changeRate}, ...],  # 테마 목록 (당일 등락률 포함)
            'industry_list': [{no, name, totalCount, changeRate}, ...],
        }
    """
    logger.info("=== 네이버 매핑 빌드 시작 ===")

    # ── 1. 테마 목록 ──
    theme_groups = _fetch_all_groups('theme')
    logger.info(f"  테마 {len(theme_groups)}개 로드")

    # ── 2. 테마별 종목 → 역매핑 ──
    theme_map = {}  # ticker → [{no, name}, ...]
    for i, tg in enumerate(theme_groups):
        tickers = _fetch_group_stocks('theme', tg['no'])
        for t in tickers:
            if t not in theme_map:
                theme_map[t] = []
            theme_map[t].append({'no': tg['no'], 'name': tg['name']})
        if (i + 1) % 50 == 0:
            logger.info(f"  테마 진행: {i + 1}/{len(theme_groups)}")
        time.sleep(REQUEST_DELAY)
    logger.info(f"  테마 매핑 완료: {len(theme_map)}개 종목")

    # ── 3. 업종 목록 ──
    industry_groups = _fetch_all_groups('industry')
    logger.info(f"  업종 {len(industry_groups)}개 로드")

    # ── 4. 업종별 종목 → 역매핑 ──
    industry_map = {}  # ticker → {no, name}
    for i, ig in enumerate(industry_groups):
        tickers = _fetch_group_stocks('industry', ig['no'])
        for t in tickers:
            industry_map[t] = {'no': ig['no'], 'name': ig['name']}
        if (i + 1) % 20 == 0:
            logger.info(f"  업종 진행: {i + 1}/{len(industry_groups)}")
        time.sleep(REQUEST_DELAY)
    logger.info(f"  업종 매핑 완료: {len(industry_map)}개 종목")

    # ── 5. 저장 ──
    mapping = {
        'built_date': datetime.now().strftime('%Y%m%d'),
        'themes': theme_map,
        'industries': industry_map,
        'theme_list': [
            {'no': g['no'], 'name': g['name'], 'totalCount': g['totalCount'],
             'changeRate': g.get('changeRate', '0')}
            for g in theme_groups
        ],
        'industry_list': [
            {'no': g['no'], 'name': g['name'], 'totalCount': g['totalCount'],
             'changeRate': g.get('changeRate', '0')}
            for g in industry_groups
        ],
    }

    with open(MAPPING_PATH, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    logger.info(f"=== 매핑 저장 완료: {MAPPING_PATH} ===")
    return mapping


def load_mapping(date_str=None):
    """캐시된 매핑을 로드한다. 당일 빌드가 없으면 새로 빌드.

    Args:
        date_str: 'YYYYMMDD' — 이 날짜와 built_date가 같으면 캐시 사용

    Returns:
        dict: 매핑 데이터
    """
    if date_str is None:
        date_str = datetime.now().strftime('%Y%m%d')

    if os.path.exists(MAPPING_PATH):
        try:
            with open(MAPPING_PATH, 'r', encoding='utf-8') as f:
                mapping = json.load(f)
            if mapping.get('built_date') == date_str:
                logger.info(f"매핑 캐시 사용 (built: {date_str})")
                return mapping
            logger.info(f"매핑 캐시 만료 (built: {mapping.get('built_date')}, need: {date_str})")
        except Exception as e:
            logger.warning(f"매핑 캐시 로드 실패: {e}")

    return build_mapping()


def get_theme_rates():
    """당일 테마별 등락률을 API에서 가져온다 (실시간).
    Returns: {theme_no: float(changeRate)}
    """
    theme_groups = _fetch_all_groups('theme')
    rates = {}
    for tg in theme_groups:
        try:
            rates[tg['no']] = float(tg.get('changeRate', '0'))
        except (ValueError, TypeError):
            rates[tg['no']] = 0.0
    return rates


def _theme_name_core(name):
    """테마명에서 괄호 속 부연·공백 제거한 핵심부 (매칭용)."""
    return re.sub(r'\(.*?\)', '', name or '').strip()


def _shared_substring(a, b, min_len=3):
    """a 와 b 에 공통으로 등장하는 min_len 이상의 substring 이 있는지."""
    if not a or not b or len(a) < min_len or len(b) < min_len:
        return False
    for i in range(len(a) - min_len + 1):
        if a[i:i + min_len] in b:
            return True
    return False


def _score_theme_keyword_match(theme_name, keywords):
    """테마명이 키워드 중 어느 것과 매칭되는지 판단.

    Returns:
        ('exact' | 'partial' | None): 매칭 강도
    """
    if not keywords:
        return None
    core = _theme_name_core(theme_name)
    if not core:
        return None
    core_l = core.lower()
    for kw in keywords:
        if not kw or len(kw) < 2:
            continue
        kw_l = kw.lower()
        # 정확 매칭: 완전 일치 또는 한쪽이 다른쪽을 포함 (3자 이상)
        if kw_l == core_l:
            return 'exact'
        if len(kw_l) >= 3 and kw_l in core_l:
            return 'exact'
        if len(core_l) >= 3 and core_l in kw_l:
            return 'exact'
    # 정확 매칭 없으면 부분 매칭 (3자 공통 substring)
    for kw in keywords:
        if not kw or len(kw) < 3:
            continue
        if _shared_substring(kw.lower(), core_l, min_len=3):
            return 'partial'
    return None


def resolve_themes(ticker, mapping, theme_rates=None, stock_keywords=None):
    """종목의 테마를 매핑에서 조회하고 (키워드 매칭 + 당일 등락률) 순으로 정렬.

    Args:
        ticker: 종목코드
        mapping: load_mapping() 결과
        theme_rates: {theme_no: changeRate} — 없으면 mapping 내 theme_list 사용
        stock_keywords: 해당 종목 뉴스에서 추출한 테마 키워드 목록.
            매핑 테마명과 정확/부분 매칭되면 sort_score 에 가중치(config 상수) 가산.
            실제 상승 원인과 거리 먼 네이버 매핑을 억제하는 핵심 로직.

    Returns:
        list: [{'no': int, 'name': str, 'changeRate': float,
                'keyword_match': 'exact'|'partial'|None, 'sort_score': float}, ...]
            정렬 기준: keyword_match(exact>partial>None) → sort_score(등락률+boost) 내림차순
    """
    themes = mapping.get('themes', {}).get(ticker, [])
    if not themes:
        return []

    # 등락률 매핑
    if theme_rates is None:
        theme_rates = {}
        for tl in mapping.get('theme_list', []):
            try:
                theme_rates[tl['no']] = float(tl.get('changeRate', '0'))
            except (ValueError, TypeError):
                theme_rates[tl['no']] = 0.0

    result = []
    for th in themes:
        rate = theme_rates.get(th['no'], 0.0)
        match = _score_theme_keyword_match(th['name'], stock_keywords or [])
        if match == 'exact':
            boost = THEME_KEYWORD_MATCH_BOOST
        elif match == 'partial':
            boost = THEME_KEYWORD_PARTIAL_BOOST
        else:
            boost = 0.0
        result.append({
            'no': th['no'],
            'name': th['name'],
            'changeRate': rate,
            'keyword_match': match,
            'sort_score': rate + boost,
        })

    # 정렬: 정확 매칭 > 부분 매칭 > 매칭 없음. 같은 그룹 안에서는 sort_score 내림차순
    _match_rank = {'exact': 2, 'partial': 1, None: 0}
    result.sort(
        key=lambda x: (_match_rank.get(x['keyword_match'], 0), x['sort_score']),
        reverse=True,
    )
    return result


def resolve_industry(ticker, mapping):
    """종목의 업종을 매핑에서 조회.
    Returns: str (업종명) or ''
    """
    ind = mapping.get('industries', {}).get(ticker, {})
    return ind.get('name', '')


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    mapping = build_mapping()
    print(f"\n테마 매핑: {len(mapping['themes'])}개 종목")
    print(f"업종 매핑: {len(mapping['industries'])}개 종목")
    print(f"테마 목록: {len(mapping['theme_list'])}개")
    print(f"업종 목록: {len(mapping['industry_list'])}개")
