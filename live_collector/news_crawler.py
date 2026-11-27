"""네이버 증권 뉴스/섹터/업종등락률/증권사리포트 크롤링"""
import html
import random
import time
import logging
import re
from datetime import datetime

import requests
from bs4 import BeautifulSoup

from config import (
    USER_AGENTS,
    REQUEST_DELAY_MIN, REQUEST_DELAY_MAX,
)

logger = logging.getLogger(__name__)

NAVER_NEWS_IFRAME_URL = 'https://finance.naver.com/item/news_news.naver?code={ticker}&page=&clusterId='
NAVER_ITEM_MAIN_URL = 'https://finance.naver.com/item/main.naver?code={ticker}'
NAVER_RESEARCH_URL = 'https://finance.naver.com/research/company_list.naver?keyword=&brokerCode=&writeFromDate=&writeToDate=&searchType=itemCode&itemCode={ticker}&page=1'
NAVER_SECTOR_RISE_URL = 'https://finance.naver.com/sise/sise_group.naver?type=upjong'


def _get_headers():
    return {
        'User-Agent': random.choice(USER_AGENTS),
        'Referer': 'https://finance.naver.com/',
    }


def _request_with_retry(url, max_retries=3, timeout=10):
    for attempt in range(max_retries):
        try:
            resp = requests.get(url, headers=_get_headers(), timeout=timeout)
            resp.raise_for_status()
            return resp
        except requests.RequestException:
            if attempt < max_retries - 1:
                time.sleep(REQUEST_DELAY_MIN)
            else:
                logger.warning(f"  요청 실패 ({max_retries}회): {url}")
    return None


def _delay():
    time.sleep(random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX))


# ── 뉴스 크롤링 ──

# 스팸/노이즈 뉴스 필터
_SPAM_TITLE_PREFIXES = (
    '[서울데이터랩]', '서울데이터랩', '[데이터랩]',
    '오늘의 메모[', '오늘의메모[',
)
_SPAM_TITLE_KEYWORDS = (
    '서울데이터랩', '증시 상승률', '증시 하락률',
    '상승률 TOP', '하락률 TOP', '거래량 TOP',
)
_SPAM_SOURCES = {'서울신문'}


def _is_spam_article(title, source):
    """스팸/자동생성 뉴스 필터링"""
    for prefix in _SPAM_TITLE_PREFIXES:
        if title.startswith(prefix):
            return True
    for kw in _SPAM_TITLE_KEYWORDS:
        if kw in title:
            return True
    if source in _SPAM_SOURCES:
        return True
    return False


def _article_priority(title, stock_name=''):
    """기사 우선순위 점수 (높을수록 좋은 기사)
    [특징주], 종목명 포함 기사를 우선 수집
    """
    score = 0
    if stock_name and stock_name in title:
        score += 10  # 종목명 직접 언급
    if '[특징주]' in title or '특징주' in title:
        score += 5  # 특징주 태깅 기사
    if title.startswith('[') and ']' in title[:15]:
        score += 1  # 태그 있는 기사 (보통 더 정제됨)
    return score


NAVER_STOCK_NEWS_API_URL = 'https://api.stock.naver.com/news/stock/{ticker}?pageSize={size}'
NEWS_MAX_AGE_DAYS = 10   # 수집일 기준 이보다 오래된 기사는 사유 근거에서 제외(없으면 원본 유지)


def _api_news_candidates(ticker, stock_name='', date_str='', page_size=20):
    """api.stock.naver.com 종목뉴스(JSON) → crawl_news 후보 형식.

    2026-09-18 이후 finance.naver.com 뉴스 iframe(HTML)이 0건을 돌려줘
    전 종목 사유가 '거래량 증가'로 떨어졌다. whyrise 가 같은 Actions 환경에서
    정상 수신 중인 JSON API 를 1순위로 쓴다.
    """
    url = NAVER_STOCK_NEWS_API_URL.format(ticker=ticker, size=page_size)
    try:
        resp = requests.get(url, headers={
            'User-Agent': random.choice(USER_AGENTS),
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://m.stock.naver.com/',
        }, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, ValueError) as e:
        logger.warning(f"  뉴스 API 실패 ({ticker}): {e}")
        return []

    items = []
    if isinstance(data, list):
        for grp in data:
            if isinstance(grp, dict) and isinstance(grp.get('items'), list):
                items.extend(grp['items'])
            elif isinstance(grp, dict) and 'title' in grp:
                items.append(grp)
    elif isinstance(data, dict):
        for k in ('items', 'news', 'list'):
            if isinstance(data.get(k), list):
                items.extend(data[k])

    out = []
    seen = set()
    for it in items:
        title = html.unescape(str(it.get('title') or '')).strip()
        title = re.sub(r'<[^>]+>', '', title)
        source = str(it.get('officeName') or '').strip()
        if not title or title in seen or _is_spam_article(title, source):
            continue
        seen.add(title)
        office, article = it.get('officeId'), it.get('articleId')
        link = f'https://n.news.naver.com/mnews/article/{office}/{article}' if office and article else ''
        dt = str(it.get('datetime') or '')
        art_date = f'{dt[:4]}.{dt[4:6]}.{dt[6:8]}' if len(dt) >= 8 and dt[:8].isdigit() else ''
        out.append({
            'title': title,
            'link': link,
            'source': source,
            'date': art_date or date_str,
            '_priority': _article_priority(title, stock_name),
        })

    # 수집일 기준 오래된 기사 제외 — 단, 전부 오래됐으면 원본 유지(기존 HTML 경로와 동일한 관대함)
    if date_str and len(date_str) == 8 and date_str.isdigit():
        try:
            base = datetime.strptime(date_str, '%Y%m%d')
            recent = [a for a in out if a['date'][:10].count('.') == 2 and
                      0 <= (base - datetime.strptime(a['date'][:10], '%Y.%m.%d')).days <= NEWS_MAX_AGE_DAYS]
            if recent:
                out = recent
        except ValueError:
            pass
    return out


def _finalize_articles(candidates, max_articles):
    # 우선순위 정렬: [특징주]+종목명 포함 기사를 상위로 (안정 정렬 → 동점은 최신순 유지)
    candidates.sort(key=lambda a: a['_priority'], reverse=True)
    return [{'title': a['title'], 'link': a['link'], 'source': a['source'], 'date': a['date']}
            for a in candidates[:max_articles]]


def crawl_news(ticker, max_articles=10, stock_name='', date_str=''):
    """단일 종목의 최근 뉴스 크롤링 (제목, 링크, 출처, 날짜)

    1순위 api.stock.naver.com JSON, 0건이면 finance.naver.com HTML(구 경로)로 폴백.

    Args:
        ticker: 종목코드
        max_articles: 최대 기사 수
        stock_name: 종목명 (우선순위 정렬용)
        date_str: 수집일 YYYYMMDD (기사에 기록)
    """
    api_candidates = _api_news_candidates(ticker, stock_name=stock_name, date_str=date_str)
    if api_candidates:
        return _finalize_articles(api_candidates, max_articles)

    url = NAVER_NEWS_IFRAME_URL.format(ticker=ticker)
    resp = _request_with_retry(url)
    if resp is None:
        return []

    soup = BeautifulSoup(resp.text, 'html.parser')
    candidates = []
    seen_titles = set()

    # 날짜 추출 시도 (Naver Finance는 td.date에 YYYY.MM.DD 형식)
    rows = soup.select('table.type5 tr')
    for row in rows:
        title_tag = row.select_one('td.title a')
        source_tag = row.select_one('td.info')
        date_tag = row.select_one('td.date')

        if title_tag:
            title = title_tag.get_text(strip=True)
            if not title or title in seen_titles:
                continue
            seen_titles.add(title)

            source = source_tag.get_text(strip=True) if source_tag else ''

            # 스팸 필터링
            if _is_spam_article(title, source):
                continue

            link = title_tag.get('href', '')
            if link and not link.startswith('http'):
                link = 'https://finance.naver.com' + link

            # 날짜 추출
            article_date = ''
            if date_tag:
                raw_date = date_tag.get_text(strip=True)
                # "2026.04.15 09:30" → "2026.04.15"
                article_date = raw_date[:10] if len(raw_date) >= 10 else raw_date

            candidates.append({
                'title': title,
                'link': link,
                'source': source,
                'date': article_date or date_str,
                '_priority': _article_priority(title, stock_name),
            })

    # 우선순위 정렬 + 상위 max_articles개만 선택, _priority 필드 제거
    return _finalize_articles(candidates, max_articles)


def crawl_news_for_tickers(tickers, date_str, stock_names=None):
    """복수 종목의 뉴스를 일괄 크롤링

    Args:
        tickers: 종목코드 리스트
        date_str: 수집일 YYYYMMDD
        stock_names: {ticker: name} 딕셔너리 (우선순위 정렬용)
    """
    news_map = {}
    total = len(tickers)
    names = stock_names or {}

    for idx, ticker in enumerate(tickers):
        try:
            articles = crawl_news(ticker, stock_name=names.get(ticker, ''), date_str=date_str)
            news_map[ticker] = articles
            if (idx + 1) % 20 == 0:
                logger.info(f"  뉴스 수집 진행: {idx + 1}/{total}")
        except Exception as e:
            logger.warning(f"  뉴스 크롤링 실패 ({ticker}): {e}")
            news_map[ticker] = []

        _delay()

    return news_map


# ── 섹터 크롤링 ──

def crawl_sector(ticker):
    """단일 종목의 업종/섹터 정보 크롤링"""
    url = NAVER_ITEM_MAIN_URL.format(ticker=ticker)
    resp = _request_with_retry(url)
    if resp is None:
        return ''

    soup = BeautifulSoup(resp.text, 'html.parser')

    sector_links = soup.select('a[href*="/sise/sise_group"]')
    for link in sector_links:
        text = link.get_text(strip=True)
        if text and not any(kw in text for kw in ['PER', 'PBR', '차트', '업종']):
            return text

    _delay()
    return ''


# ── 업종 등락률 크롤링 (동적 테마 가중치용) ──

def crawl_sector_performance():
    """네이버 증권 업종별 등락률 크롤링

    Returns:
        dict: { '반도체': 2.5, 'AI': 1.3, ... } (등락률 %)
    """
    resp = _request_with_retry(NAVER_SECTOR_RISE_URL)
    if resp is None:
        return {}

    soup = BeautifulSoup(resp.text, 'html.parser')
    sector_perf = {}

    rows = soup.select('table.type_1 tr')
    for row in rows:
        cols = row.select('td')
        if len(cols) < 2:
            continue

        name_tag = cols[0].select_one('a')
        if not name_tag:
            continue

        name = name_tag.get_text(strip=True)
        change_text = cols[1].get_text(strip=True).replace('%', '').replace('+', '')

        try:
            change_rate = float(change_text)
            sector_perf[name] = change_rate
        except (ValueError, TypeError):
            continue

    logger.info(f"  업종 등락률: {len(sector_perf)}개 업종 수집")
    return sector_perf


# ── 증권사 리포트 크롤링 ──

def crawl_analyst_report(ticker):
    """단일 종목의 최근 증권사 리포트 크롤링

    Returns:
        list[dict]: [{'broker': str, 'title': str, 'opinion': str, 'target_price': int, 'date': str}]
    """
    url = NAVER_RESEARCH_URL.format(ticker=ticker)
    resp = _request_with_retry(url)
    if resp is None:
        return []

    soup = BeautifulSoup(resp.text, 'html.parser')
    reports = []

    rows = soup.select('table.type_1 tr')
    for row in rows:
        if len(reports) >= 5:
            break

        cols = row.select('td')
        if len(cols) < 5:
            continue

        title_tag = cols[1].select_one('a')
        if not title_tag:
            continue

        title = title_tag.get_text(strip=True)
        broker = cols[0].get_text(strip=True)
        opinion = cols[2].get_text(strip=True)
        target_text = cols[3].get_text(strip=True).replace(',', '')
        date = cols[4].get_text(strip=True)

        target_price = 0
        try:
            target_price = int(re.sub(r'[^\d]', '', target_text))
        except (ValueError, TypeError):
            pass

        if title:
            reports.append({
                'broker': broker,
                'title': title,
                'opinion': opinion,
                'target_price': target_price,
                'date': date,
            })

    return reports


def crawl_analyst_reports_for_tickers(tickers):
    """복수 종목의 증권사 리포트 일괄 크롤링"""
    report_map = {}
    total = len(tickers)

    for idx, ticker in enumerate(tickers):
        try:
            reports = crawl_analyst_report(ticker)
            report_map[ticker] = reports
            if (idx + 1) % 20 == 0:
                logger.info(f"  리포트 수집 진행: {idx + 1}/{total}")
        except Exception as e:
            logger.warning(f"  리포트 크롤링 실패 ({ticker}): {e}")
            report_map[ticker] = []

        _delay()

    return report_map


# ── 기사 본문 수집 (테마 추출용) ──

def _to_naver_news_url(finance_link):
    """finance.naver.com 링크를 n.news.naver.com URL로 변환"""
    m = re.search(r'article_id=(\d+).*?office_id=(\d+)', finance_link)
    if m:
        return f'https://n.news.naver.com/mnews/article/{m.group(2)}/{m.group(1)}'
    return finance_link


def fetch_article_body(url):
    """뉴스 기사 본문 텍스트 가져오기"""
    resp = _request_with_retry(url, timeout=10)
    if resp is None:
        return ''

    soup = BeautifulSoup(resp.text, 'html.parser')
    body = soup.select_one('#dic_area') or soup.select_one('.newsct_article')
    if body:
        return body.get_text(separator='\n', strip=True)
    return ''


def fetch_article_bodies_for_themes(news_map, max_per_stock=2):
    """테마 추출을 위한 기사 본문 일괄 수집 (URL 중복 제거)

    Args:
        news_map: {ticker: [article, ...]}
        max_per_stock: 종목당 최대 기사 수

    Returns:
        {ticker: [body_text, ...]}
    """
    COMP_KEYWORDS = ['관련주', '테마', '종합', '시황', '마감', '상한가', '급등', '강세']

    # Step 1: 종목별 기사 선정 (종합 기사 우선)
    ticker_urls = {}
    all_urls = set()

    for ticker, articles in news_map.items():
        scored = []
        for a in articles:
            title = a.get('title', '')
            comp_score = sum(1 for kw in COMP_KEYWORDS if kw in title)
            scored.append((comp_score, a))
        scored.sort(key=lambda x: x[0], reverse=True)

        urls = []
        for _, a in scored[:max_per_stock]:
            naver_url = _to_naver_news_url(a.get('link', ''))
            urls.append(naver_url)
            all_urls.add(naver_url)
        ticker_urls[ticker] = urls

    logger.info(f"  기사 본문 수집: {len(all_urls)}개 고유 URL")

    # Step 2: 고유 URL만 fetch
    body_cache = {}
    fetched = 0
    for url in all_urls:
        try:
            body = fetch_article_body(url)
            body_cache[url] = body
        except Exception:
            body_cache[url] = ''
        fetched += 1
        if fetched % 30 == 0:
            logger.info(f"  기사 본문 진행: {fetched}/{len(all_urls)}")
        _delay()

    # Step 3: ticker별 매핑
    result = {}
    for ticker, urls in ticker_urls.items():
        result[ticker] = [body_cache.get(u, '') for u in urls]

    logger.info(f"  기사 본문 수집 완료: {len(body_cache)}개 기사")
    return result


# ── 토스증권 AI 시그널 수집 ──

def crawl_toss_ai_signals():
    """토스증권 AI 상승 이유 수집 (Playwright)

    tossinvest.com 메인 페이지에서 ai-signals POST 응답을 캡처하여
    국내주식의 AI 생성 상승 이유를 추출한다.

    Returns:
        dict: {ticker: reason} 예: {'005930': '실적 모멘텀 부각', '000660': '반도체 업황 개선'}
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning("  playwright 미설치 → Toss AI 시그널 건너뜀")
        return {}

    domestic_signals = {}

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()

            def on_response(response):
                url = response.url
                if 'ai-signals' in url and response.status == 200 and 'detail' not in url:
                    try:
                        data = response.json()
                        for sig in data.get('result', {}).get('signals', []):
                            code = sig.get('productCode', '')
                            reason = sig.get('reasoningDescription', '')
                            # 국내주식: A + 6자리 숫자
                            if code.startswith('A') and len(code) == 7 and code[1:].isdigit():
                                domestic_signals[code[1:]] = reason
                    except Exception:
                        pass

            page.on('response', on_response)
            page.goto('https://tossinvest.com/', timeout=30000)
            page.wait_for_timeout(8000)
            browser.close()

    except Exception as e:
        logger.warning(f"  Toss AI 시그널 수집 실패: {e}")

    logger.info(f"  Toss AI 시그널: {len(domestic_signals)}개 국내 종목")
    return domestic_signals
