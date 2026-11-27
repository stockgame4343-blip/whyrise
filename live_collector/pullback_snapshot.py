"""급등 후 조정 pullback 스냅샷 생성 — report.js `analyzePullbacks` 파이썬 이식.

장마감 최종 수집(`mode=closing`) 시점에 과거 90일 rankings 를 훑어
- PEAK_PCT 이상 급등 또는 52주 신고가 돌파 종목 → 그날의 장중 고점을 peak 로 기록
- 당일 close_price 기준 고점 대비 DROP_PCT 이상 하락 종목을 pullback 으로 확정
- peak_date+1 ~ current_date 구간의 최저 lowPrice 대비 REBOUND_PCT 이상 반등 여부 체크

결과는 `public/data/YYYYMMDD.json` 의 `pullbacks` 필드에 저장되어,
클라이언트가 과거 날짜 조회 시 종목/고점/저점은 frozen 유지, 현재가만 실시간 재조회.
"""
import json
import logging
import os
import time

import requests

logger = logging.getLogger(__name__)

HEADERS = {'User-Agent': 'Mozilla/5.0'}

# report.js 와 동일한 상수 (backtest_pullback.py 결과 기반)
PEAK_PCT = 15
DROP_PCT = 20
REBOUND_PCT = 25
LOOKBACK_DAYS = 90


def _load_past_rankings(data_dir, current_date, days=LOOKBACK_DAYS):
    """current_date 이전 최신 N일 rankings 파일 로드."""
    files = sorted([
        f for f in os.listdir(data_dir)
        if f.endswith('.json') and len(f) == 13 and f.replace('.json', '').isdigit()
    ], reverse=True)
    past = []
    for fname in files:
        date = fname.replace('.json', '')
        if date >= current_date:
            continue
        try:
            with open(os.path.join(data_dir, fname), 'r', encoding='utf-8') as f:
                data = json.load(f)
            past.append({'date': date, 'rankings': data.get('rankings', [])})
        except Exception as e:
            logger.warning(f'  과거 JSON 로드 실패 {fname}: {e}')
            continue
        if len(past) >= days:
            break
    return past


def _load_prev_pullbacks(data_dir, current_date):
    """current_date 직전 거래일의 pullbacks 배열 (졸업 감지용). 없으면 []."""
    files = sorted([
        f for f in os.listdir(data_dir)
        if f.endswith('.json') and len(f) == 13 and f.replace('.json', '').isdigit()
    ], reverse=True)
    for fname in files:
        date = fname.replace('.json', '')
        if date >= current_date:
            continue
        try:
            with open(os.path.join(data_dir, fname), 'r', encoding='utf-8') as f:
                data = json.load(f)
            return data.get('pullbacks', []) or []
        except Exception as e:
            logger.warning(f'  직전 pullbacks 로드 실패 {fname}: {e}')
            continue
    return []


def _find_peak_stocks(past_rankings):
    """과거 30일 rankings 에서 급등/신고가 종목 → peakStocks {ticker: {..., peakPrice, peakDate}}."""
    peak_stocks = {}
    for entry in past_rankings:
        date = entry['date']
        for r in entry['rankings']:
            # 장중 고점 우선, 없으면 종가 폴백
            peak_val = r.get('high_price') or r.get('close_price', 0)
            if not peak_val or peak_val <= 0:
                continue
            change_rate = r.get('change_rate', 0) or 0
            high_52w = r.get('high_52w', 0) or 0

            dominated = change_rate >= PEAK_PCT
            hit_high = high_52w > 0 and peak_val >= high_52w
            if not dominated and not hit_high:
                continue

            ticker = r.get('ticker')
            if not ticker:
                continue
            existing = peak_stocks.get(ticker)
            if not existing or peak_val > existing['peakPrice']:
                peak_stocks[ticker] = {
                    'ticker': ticker,
                    'name': r.get('name', ''),
                    'market': r.get('market', ''),
                    'sector': r.get('sector', ''),
                    'peakPrice': int(peak_val),
                    'peakDate': date,
                    'reason': (
                        '+{:.1f}% 급등'.format(change_rate) if dominated else '52주 신고가'
                    ),
                }
    return peak_stocks


def _fetch_close_price(ticker, date_str):
    """date_str 의 close_price. chart API 단일 날짜 호출."""
    url = (
        f'https://api.stock.naver.com/chart/domestic/item/{ticker}/day'
        f'?startDateTime={date_str}&endDateTime={date_str}'
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json() or []
        for x in data:
            if x.get('localDate') == date_str:
                return int(x.get('closePrice') or 0)
        if data:
            return int(data[0].get('closePrice') or 0)
    except Exception as e:
        logger.warning(f'    close_price 실패 {ticker}: {e}')
    return 0


def _fetch_post_peak_low(ticker, peak_date, current_date):
    """peak_date+1 ~ current_date 구간 min(lowPrice). 없으면 None."""
    url = (
        f'https://api.stock.naver.com/chart/domestic/item/{ticker}/day'
        f'?startDateTime={peak_date}&endDateTime={current_date}'
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json() or []
        after = [x for x in data if (x.get('localDate') or '') > peak_date]
        if not after:
            return None
        lows = []
        for x in after:
            lo = x.get('lowPrice') or x.get('closePrice')
            if lo and lo > 0:
                lows.append(int(lo))
        return min(lows) if lows else None
    except Exception as e:
        logger.warning(f'    post-peak-low 실패 {ticker}: {e}')
        return None


def build_snapshot(current_date, data_dir, current_rankings):
    """pullback 스냅샷 배열 생성.

    Args:
        current_date: 'YYYYMMDD'
        data_dir: public/data 디렉토리
        current_rankings: 당일 rankings 리스트 (close_price 재활용)

    Returns:
        pullbacks: [{ticker, name, market, sector, peakPrice, peakDate, reason,
                     currentPrice, dropPct, postPeakLow, bouncePct, bounceBack}, ...]
        dropPct desc 정렬.
    """
    today_prices = {r['ticker']: r.get('close_price', 0) for r in (current_rankings or [])}

    past = _load_past_rankings(data_dir, current_date)
    if not past:
        logger.info('  pullback 스냅샷: 과거 데이터 없음')
        return []

    peak_stocks = _find_peak_stocks(past)
    logger.info(f'  pullback 스냅샷: {len(peak_stocks)}개 peak 후보 (과거 {len(past)}일)')
    if not peak_stocks:
        return []

    # 직전 거래일 pullback 목록 — '오늘 고점 회복(졸업)' 감지용
    prev_by_ticker = {}
    for p in _load_prev_pullbacks(data_dir, current_date):
        if p.get('ticker'):
            prev_by_ticker[p['ticker']] = p

    # 1. 현재가 조회 → dropPct 필터 (+ 어제 pullback 의 오늘 졸업 분리)
    pullbacks = []
    recovered = []
    for idx, (ticker, peak) in enumerate(peak_stocks.items()):
        current_price = today_prices.get(ticker) or _fetch_close_price(ticker, current_date)
        if not today_prices.get(ticker):
            time.sleep(0.05)
        if current_price <= 0:
            continue
        drop_pct = (peak['peakPrice'] - current_price) / peak['peakPrice'] * 100
        if drop_pct < DROP_PCT:
            # 조정이 얕음 — 단, 어제 pullback 이었는데 오늘 고점을 회복했으면 '졸업'으로 그날만 기록
            prev = prev_by_ticker.get(ticker)
            if prev and current_price >= peak['peakPrice']:
                entry = dict(peak)
                entry['currentPrice'] = current_price
                entry['dropPct'] = round(drop_pct, 2)
                entry['recovered'] = True
                entry['recoveredDate'] = current_date
                low = prev.get('postPeakLow') or prev.get('lowPrice') or current_price
                entry['postPeakLow'] = low
                entry['bouncePct'] = round((current_price - low) / low * 100, 2) if low else 0
                entry['bounceBack'] = True
                recovered.append(entry)
            continue
        entry = dict(peak)
        entry['currentPrice'] = current_price
        entry['dropPct'] = round(drop_pct, 2)
        pullbacks.append(entry)
        if (idx + 1) % 20 == 0:
            logger.info(f'    현재가 조회: {idx + 1}/{len(peak_stocks)}')

    logger.info(f'  pullback 스냅샷: {len(pullbacks)}개 조정 확정, {len(recovered)}개 고점회복(졸업)')
    if not pullbacks and not recovered:
        return []

    # 2. postPeakLow + bouncePct (정상 pullback 만 — 졸업분은 어제 저점을 이어받음)
    for idx, p in enumerate(pullbacks):
        post_low = _fetch_post_peak_low(p['ticker'], p['peakDate'], current_date)
        if post_low and post_low > 0:
            p['postPeakLow'] = post_low
            bounce = (p['currentPrice'] - post_low) / post_low * 100
            p['bouncePct'] = round(bounce, 2)
            p['bounceBack'] = bounce >= REBOUND_PCT
        else:
            p['postPeakLow'] = p['currentPrice']
            p['bouncePct'] = 0
            p['bounceBack'] = False
        time.sleep(0.05)
        if (idx + 1) % 20 == 0:
            logger.info(f'    postPeakLow 조회: {idx + 1}/{len(pullbacks)}')

    pullbacks.sort(key=lambda x: x['dropPct'], reverse=True)
    # 졸업(고점회복) 종목을 맨 앞에 — whyrise 가 [고점회복] 배지로 상단 표시
    return recovered + pullbacks
