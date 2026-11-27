"""Forward Score v2 — 미래 상승 가능성 가산점 (ML 분석 기반).

기존 score = '그날의 강세'(사후 평가).
v1 시도: theme_persist + near_52w + pullback + consec_lu — 백테스트 결과 corr 0.28→0.25 ↓
v2 데이터 기반: ML 분석에서 양의 상관 보인 시그널만 채택.

채택 (양의 상관 또는 의미 있는 효과):
  · small_size_bonus (0~6): 거래대금 작을수록 가산 (log_trading_value 음의 상관)
  · consec_limit_up (0~5): 최근 연속 상한가 (약한 양의 상관)

폐기 (음의 상관 또는 의미 없음):
  · theme_persistence — 음의 상관 (테마 N일 연속은 늦은 진입 시그널)
  · near_52w_high — 음의 상관 (고점 부담)
  · pullback_bounce — 표본 0

총 가산점 0~11. score(100) + bonus(11) = forward_score 0~111.

사용처:
  · collector.py 가 매 종목에 forward_score 부여
  · backtest_score.py 가 score vs forward_score 예측력 비교
"""
from __future__ import annotations

from typing import Iterable

# ─── 가산점 한도 (v2 — ML 분석 기반) ────────────────
MAX_SMALL_SIZE = 6
MAX_CONSEC_LIMIT_UP = 5
LIMIT_UP_THRESHOLD = 29.5

# v1 한도 (deprecated — backtest_ml 호환용 보존)
MAX_THEME_PERSISTENCE = 10
MAX_NEAR_52W = 8
MAX_PULLBACK_BOUNCE = 7
NEAR_52W_RATIO = 0.95


def _small_size_bonus(stock):
    """거래대금이 작을수록 가산 — ML 분석에서 음의 상관 발견.

    소형주 폭등 효과: rankings 들어온 종목 중 거래대금 작은 게 익일 더 오름.
    구간:
      < 50억      → 6점
      < 200억     → 4점
      < 1,000억   → 2점
      < 5,000억   → 1점
      그 외       → 0점
    """
    tv = stock.get('trading_value') or 0
    if tv < 5_000_000_000:        # 50억
        return MAX_SMALL_SIZE
    if tv < 20_000_000_000:       # 200억
        return 4
    if tv < 100_000_000_000:      # 1000억
        return 2
    if tv < 500_000_000_000:      # 5000억
        return 1
    return 0


def _theme_persistence_score(stock, history_data):
    """같은 theme_tag 가 최근 N일 history 에 등장한 횟수 → 0~10점.

    Args:
        stock: {theme_tag, ...}
        history_data: list[dict] 최근 N일 = [{date, rankings: [...]}]
    """
    tag = stock.get('theme_tag')
    if not tag or not history_data:
        return 0
    count = 0
    for day in history_data:
        if any(s.get('theme_tag') == tag for s in day.get('rankings', [])):
            count += 1
    # N=5일 기준 5회 등장 = 만점
    return min(count * 2, MAX_THEME_PERSISTENCE)


def _near_52w_high_score(stock):
    """현재 종가가 52주 고점 대비 얼마나 근접한지 → 0~8점.

    돌파(>= high_52w) → 만점 8
    근접 (>= 95%) → 6
    근접 (>= 90%) → 3
    그 외 → 0
    """
    high = stock.get('high_52w') or 0
    close = stock.get('close_price') or 0
    if high <= 0 or close <= 0:
        return 0
    ratio = close / high
    if ratio >= 1.0:
        return MAX_NEAR_52W
    if ratio >= NEAR_52W_RATIO:
        return 6
    if ratio >= 0.90:
        return 3
    return 0


def _pullback_bounce_score(stock, pullbacks):
    """풀백 후 반등 종목 가산점 → 0~7점.

    pullbacks 에 등장하면서 currentPrice 가 dropPct 일부 이상 회복 시.
    이미 collector 가 pullback_snapshot 빌드. 일치하는 ticker 찾으면 가산.
    """
    if not pullbacks:
        return 0
    ticker = stock.get('ticker')
    for p in pullbacks:
        if p.get('ticker') != ticker:
            continue
        bounce_pct = p.get('bouncePct') or 0
        if bounce_pct >= 25:
            return MAX_PULLBACK_BOUNCE
        if bounce_pct >= 15:
            return 5
        if bounce_pct >= 5:
            return 3
        return 0
    return 0


def _consec_limit_up_score(stock, history_data):
    """최근 N일 history 에서 같은 ticker 연속 상한가 카운트 → 0~5점."""
    if not history_data:
        return 0
    ticker = stock.get('ticker')
    streak = 0
    for day in history_data:  # 최근 → 과거 순서 가정
        hit = False
        for s in day.get('rankings', []):
            if s.get('ticker') == ticker and (s.get('change_rate') or 0) >= LIMIT_UP_THRESHOLD:
                hit = True
                break
        if hit:
            streak += 1
        else:
            break
    if streak >= 3:
        return MAX_CONSEC_LIMIT_UP
    if streak == 2:
        return 4
    if streak == 1:
        return 2
    return 0


def calculate_forward_score(stock, theme_group=None, history_data=None, pullbacks=None):
    """forward_score v2 = score + small_size + consec_limit_up.

    Returns: dict {
        'forward_total': int (0~111),
        'forward_bonus': int (0~11),
        'forward_detail': {small_size, consec_lu}
    }
    """
    base_score = stock.get('score') or 0
    small_size = _small_size_bonus(stock)
    consec_lu = _consec_limit_up_score(stock, history_data)
    bonus = small_size + consec_lu
    return {
        'forward_total': base_score + bonus,
        'forward_bonus': bonus,
        'forward_detail': {
            'small_size': small_size,
            'consec_lu': consec_lu,
        },
    }


def annotate_rankings(rankings, history_data=None, pullbacks=None):
    """rankings 리스트의 각 stock 에 forward_score 필드 추가 (in-place)."""
    for stock in rankings:
        result = calculate_forward_score(
            stock,
            history_data=history_data,
            pullbacks=pullbacks,
        )
        stock['forward_score'] = result['forward_total']
        stock['forward_bonus'] = result['forward_bonus']
        stock['forward_detail'] = result['forward_detail']
    return rankings
