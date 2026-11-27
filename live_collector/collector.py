"""데이터 수집 파이프라인 v4 — 네이버 테마/업종 매핑 기반 대장점수"""
import logging
import requests
from datetime import datetime, timedelta

from config import TOP_N, USER_AGENTS, LEADER_HISTORY_DAYS, ALLOWED_STOCK_END_TYPES
from json_store import (
    save_daily_data, load_daily_data, update_dates_index, cleanup_old_data,
    update_summary_index,
    load_sector_cache, save_sector_cache,
    load_news_history, update_news_history,
    append_backtest_data,
    get_cached_theme_tags, update_theme_cache,
    load_tag_overrides, load_tag_feedback,
)
from news_crawler import (
    crawl_news_for_tickers, crawl_sector,
    crawl_sector_performance, crawl_analyst_reports_for_tickers,
    fetch_article_bodies_for_themes,
    crawl_toss_ai_signals,
)
from scorer import calculate_daejang_score, generate_rise_reason, calculate_trading_intensity, extract_theme_tag, extract_theme_from_reason, extract_news_keywords, load_user_bad_tags
from forward_score import calculate_forward_score
from naver_mapping import load_mapping, resolve_themes, resolve_industry, get_theme_rates
from pullback_snapshot import build_snapshot as build_pullback_snapshot

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

NAVER_STOCK_UP_URL = 'https://m.stock.naver.com/api/stocks/up/{market}?page=1&pageSize={size}'
HEADERS = {'User-Agent': USER_AGENTS[0]}


def _parse_raw(value):
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(str(value).replace(',', ''))
    except (ValueError, TypeError):
        return 0


def collect_naver_rising_stocks():
    """네이버 증권 API에서 코스피+코스닥 상승 종목을 가져온다.

    ALLOWED_STOCK_END_TYPES 에 포함된 stockEndType 만 통과시킨다
    (기본값 ('stock',) 이면 일반 주식만 수집, ETF/ETN/REIT/SPAC 등은 제외).
    """
    logger.info("[1/9] 네이버 증권 상승 종목 수집")
    all_stocks = []
    excluded_by_type = {}  # {excluded_type: count}

    for market in ['KOSPI', 'KOSDAQ']:
        url = NAVER_STOCK_UP_URL.format(market=market, size=TOP_N)
        try:
            resp = requests.get(url, headers=HEADERS, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            stocks = data.get('stocks', [])
            logger.info(f"  {market}: {len(stocks)}개 조회")

            for s in stocks:
                end_type = (s.get('stockEndType') or '').lower()
                if ALLOWED_STOCK_END_TYPES and end_type not in ALLOWED_STOCK_END_TYPES:
                    excluded_by_type[end_type or 'unknown'] = excluded_by_type.get(end_type or 'unknown', 0) + 1
                    continue
                all_stocks.append({
                    'ticker': s.get('itemCode', ''),
                    'name': s.get('stockName', ''),
                    'market': market,
                    'close_price': _parse_raw(s.get('closePriceRaw', s.get('closePrice'))),
                    'change_amount': _parse_raw(s.get('compareToPreviousClosePriceRaw', s.get('compareToPreviousClosePrice'))),
                    'change_rate': float(s.get('fluctuationsRatio', 0)),
                    'trading_value': _parse_raw(s.get('accumulatedTradingValueRaw', 0)),
                    'market_cap': _parse_raw(s.get('marketValueRaw', 0)),
                })
        except Exception as e:
            logger.error(f"  {market} 수집 실패: {e}")

    if excluded_by_type:
        summary = ', '.join(f"{k}={v}" for k, v in sorted(excluded_by_type.items()))
        logger.info(f"  비주식 제외: {summary} (whitelist={list(ALLOWED_STOCK_END_TYPES)})")

    all_stocks.sort(key=lambda x: x['change_rate'], reverse=True)
    top = all_stocks[:TOP_N]
    logger.info(f"  상위 {len(top)}개 추출 완료")
    return top


def collect_trading_data(tickers):
    """5일 거래대금 평균 + 기관/외인 수급 + 회전율 산출"""
    logger.info("[2/9] 거래 강도 데이터 수집 (5일평균 + 수급)")

    trading_data = {}

    try:
        from pykrx import stock as pykrx_stock
        from datetime import timedelta
        today = datetime.now()
        start = (today - timedelta(days=14)).strftime('%Y%m%d')
        end = today.strftime('%Y%m%d')

        for idx, t in enumerate(tickers):
            try:
                # OHLCV (거래대금)
                df = pykrx_stock.get_market_ohlcv_by_date(start, end, t)
                if df.empty or len(df) < 2:
                    trading_data[t] = _default_trading_data()
                    continue

                vals = df['거래대금'].tolist()
                today_val = vals[-1]
                avg_5day = sum(vals[-6:-1]) / min(len(vals) - 1, 5) if len(vals) >= 2 else vals[-1]

                # 투자자별 순매수 (기관/외인)
                inst_net = 0
                foreign_net = 0
                try:
                    inv_df = pykrx_stock.get_market_trading_value_by_date(
                        (today - timedelta(days=3)).strftime('%Y%m%d'),
                        end, t
                    )
                    if not inv_df.empty:
                        last_row = inv_df.iloc[-1]
                        inst_net = int(last_row.get('기관합계', 0))
                        foreign_net = int(last_row.get('외국인합계', 0))
                except Exception:
                    pass

                # 상한가 체크 (등락률 29.5% 이상)
                close_prices = df['종가'].tolist()
                is_limit_up = False
                if len(close_prices) >= 2:
                    prev_close = close_prices[-2]
                    if prev_close > 0:
                        day_change = (close_prices[-1] - prev_close) / prev_close * 100
                        is_limit_up = day_change >= 29.5

                trading_data[t] = {
                    'today_value': today_val,
                    'avg_5day': avg_5day,
                    'inst_net': inst_net,
                    'foreign_net': foreign_net,
                    'is_limit_up': is_limit_up,
                }
            except Exception:
                trading_data[t] = _default_trading_data()

            if (idx + 1) % 20 == 0:
                logger.info(f"  거래 데이터 진행: {idx + 1}/{len(tickers)}")

    except ImportError:
        logger.warning("  pykrx 미설치 — 기본값 사용")
        for t in tickers:
            trading_data[t] = _default_trading_data()

    return trading_data


def _default_trading_data():
    return {
        'today_value': 0,
        'avg_5day': 0,
        'inst_net': 0,
        'foreign_net': 0,
        'is_limit_up': False,
    }


def calculate_turnover_ranks(top_stocks, trading_data):
    """시총 대비 회전율 백분위 계산"""
    turnover_list = []
    for s in top_stocks:
        t = s['ticker']
        td = trading_data.get(t, {})
        cap = s.get('market_cap', 0)
        today_val = td.get('today_value', 0)
        turnover = (today_val / cap * 100) if cap > 0 else 0
        turnover_list.append((t, turnover))

    turnover_list.sort(key=lambda x: x[1], reverse=True)

    rank_map = {}
    total = len(turnover_list)
    for rank, (ticker, _) in enumerate(turnover_list):
        rank_map[ticker] = round(rank / total * 100) if total > 0 else 50

    return rank_map


def collect_sectors(tickers):
    """섹터 정보 (캐시 우선)"""
    logger.info("[3/9] 섹터 정보 수집")
    cached = load_sector_cache()
    missing = [t for t in tickers if t not in cached]

    if missing:
        logger.info(f"  캐시 미스 {len(missing)}개 → 크롤링")
        for t in missing:
            sector = crawl_sector(t)
            cached[t] = sector
        save_sector_cache(cached)

    return cached


def collect_52w_highs(tickers, date_str=None):
    """52주 최고가 및 달성일 수집 + 당일 장중 고점/저점 추출 (차트 API)

    date_str: YYYYMMDD. None 이면 오늘 기준.
    리턴: {ticker: {price, date, today_high, today_low}}
    """
    import time
    from datetime import timedelta
    logger.info("[4/9] 52주 최고가 수집")

    end_date = datetime.now().strftime('%Y%m%d')
    start_date = (datetime.now() - timedelta(days=365)).strftime('%Y%m%d')
    target_date = date_str or end_date
    high_52w_map = {}

    for idx, t in enumerate(tickers):
        try:
            url = f'https://api.stock.naver.com/chart/domestic/item/{t}/day?startDateTime={start_date}&endDateTime={end_date}'
            resp = requests.get(url, headers=HEADERS, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            if data:
                max_entry = max(data, key=lambda x: x.get('highPrice', 0))
                today_entry = next((x for x in data if x.get('localDate') == target_date), None)
                high_52w_map[t] = {
                    'price': int(max_entry.get('highPrice', 0)),
                    'date': max_entry.get('localDate', ''),
                    'today_high': int(today_entry.get('highPrice', 0)) if today_entry else 0,
                    'today_low': int(today_entry.get('lowPrice', 0)) if today_entry else 0,
                }
            else:
                high_52w_map[t] = {'price': 0, 'date': '', 'today_high': 0, 'today_low': 0}
        except Exception:
            high_52w_map[t] = {'price': 0, 'date': '', 'today_high': 0, 'today_low': 0}

        if (idx + 1) % 20 == 0:
            logger.info(f"  52주 최고가 진행: {idx + 1}/{len(tickers)}")

        time.sleep(0.05)

    logger.info(f"  52주 최고가 수집 완료: {len(high_52w_map)}개")
    return high_52w_map


def collect_and_save(date_str=None, mode='closing'):
    """전체 수집 파이프라인 v4 — 네이버 매핑 기반
    mode: 'closing' = 장마감 최종 수집, 'intraday' = 장중 실시간
    """
    if date_str is None:
        date_str = datetime.now().strftime('%Y%m%d')

    logger.info(f"===== 수집 시작 v4: {date_str} =====")

    # Step 1: 네이버 상승 종목
    top_stocks = collect_naver_rising_stocks()
    if not top_stocks:
        logger.info("수집 종료 (상승 종목 없음 — 비거래일 가능)")
        return False

    tickers = [s['ticker'] for s in top_stocks]

    # Step 2: 거래 강도 데이터 (5일평균 + 수급)
    trading_data = collect_trading_data(tickers)
    turnover_ranks = calculate_turnover_ranks(top_stocks, trading_data)

    # Step 3: 네이버 매핑 로드 + 섹터/테마 (매핑 우선, 미스 시 기존 크롤링 fallback)
    logger.info("[3/11] 네이버 테마/업종 매핑 로드")
    naver_map = load_mapping(date_str)
    theme_rates = get_theme_rates()  # 당일 실시간 테마 등락률

    # 업종: 매핑 우선, 미스 시 기존 섹터 캐시 fallback
    sector_map = {}
    industry_no_map = {}  # ticker → 업종 번호
    unmapped_sector = []
    for t in tickers:
        ind_data = naver_map.get('industries', {}).get(t, {})
        if ind_data.get('name'):
            sector_map[t] = ind_data['name']
            industry_no_map[t] = ind_data.get('no')
        else:
            unmapped_sector.append(t)
    if unmapped_sector:
        logger.info(f"  업종 매핑 미스: {len(unmapped_sector)}개 → 기존 크롤링 fallback")
        fallback_sectors = collect_sectors(unmapped_sector)
        sector_map.update(fallback_sectors)

    # Step 4: 52주 최고가 + 당일 장중 고점/저점
    high_52w_map = collect_52w_highs(tickers, date_str)

    # Step 5: 뉴스
    logger.info("[5/9] 뉴스 수집")
    stock_names = {s['ticker']: s['name'] for s in top_stocks}
    news_map = crawl_news_for_tickers(tickers, date_str, stock_names=stock_names)

    # Step 6: 기사 본문 수집 (테마 추출용, 오버라이드 > 캐시 > 추출)
    logger.info("[6/9] 기사 본문 수집 (테마 추출)")

    # 사용자 피드백 로드 (수동 수정 + 잘못된 태그 학습)
    feedback = load_tag_feedback()
    user_overrides = feedback.get('overrides', {})
    user_bad_tags = feedback.get('bad_tags', [])
    load_user_bad_tags(user_bad_tags)  # scorer에 반영

    # tag_overrides.json (레거시) + 피드백 오버라이드 병합
    tag_overrides = load_tag_overrides()
    tag_overrides.update(user_overrides)  # 피드백이 우선

    override_tickers = set(t for t in tickers if t in tag_overrides)
    remaining = [t for t in tickers if t not in override_tickers]
    if override_tickers:
        logger.info(f"  사용자 오버라이드: {len(override_tickers)}개")
    if user_bad_tags:
        logger.info(f"  학습된 bad_tags: {len(user_bad_tags)}개")

    cached_tags, uncached_tickers = get_cached_theme_tags(remaining, date_str)
    logger.info(f"  테마 캐시 히트: {len(cached_tags)}개, 미스: {len(uncached_tickers)}개")

    article_bodies_map = {}
    if uncached_tickers:
        uncached_news = {t: news_map.get(t, []) for t in uncached_tickers}
        article_bodies_map = fetch_article_bodies_for_themes(uncached_news)

    # Step 7: 업종 등락률 + 증권사 리포트
    logger.info("[7/10] 업종 등락률 + 증권사 리포트 수집")
    sector_performance = crawl_sector_performance()
    report_map = crawl_analyst_reports_for_tickers(tickers)

    # Step 8: 토스증권 AI 시그널 (1순위 상승 이유)
    logger.info("[8/10] 토스증권 AI 시그널 수집")
    toss_reasons = crawl_toss_ai_signals()

    # Step 9: 뉴스 이력 로드 + 갱신
    logger.info("[9/10] 뉴스 이력 갱신")
    news_history = load_news_history()
    update_news_history(date_str, news_map)

    # Step 10: 대장점수용 히스토리 로드 + 2-pass 구조
    logger.info("[10/11] 대장점수 산출 (2-pass)")

    # 최근 N일 데이터 로드 (연속출현 계산용)
    history_data = []
    for i in range(1, LEADER_HISTORY_DAYS + 1):
        prev_date = (datetime.now() - timedelta(days=i)).strftime('%Y%m%d')
        prev = load_daily_data(prev_date)
        if prev:
            history_data.append(prev)
    logger.info(f"  히스토리 로드: {len(history_data)}일")

    # ── Pass 1: 테마 태그 확정 + 기본 데이터 조립 ──
    resolved_stocks = []
    new_theme_tags = {}
    mapping_hit = 0
    mapping_miss = 0
    for idx, s in enumerate(top_stocks):
        t = s['ticker']
        news_articles = news_map.get(t, [])
        td = trading_data.get(t, _default_trading_data())

        # 거래 강도 레이블 (표시용)
        intensity_label, intensity_detail = calculate_trading_intensity(
            today_value=td['today_value'],
            avg_5day_value=td['avg_5day'],
            inst_net=td['inst_net'],
            foreign_net=td['foreign_net'],
            turnover_rank_pct=turnover_ranks.get(t, 50),
        )
        if td.get('is_limit_up'):
            intensity_label = '상한가'

        # ── 테마 태그: 네이버 매핑 + 뉴스 키워드 교차 매칭 ──
        # 1순위: 사용자 오버라이드
        # 2순위: 네이버 매핑 — 뉴스 키워드 매칭된 테마를 당일 등락률보다 우선
        # 3순위: 기존 뉴스 추출 fallback (매핑 미스 시)
        theme_tag = ''
        theme_tags = []  # [primary, secondary, ...]
        theme_no = None  # 네이버 테마 번호 (링크용)

        # 뉴스 키워드 추출 (매핑 교차용 + rise_reason grounding 용)
        article_bodies_for_stock = article_bodies_map.get(t, [])
        news_keywords = extract_news_keywords(
            news_articles, article_bodies_for_stock, stock_name=s['name']
        )

        if t in tag_overrides:
            theme_tag = tag_overrides[t]
            theme_tags = [theme_tag]
        else:
            # 네이버 매핑 조회 (뉴스 키워드로 교차 매칭)
            resolved = resolve_themes(t, naver_map, theme_rates, stock_keywords=news_keywords)
            if resolved:
                mapping_hit += 1
                theme_tags = [r['name'] for r in resolved[:2]]  # 최대 2개
                theme_tag = theme_tags[0]  # primary
                theme_no = resolved[0].get('no')  # primary 테마 번호
            else:
                mapping_miss += 1
                # fallback: 기존 방식 (캐시 > 뉴스 추출 > Toss)
                if t in cached_tags:
                    theme_tag = cached_tags[t]
                else:
                    theme_tag = extract_theme_tag(news_articles, article_bodies_for_stock, stock_name=s['name'])
                    new_theme_tags[t] = theme_tag
                if not theme_tag and t in toss_reasons:
                    theme_tag = extract_theme_from_reason(toss_reasons[t])
                    if theme_tag:
                        new_theme_tags[t] = theme_tag
                if not theme_tag:
                    theme_tag = extract_theme_from_reason(
                        generate_rise_reason(news_articles, report_map.get(t, []),
                                             theme_tag='', stock_name=s['name'],
                                             article_bodies=article_bodies_for_stock)
                    )
                if theme_tag:
                    theme_tags = [theme_tag]

        # 상승 이유 (우선순위: Toss AI > 뉴스 키워드 분석)
        reason_origin = 'rule'
        if t in toss_reasons:
            reason = toss_reasons[t]
            reason_origin = 'toss'
        else:
            reason = generate_rise_reason(news_articles, report_map.get(t, []),
                                          theme_tag=theme_tag, stock_name=s['name'],
                                          article_bodies=article_bodies_for_stock)

        resolved_stocks.append({
            'idx': idx,
            'ticker': t,
            'name': s['name'],
            'market': s['market'],
            'close_price': s['close_price'],
            'change_amount': s['change_amount'],
            'change_rate': s['change_rate'],
            'trading_value': s['trading_value'],
            'market_cap': s['market_cap'],
            'sector': sector_map.get(t, ''),
            'industry_no': industry_no_map.get(t),
            'high_52w': high_52w_map.get(t, {}).get('price', 0),
            'high_52w_date': high_52w_map.get(t, {}).get('date', ''),
            'high_price': high_52w_map.get(t, {}).get('today_high', 0),
            'low_price': high_52w_map.get(t, {}).get('today_low', 0),
            'theme_tag': theme_tag,
            'theme_tags': theme_tags,
            'theme_no': theme_no,
            'is_limit_up': td.get('is_limit_up', False),
            'intensity_label': intensity_label,
            'reason': reason,
            'reason_origin': reason_origin if reason != '거래량 증가' else 'fallback',
            'news': news_articles,
            'td': td,
        })

    logger.info(f"  매핑 히트: {mapping_hit}, 미스: {mapping_miss}")

    # ── 상승 이유 2차: 같은 날 기사 근거 (종목 기사 원인구절 > 신규상장 > 업종 동반 기사 > 테마 동반) ──
    # 키워드 템플릿('수주 공시' 등)은 종목과 무관한 기사에서 나오는 경우가 많아, 근거가 잡히면 교체한다.
    # Toss AI 사유는 유지. 근거가 끝내 없으면 템플릿을 남기되 reason_origin='rule' 로 표시(whyrise 가 재검증).
    try:
        from reason_extract import build_day_context, explain, should_replace, recent_hint, is_template_reason
        ctx_rows = [{'name': rs['name'], 'news': rs['news'], 'theme_tag': rs.get('theme_tag', ''),
                     'theme_tags': rs.get('theme_tags') or [], 'sector': rs.get('sector', ''),
                     'change_rate': rs.get('change_rate') or 0}
                    for rs in resolved_stocks]
        day_ctx = build_day_context(ctx_rows, date_str)
        upgraded = 0
        for rs, row in zip(resolved_stocks, ctx_rows):
            if rs.get('reason_origin') == 'toss':
                continue
            ex = explain(row, date_str, day_ctx)
            # 이미 구체적인 사유는 종목 자체 기사일 때만 교체 (업종·테마 동반으로 덮지 않음)
            if not should_replace(rs.get('reason', ''), ex):
                if not ex and is_template_reason(rs.get('reason', '')):
                    # 같은 날 근거가 없으면 최근 2주 종목 재료 기사(날짜 표기)를 '단서'로 남긴다
                    h = recent_hint(rs['name'], rs['news'], date_str)
                    if h:
                        rs['reason_hint'] = h
                continue
            rs['reason'] = ex['reason']
            rs['reason_origin'] = 'news'
            rs['reason_kind'] = ex.get('kind', '')
            rs['reason_confidence'] = ex.get('confidence', '')
            rs['reason_evidence'] = [
                {k: (it or {}).get(k, '') for k in ('title', 'link', 'source', 'date')}
                for it in (ex.get('evidence_items') or [])][:2]
            upgraded += 1
        logger.info(f"  기사 근거 사유: {upgraded}/{len(resolved_stocks)} (업종 원인 {len(day_ctx['sector_causes'])}건)")
    except Exception as e:  # 사유 보강 실패가 수집 전체를 막지 않게
        logger.warning(f"  기사 근거 사유 단계 실패: {e}")

    # ── 테마 그룹 빌드 (primary tag 기준) ──
    theme_groups = {}
    for rs in resolved_stocks:
        tag = rs.get('theme_tag', '')
        if tag:
            theme_groups.setdefault(tag, []).append(rs)

    logger.info(f"  테마 그룹: {len(theme_groups)}개 테마")

    # ── Pass 2: 대장점수 산출 + 최종 rankings 조립 ──
    logger.info("[11/11] 데이터 저장")
    rankings = []
    for rs in resolved_stocks:
        tag = rs.get('theme_tag', '')
        group = theme_groups.get(tag, [])
        td = rs['td']

        score_result = calculate_daejang_score(
            stock=rs,
            theme_group=group,
            td=td,
            history_data=history_data,
        )

        rankings.append({
            'rank': rs['idx'] + 1,
            'ticker': rs['ticker'],
            'name': rs['name'],
            'market': rs['market'],
            'close_price': rs['close_price'],
            'change_amount': rs['change_amount'],
            'change_rate': rs['change_rate'],
            'trading_value': rs['trading_value'],
            'market_cap': rs['market_cap'],
            'sector': rs['sector'],
            'industry_no': rs.get('industry_no'),
            'high_52w': rs['high_52w'],
            'high_52w_date': rs['high_52w_date'],
            'high_price': rs.get('high_price', 0),
            'low_price': rs.get('low_price', 0),
            'theme_tag': tag,
            'theme_tags': rs.get('theme_tags', [tag] if tag else []),
            'theme_no': rs.get('theme_no'),
            'avg_5day': td.get('avg_5day', 0),
            'inst_net': td.get('inst_net', 0),
            'foreign_net': td.get('foreign_net', 0),
            'score': score_result['total'],
            'score_detail': score_result['detail'],
            'rise_reason': rs['reason'],
            # toss=토스증권 AI 시그널, rule=뉴스 키워드 템플릿, fallback=근거 없음('거래량 증가')
            # whyrise 가 rule/fallback 만 같은 날 기사로 재검증한다.
            'reason_origin': rs.get('reason_origin', 'rule'),
            'reason_kind': rs.get('reason_kind', ''),
            'reason_confidence': rs.get('reason_confidence', ''),
            'reason_evidence': rs.get('reason_evidence', []),
            'reason_hint': rs.get('reason_hint') or None,
            'news': rs['news'],
        })

    # ─── forward_score (v2 — ML 분석 기반 미래 상승 가산점) ───
    # backtest_score.py 결과: 원본 score 대비 corr 0.28 → 0.29 약간 개선.
    # 가산점: small_size(0~6, 거래대금 작을수록) + consec_limit_up(0~5, 연속 상한가).
    # history_data 가 있으면 연속 상한가 카운트 가능.
    for entry, rs in zip(rankings, resolved_stocks):
        # rankings 의 dict 와 동일 ticker 의 collector 내부 stock 객체 매칭
        # forward_score.calculate_forward_score 는 close_price·trading_value·score 등 사용
        # stock_for_fwd 에 score 도 미리 주입 (기본 score 활용)
        stock_for_fwd = dict(entry)
        fwd = calculate_forward_score(
            stock_for_fwd,
            history_data=history_data,
            pullbacks=None,  # 본장 collector 는 풀백 미보유 — pullback_snapshot 별도 단계
        )
        entry['forward_score'] = fwd['forward_total']
        entry['forward_bonus'] = fwd['forward_bonus']
        entry['forward_detail'] = fwd['forward_detail']

    # 테마 캐시 갱신
    if new_theme_tags:
        update_theme_cache(date_str, new_theme_tags)

    # JSON 저장
    daily_data = {
        'date': date_str,
        'collected_at': datetime.now().isoformat(timespec='seconds'),
        'mode': mode,
        'is_final': mode == 'closing',
        'count': len(rankings),
        'version': 4,
        'rankings': rankings,
    }

    save_daily_data(date_str, daily_data)
    update_dates_index()
    update_summary_index()
    cleanup_old_data()

    # 백테스트 데이터 기록
    append_backtest_data(date_str, rankings)

    # 장마감(closing) 모드에서만 pullback 스냅샷 생성 후 재저장
    # (intraday 는 매 수집마다 덮어쓰면 노이즈 커서 제외)
    if mode == 'closing':
        try:
            import os
            data_dir = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                'public', 'data'
            )
            logger.info('pullback 스냅샷 생성 시작 (closing)')
            pullbacks = build_pullback_snapshot(date_str, data_dir, rankings)
            daily_data['pullbacks'] = pullbacks
            save_daily_data(date_str, daily_data)
            logger.info(f'pullback 스냅샷 저장 완료: {len(pullbacks)}개')
        except Exception as e:
            logger.error(f'pullback 스냅샷 실패: {e}')

    logger.info(f"===== 수집 완료 v4: {len(rankings)}개 종목 (네이버 매핑) =====")
    return True


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', default='closing', choices=['closing', 'intraday'])
    parser.add_argument('--date', default=None)
    args = parser.parse_args()
    collect_and_save(date_str=args.date, mode=args.mode)
