"""rise_reason 자동 추정 — 무료 자원 결합.

우선순위:
  1. stock-rise 18일치에 해당 사건이 이미 채워져 있으면 그것 사용 (high)
  2. admin override 있으면 그것 사용 (edited)
  3. 그 일자 ±1일 네이버 뉴스 → 키워드 매칭 (high/mid)
  4. 종목 메타(industry/sector) + 가격 패턴 → 보조 (mid/low)
  5. 모두 실패 → reason_status: missing

각 함수는 stateless. 빌드 스크립트가 이걸 호출해 events 채움.
"""
from __future__ import annotations

import sys
from pathlib import Path

# scripts/_keyword_map.py 같은 디렉토리
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from _keyword_map import (  # noqa: E402
    match_keyword_reason,
    confidence_from_priority,
)


def reason_from_news(news_items: list[dict]) -> tuple[str, str, str] | None:
    """뉴스 제목들 → 키워드 매칭.

    Returns:
        (label, confidence, source) or None
        source 는 'news'.
    """
    if not news_items:
        return None
    titles = ' '.join(n.get('title', '') for n in news_items)
    hit = match_keyword_reason(titles)
    if hit is None:
        return None
    label, _kw, prio = hit
    return (label, confidence_from_priority(prio), 'news')


def reason_from_pattern(change_rate: float, is_52w_high: bool) -> tuple[str, str, str] | None:
    """가격 패턴 단독 — 키워드 매칭 모두 실패 시 fallback."""
    if is_52w_high:
        return ('52주 신고가 도달', 'mid', 'pattern')
    if change_rate >= 29.9:
        return ('상한가 — 사유 미수집', 'low', 'pattern')
    return None


def reason_from_theme(meta: dict) -> tuple[str, str, str] | None:
    """종목 메타 industry/sector — 모두 실패 시 fallback."""
    if not meta:
        return None
    text = ' '.join(filter(None, [meta.get('industry', ''), meta.get('sector', '')]))
    hit = match_keyword_reason(text)
    if hit is None:
        return None
    label, _kw, prio = hit
    return (label, 'low', 'theme')


def estimate_reason(
    news_items: list[dict] | None,
    change_rate: float,
    is_52w_high: bool = False,
    meta: dict | None = None,
) -> dict:
    """모든 소스 결합 — 가장 좋은 추정 반환.

    Returns:
        {rise_reason, reason_confidence, reason_source, reason_status}
        모두 실패 시 rise_reason='', reason_status='missing'
    """
    # 1. 뉴스 매칭 (가장 강함)
    if news_items:
        hit = reason_from_news(news_items)
        if hit:
            label, conf, src = hit
            return {
                'rise_reason': label,
                'reason_confidence': conf,
                'reason_source': src,
                'reason_status': 'filled',
            }

    # 2. 52주 신고가 + 상한가 패턴
    hit = reason_from_pattern(change_rate, is_52w_high)
    if hit:
        label, conf, src = hit
        return {
            'rise_reason': label,
            'reason_confidence': conf,
            'reason_source': src,
            'reason_status': 'filled',
        }

    # 3. 종목 메타 (테마/섹터)
    if meta:
        hit = reason_from_theme(meta)
        if hit:
            label, conf, src = hit
            return {
                'rise_reason': label,
                'reason_confidence': conf,
                'reason_source': src,
                'reason_status': 'filled',
            }

    # 4. 모두 실패
    return {
        'rise_reason': '',
        'reason_confidence': 'low',
        'reason_source': '',
        'reason_status': 'missing',
    }
