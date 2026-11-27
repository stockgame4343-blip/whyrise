"""대장점수 산출, 거래 강도 레이블, 상승 이유 텍스트 생성

대장점수 = 테마강도(35) + 대장성(45) + 거래강도(20) = 100점
- 테마강도: 이 테마가 현재 장에서 얼마나 강한지
- 대장성: 테마 내에서 이 종목이 얼마나 리더인지 (오를때 가장 많이, 내릴때 가장 적게)
- 거래강도: 개별 종목의 거래 활력 (보조 지표)
"""
import re
import logging

from config import (
    MAJOR_PRESS, TRADING_INTENSITY,
    SUPPLY_DEMAND_MULTIPLIER, TURNOVER_BONUS_PERCENTILE,
    NEWS_DEDUP_THRESHOLD,
    VOLUME_RATIO_THRESHOLDS, TURNOVER_THRESHOLDS, MCAP_TURNOVER_MULT,
    SUPPLY_BONUS, THEME_MOMENTUM_THRESHOLDS, THEME_PERSIST_THRESHOLDS,
    THEME_BREADTH_THRESHOLDS, LEADER_HITRATE_THRESHOLDS, LEADER_HITRATE_FIRST,
    NO_TAG_TP_DEFAULT, NO_TAG_TL_DEFAULT,
)

logger = logging.getLogger(__name__)

# ── 뉴스 키워드 → 상승 이유 라벨 ──
# 유사투자자문업 미신고 상태를 고려해, 미래 예측("기대"·"수혜"·"모멘텀")·
# 수급 자극("매수세") 표현을 과거 사실 서술("관련 뉴스"·"이슈"·"보도")로 유지.
# 뉴스 제목에서 키워드를 찾아 "{주제} {라벨}" 으로 결합.

# (키워드, 라벨 텍스트, 우선도) — 우선도가 높을수록 먼저 선택
_ACTION_TABLE = [
    # 실적/재무
    ('흑자전환',   '흑자 전환',       8),
    ('어닝서프라이즈', '실적 서프라이즈', 8),
    ('흑자',       '흑자 전환 보도',   7),
    ('영업이익',   '영업이익 공시',   7),
    ('순이익',     '순이익 공시',     6),
    ('매출',       '매출 관련 뉴스',   5),
    ('실적',       '실적 관련 뉴스',   5),
    # 수주/계약
    ('수주',       '수주 공시',       7),
    ('납품',       '납품 계약 체결',   7),
    ('공급 계약',  '공급 계약 체결',   8),
    ('계약 체결',  '계약 체결',       7),
    ('계약',       '계약 관련 뉴스',   5),
    ('공급',       '공급 관련 뉴스',   4),
    # 바이오/신약
    ('FDA',        'FDA 관련 뉴스',   8),
    ('허가',       '허가 관련 뉴스',   7),
    ('임상 3상',   '임상 3상 진입',   8),
    ('임상',       '임상 관련 뉴스',   6),
    ('신약',       '신약 관련 뉴스',   6),
    ('승인',       '승인 관련 뉴스',   6),
    # 투자/사업
    ('설비 투자',  '설비 투자 발표',   7),
    ('투자 확대',  '투자 확대 발표',   7),
    ('증설',       '증설 발표',       7),
    ('양산',       '양산 보도',       7),
    ('착공',       '착공 뉴스',       6),
    ('수출',       '수출 관련 뉴스',   6),
    ('진출',       '해외 진출 뉴스',   5),
    ('투자',       '투자 관련 뉴스',   3),
    # 기업 이벤트
    ('인수',       '인수 관련 뉴스',   6),
    ('합병',       '합병 관련 뉴스',   6),
    ('M&A',        'M&A 관련 뉴스',   6),
    ('MOU',        'MOU 체결',       6),
    ('대표이사',   '경영진 교체',     5),
    ('특허',       '특허 취득',       6),
    ('기술이전',   '기술이전 뉴스',   7),
    ('라이선스',   '라이선스 계약',   6),
    ('지분',       '지분 관련 이슈',   5),
    ('자사주',     '자사주 매입',     6),
    ('소각',       '자사주 소각',     7),
    ('배당',       '배당 공시',       5),
    ('주주환원',   '주주환원 정책',   6),
    ('상장',       '상장 이슈',       5),
    ('분할',       '기업 분할 이슈',   5),
    ('협력',       '협력 관련 뉴스',   4),
    ('유상증자',   '유상증자 공시',   5),
    ('무상감자',   '무상감자 공시',   5),
    ('감자',       '자본 구조 변경',   4),
    ('전환사채',   '전환사채 이슈',   4),
    ('CB',         '전환사채 이슈',   4),
    # 정책/규제 — "수혜"는 주가 상승 암시로 제거, "관련" 으로 중립화
    ('국책',       '국책사업 관련',   6),
    ('보조금',     '보조금 관련',     6),
    ('관세',       '관세 정책 관련',   6),
    ('트럼프',     '정책 관련 뉴스',   5),
    ('정부',       '정부 정책 관련',   4),
    ('정책',       '정책 관련 뉴스',   4),
    ('규제',       '규제 관련 뉴스',   4),
    # 수급 — "매수세" 는 가격 자극 표현으로 순매수 공시·보도 사실로 변경
    ('외국인',     '외국인 순매수 보도', 3),
    ('기관',       '기관 순매수 보도',   3),
    ('순매수',     '순매수 보도',       3),
    ('공매도',     '공매도 이슈',       3),
    # 시장/테마 일반 — "강세"·"급등세" 제거, 사실 서술만 유지
    ('강세',       '테마 관련 뉴스',   2),
    ('급등',       '거래량 급증',     2),
    ('관련주',     '테마 관련주',     2),
    ('상한가',     '상한가 기록',     2),
    ('대장주',     '테마 대장주',     3),
    ('수혜주',     '관련주 언급',     3),
]


# ══════════════════════════════════════
# 뉴스 전처리
# ══════════════════════════════════════

def _jaccard_similarity(title_a, title_b):
    """두 제목의 자카드 유사도 (단어 집합 기반)"""
    words_a = set(title_a.split())
    words_b = set(title_b.split())
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    union = words_a | words_b
    return len(intersection) / len(union)


def deduplicate_news(articles):
    """뉴스 중복 제거 — 자카드 유사도 기반"""
    if not articles:
        return []

    unique = [articles[0]]
    for article in articles[1:]:
        is_dup = False
        for existing in unique:
            if _jaccard_similarity(article['title'], existing['title']) >= NEWS_DEDUP_THRESHOLD:
                is_dup = True
                break
        if not is_dup:
            unique.append(article)

    removed = len(articles) - len(unique)
    if removed > 0:
        logger.debug(f"  중복 뉴스 {removed}건 제거 ({len(articles)} → {len(unique)})")

    return unique


# ══════════════════════════════════════
# 대장점수 — 테마강도(35) + 대장성(45) + 거래강도(20) = 100
# ══════════════════════════════════════

def _apply_thresholds(value, thresholds):
    """값에 대해 내림차순 임계값 테이블을 적용하여 점수 반환"""
    for threshold, score in thresholds:
        if value >= threshold:
            return score
    return 0


def _score_tp(theme_group, theme_tag, history_data=None):
    """테마강도 (Theme Power) — 35점 만점

    이 테마가 현재 장에서 얼마나 강한지.
    같은 테마의 모든 종목이 동일한 tp를 받음.

    Sub-A: 테마 모멘텀 (0-20) — 그룹 평균 등락률
    Sub-B: 테마 지속일 (0-10) — 최근 N일 중 출현 횟수
    Sub-C: 테마 규모  (0-5)  — 오늘 Top100 내 종목 수
    """
    if not theme_group or not theme_tag:
        return NO_TAG_TP_DEFAULT

    # Sub-A: 모멘텀 — 그룹 평균 change_rate
    avg_rate = sum(s.get('change_rate', 0) for s in theme_group) / len(theme_group)
    momentum = _apply_thresholds(avg_rate, THEME_MOMENTUM_THRESHOLDS)

    # Sub-B: 지속일 — 최근 5일 중 이 theme_tag가 몇 일 출현
    persist_days = 0
    if history_data:
        for day_data in history_data:
            rankings = day_data.get('rankings', [])
            if any(r.get('theme_tag') == theme_tag for r in rankings):
                persist_days += 1
    # 오늘 포함하면 +1이지만, 오늘은 이미 존재하므로 history만 카운트 후 +1
    persist_days += 1  # 오늘
    persist = _apply_thresholds(persist_days, THEME_PERSIST_THRESHOLDS)

    # Sub-C: 규모 — 종목 수
    breadth = _apply_thresholds(len(theme_group), THEME_BREADTH_THRESHOLDS)

    return min(momentum + persist + breadth, 35)


def _score_tl(stock, theme_group, history_data=None):
    """대장성 (Theme Leadership) — 45점 만점

    테마 내에서 이 종목이 얼마나 리더인지.
    오를때 가장 많이/빠르게, 내릴때 가장 적게.

    Sub-A: 등락률 리더십 (0-15) — 그룹 내 change_rate 순위
    Sub-B: 거래대금 집중  (0-15) — 그룹 내 TV 점유율 (상한가 보정)
    Sub-C: 연속 출현     (0-15) — 하락 방어력 프록시
    """
    theme_tag = stock.get('theme_tag', '')
    if not theme_group or not theme_tag:
        return NO_TAG_TL_DEFAULT

    ticker = stock['ticker']
    is_limit_up = stock.get('is_limit_up', False) or stock.get('change_rate', 0) >= 29.5

    # ── Sub-A: 등락률 순위 (0-15) ──
    rates = sorted([s.get('change_rate', 0) for s in theme_group], reverse=True)
    my_rate = stock.get('change_rate', 0)

    # 상한가 종목은 최소 2위 보장
    if is_limit_up:
        rank = max(1, min(2, rates.index(my_rate) + 1 if my_rate in rates else len(rates)))
    else:
        rank = 1
        for r in rates:
            if r > my_rate:
                rank += 1
            else:
                break

    rank_scores = {1: 15, 2: 11, 3: 8}
    change_rank = rank_scores.get(rank, 4)

    # ── Sub-B: 거래대금 집중도 (0-15) ──
    if is_limit_up:
        # 상한가 보정: 매수세 과잉으로 거래 중단 → 자동 최고점
        tv_share_score = 15
    else:
        total_tv = sum(s.get('trading_value', 0) for s in theme_group)
        my_tv = stock.get('trading_value', 0)
        if total_tv > 0:
            share = my_tv / total_tv
        else:
            share = 0

        if share >= 0.5:
            tv_share_score = 15
        elif share >= 0.3:
            tv_share_score = 12
        elif share >= 0.15:
            tv_share_score = 8
        else:
            tv_share_score = 4

    # ── Sub-C: 연속 출현 (0-15) — 하락 방어력 프록시 ──
    if not history_data:
        persistence = LEADER_HITRATE_FIRST  # 히스토리 없으면 첫 출현 취급
    else:
        theme_days = 0
        stock_days = 0
        for day_data in history_data:
            rankings = day_data.get('rankings', [])
            day_has_theme = any(r.get('theme_tag') == theme_tag for r in rankings)
            if day_has_theme:
                theme_days += 1
                if any(r.get('ticker') == ticker and r.get('theme_tag') == theme_tag for r in rankings):
                    stock_days += 1

        if theme_days == 0:
            persistence = LEADER_HITRATE_FIRST  # 새 테마
        else:
            hit_rate = stock_days / theme_days
            persistence = _apply_thresholds(hit_rate, LEADER_HITRATE_THRESHOLDS)
            if persistence == 0:
                persistence = LEADER_HITRATE_FIRST

    return min(change_rank + tv_share_score + persistence, 45)


def _score_ti(stock, td):
    """거래강도 (Trading Intensity) — 20점 만점

    개별 종목의 거래 활력. 보조 지표.

    Sub-A: 5일평균 대비 (0-12)
    Sub-B: 시총보정 회전율 (0-5)
    Sub-C: 수급 보정 (0-3)
    """
    today_value = td.get('today_value', 0)
    avg_5day = td.get('avg_5day', 0)
    inst_net = td.get('inst_net', 0)
    foreign_net = td.get('foreign_net', 0)
    market_cap = stock.get('market_cap', 0)
    trading_value = stock.get('trading_value', 0)

    # Sub-A: 5일평균 대비 비율
    if avg_5day > 0 and today_value > 0:
        ratio = today_value / avg_5day
        vol_ratio = _apply_thresholds(ratio, VOLUME_RATIO_THRESHOLDS)
    else:
        vol_ratio = 6  # 중립

    # Sub-B: 시총보정 회전율
    if market_cap > 0 and trading_value > 0:
        raw_turnover = trading_value / market_cap * 100
        # 시총 보정: 대형주 동일 회전율이 더 의미있음
        mult = 1.0
        for mcap_threshold, m in MCAP_TURNOVER_MULT:
            if market_cap >= mcap_threshold:
                mult = m
                break
        adjusted = raw_turnover * mult
        turnover = _apply_thresholds(adjusted, TURNOVER_THRESHOLDS)
    else:
        turnover = 1

    # Sub-C: 수급 보정
    if inst_net > 0 and foreign_net > 0:
        supply = SUPPLY_BONUS['both']
    elif inst_net > 0:
        supply = SUPPLY_BONUS['institution']
    elif foreign_net > 0:
        supply = SUPPLY_BONUS['foreign']
    else:
        supply = SUPPLY_BONUS['none']

    return min(vol_ratio + turnover + supply, 20)


def calculate_daejang_score(stock, theme_group, td, history_data=None):
    """대장점수 종합 산출
    테마강도(35) + 대장성(45) + 거래강도(20) = 100점

    Args:
        stock: dict — {ticker, name, change_rate, trading_value, market_cap,
                        theme_tag, is_limit_up, ...}
        theme_group: list[dict] — 같은 theme_tag 종목들 (빈 리스트=태그 없음)
        td: dict — {today_value, avg_5day, inst_net, foreign_net}
        history_data: list[dict] — 최근 N일 일별 데이터 [{date, rankings:[...]}]

    Returns:
        dict: {'total': int, 'detail': {'tp': int, 'tl': int, 'ti': int}}
    """
    theme_tag = stock.get('theme_tag', '')

    tp = _score_tp(theme_group, theme_tag, history_data)
    tl = _score_tl(stock, theme_group, history_data)
    ti = _score_ti(stock, td)

    total = min(tp + tl + ti, 100)

    return {
        'total': total,
        'detail': {
            'tp': tp,
            'tl': tl,
            'ti': ti,
        }
    }


# ══════════════════════════════════════
# 테마 태그 추출 (기사 본문 기반 동적 추출)
# ══════════════════════════════════════

_THEME_PATTERNS = [
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*관련주'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*테마주'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*테마(?:[^주]|$)'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*수혜주'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*대장주'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})주(?:가|는|도|의)?\s*(?:강세|급등|상한가|상승|올라|치솟|폭등)'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*(?:업종|종목|섹터)(?:은|이|도|의)?\s*(?:\d|강세|급등|상승|상한가|올라|폭등)'),
    # 추가 패턴
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*관련\s*종목'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*핵심주'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*대표주'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*열풍'),
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*산업(?:이|은|도)?\s*(?:강세|급등|상승|성장|확대|호조)'),
    # 株(주) 표기 패턴
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})株\s*(?:강세|급등|상승|상한가|폭등|일제히)'),
    # "OOO 분야/시장/부문" 패턴
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*(?:분야|부문)(?:이|에)?\s*(?:강세|급등|상승|호조|성장)'),
    # "OOO 수요/수출 증가" 패턴 → OOO가 테마
    re.compile(r'([가-힣A-Za-z0-9/]{2,10})\s*(?:수요|수출|수입)(?:이|가)?\s*(?:증가|급증|확대|호조)'),
    # 따옴표/큰따옴표 안의 테마
    re.compile(r'[\'"\u2018\u2019\u201C\u201D]([가-힣A-Za-z0-9/]{2,8})[\'"\u2018\u2019\u201C\u201D]?\s*(?:관련|테마|수혜|대장)'),
]

_THEME_NOISE = {
    '해당', '전체', '국내', '일부', '다수', '특정', '대형', '중소형',
    '관련', '소형', '시장', '증시', '주식', '코스피', '코스닥',
    '개별', '상승', '하락', '주요', '이날', '오늘', '어제',
    '우리', '이번', '종목', '투자', '매수', '매도', '최근',
    '해외', '글로벌', '전일', '금일', '장중', '오전', '오후',
    '올해', '내년', '지난', '이달', '연속', '이후', '거래',
    '우려', '직접적', '직접', '가능성', '전망', '기대', '불안', '부진',
    '전쟁', '긴장', '불확실성', '위기', '리스크', '충돌', '갈등',
    '일제히', '줄줄이', '동반', '동시', '변동성',
    '중심으로', '제외한', '포함한', '대비', '경쟁',
    '주도', '주목', '성장', '확대', '강화', '촉진',
    '중동', '미국', '중국', '유럽', '일본', '북한',
    '스테이블코', '스테이블코인',
    # 추가 노이즈
    '서울', '한국', '아시아', '세계', '테마', '섹터', '업종',
    '속보', '단독', '기사', '보도', '뉴스',
    '실시간', '오전장', '오후장', '마감',
    '하반기', '상반기', '분기', '연간',
    '대규모', '소규모', '초대형', '중대형',
    '소식통', '관계자', '전문가', '애널리스트',
}


def _clean_theme_tag(raw):
    """추출된 태그에서 조사/접미사/용언어미 제거"""
    tag = raw.strip().strip('·')
    # 가운데점 연결 → 첫 번째 부분만
    if '·' in tag:
        parts = [p.strip() for p in tag.split('·') if len(p.strip()) >= 2]
        tag = parts[0] if parts else tag
    # 용언 어미 제거 (하는, 되는, 있는 등)
    tag = re.sub(r'(?:하는|되는|있는|없는|적인|에서|부터|까지|으로|에의)$', '', tag)
    # 한글 조사/접미사 제거 (2회 반복)
    tag = re.sub(r'[에을를은는의이가와과도로서께한인적하]$', '', tag)
    tag = re.sub(r'[에을를은는의이가와과도로서께한인적하]$', '', tag)
    return tag


def _extract_themes_from_text(text):
    """텍스트에서 테마 패턴 추출 → Counter"""
    from collections import Counter
    counts = Counter()
    for pattern in _THEME_PATTERNS:
        for m in pattern.finditer(text):
            tag = _clean_theme_tag(m.group(1))
            if len(tag) >= 2 and tag not in _THEME_NOISE:
                counts[tag] += 1
    return counts


def extract_theme_tag(articles, article_bodies=None, stock_name=''):
    """기사 본문에서 테마 태그를 동적 추출

    전략:
    1. 기사 본문에서 종목명이 등장하는 문단을 우선 분석
    2. 종목명 근처의 테마 패턴이 가장 정확함
    3. 매치 없으면 전체 본문 → 제목 순으로 fallback

    Args:
        articles: 뉴스 기사 목록 (title 포함)
        article_bodies: 기사 본문 텍스트 리스트
        stock_name: 종목명 (문단 필터링용)

    Returns:
        str: 테마 태그 (예: '광통신', '알루미늄', '방산')
    """
    bodies = [b for b in (article_bodies or []) if b]

    def _pick_best(counts):
        """Counter에서 _BAD_THEME_TAGS가 아닌 최다 태그 반환"""
        for tag, _ in counts.most_common(5):
            if _is_valid_theme_tag(tag):
                return tag
        return ''

    # 전략 1: 종목명 근처 200자 윈도우에서 추출 (가장 정확)
    if bodies and stock_name:
        windows = []
        for body in bodies:
            idx = 0
            while True:
                pos = body.find(stock_name, idx)
                if pos == -1:
                    break
                start = max(0, pos - 100)
                end = min(len(body), pos + len(stock_name) + 100)
                windows.append(body[start:end])
                idx = pos + 1
        if windows:
            counts = _extract_themes_from_text('\n'.join(windows))
            result = _pick_best(counts)
            if result:
                return result

    # 전략 2: 전체 본문에서 추출
    if bodies:
        counts = _extract_themes_from_text('\n'.join(bodies))
        result = _pick_best(counts)
        if result:
            return result

    # 전략 3: 제목에서 추출 (fallback)
    if articles:
        titles = ' '.join(a.get('title', '') for a in articles)
        counts = _extract_themes_from_text(titles)
        result = _pick_best(counts)
        if result:
            return result

    return ''


def extract_news_keywords(articles, article_bodies=None, stock_name='', top_n=None):
    """뉴스 본문/제목에서 상위 N개 테마 키워드를 Counter 기반으로 추출.

    resolve_themes() 와 교차해 primary/secondary 태그 선정에 쓰기 위한 "증거 세트".
    extract_theme_tag() 와 다른 점:
    - 단일 best 가 아니라 상위 N개 리스트를 돌려줌
    - 종목명 윈도우 / 제목 / 전체 본문 각각 가중치 (×3 / ×2 / ×1) 로 누적

    Args:
        articles: [{title, ...}, ...]
        article_bodies: 기사 본문 텍스트 리스트
        stock_name: 종목명 (윈도우 필터링용)
        top_n: 상위 개수 (None 이면 config.NEWS_KEYWORDS_TOP_N)

    Returns:
        list[str]: _is_valid_theme_tag 통과한 상위 N개 키워드 (등장 빈도 내림차순)
    """
    from collections import Counter
    if top_n is None:
        try:
            from config import NEWS_KEYWORDS_TOP_N
            top_n = NEWS_KEYWORDS_TOP_N
        except ImportError:
            top_n = 10

    bodies = [b for b in (article_bodies or []) if b]
    counts = Counter()

    # 전략 1: 종목명 근처 200자 윈도우 (가중치 ×3)
    if bodies and stock_name:
        for body in bodies:
            idx = 0
            while True:
                pos = body.find(stock_name, idx)
                if pos == -1:
                    break
                start = max(0, pos - 100)
                end = min(len(body), pos + len(stock_name) + 100)
                for k, v in _extract_themes_from_text(body[start:end]).items():
                    counts[k] += v * 3
                idx = pos + 1

    # 전략 2: 전체 본문 (가중치 ×1)
    if bodies:
        for k, v in _extract_themes_from_text('\n'.join(bodies)).items():
            counts[k] += v

    # 전략 3: 뉴스 제목 (가중치 ×2)
    if articles:
        titles = ' '.join(a.get('title', '') for a in articles)
        for k, v in _extract_themes_from_text(titles).items():
            counts[k] += v * 2

    out = []
    for tag, _cnt in counts.most_common(top_n * 3):
        if _is_valid_theme_tag(tag) and tag != stock_name:
            out.append(tag)
        if len(out) >= top_n:
            break
    return out


# ══════════════════════════════════════
# 상승 이유 텍스트 생성
# ══════════════════════════════════════

def _find_best_action(titles_text):
    """뉴스 제목 텍스트에서 가장 구체적인 액션 키워드를 찾는다.

    Returns:
        tuple: (action_text, priority) or (None, 0)
    """
    best = (None, 0)
    for keyword, action, priority in _ACTION_TABLE:
        if keyword in titles_text and priority > best[1]:
            best = (action, priority)
    return best


# 의미 없는 theme_tag 필터 (테마 추출 오류로 잡힌 일반어)
_BAD_THEME_TAGS = {
    '이전', '이후', '관련', '전체', '국내', '해당', '특정', '일부',
    '다수', '대형', '소형', '시장', '증시', '종합', '기타', '상승',
    '하락', '오늘', '어제', '지금', '우리', '이번', '최근', '주요',
    '거래', '투자', '매수', '매도', '전망', '기대', '불안', '전일',
    '금일', '장중', '오전', '오후', '마감', '속보', '단독', '경제',
    '지목하면', '중심으로', '포함한', '제외한', '동시에',
    '대표', '사장', '회장', '부사장', '이사', '선임', '신임',
    '상장폐지', '거래정지', '관리종목',
    '정치', '검색', '다양', '밸류', '계속', '이용', '정보', '결과',
    '이용자', '활용', '방법', '성과', '현재', '상태', '변화', '수준',
    '현황', '분위기', '소식', '자체', '문제', '경우', '내용', '부분',
    '사업', '상품', '사실', '과정', '조건', '상황', '수요', '쪽',
}

# 사용자가 삭제한 태그 (런타임에 추가됨)
_USER_BAD_TAGS = set()


def load_user_bad_tags(bad_tags_list):
    """사용자 피드백에서 학습한 잘못된 태그를 로드"""
    global _USER_BAD_TAGS
    _USER_BAD_TAGS = set(bad_tags_list)
    if _USER_BAD_TAGS:
        logger.info(f"  사용자 bad_tags 로드: {len(_USER_BAD_TAGS)}개")


def _is_valid_theme_tag(tag):
    """theme_tag가 상승 이유에 쓸 만한지 판별"""
    if not tag or len(tag) < 2:
        return False
    if tag in _BAD_THEME_TAGS or tag in _USER_BAD_TAGS:
        return False
    # 순수 숫자만인 경우 제외
    if tag.isdigit():
        return False
    # 용언/형용사 어미로 끝나면 제외 (동사형 잘못 추출)
    bad_suffixes = ('하면', '하는', '되는', '있는', '없는', '들이', '자들', '에서',
                    '해서', '에게', '까지', '에도', '지만', '속해', '해')
    if any(tag.endswith(s) for s in bad_suffixes):
        return False
    # 잘못 추출되기 쉬운 접미어
    bad_prefixes = ('계속', '밸류체', '정치인')
    if tag in bad_prefixes:
        return False
    return True


def extract_theme_from_reason(reason_text):
    """상승 이유 텍스트에서 테마 키워드 추출 (fallback)

    Toss AI 상승이유나 generate_rise_reason 결과에서 핵심 테마만 추출.
    예: '반도체 투자 확대' → '반도체'
        '원전 수주 확대' → '원전'
        '광통신 테마 강세' → '광통신'
        '실적 호조' → '' (테마 아닌 일반 사유)
    """
    if not reason_text:
        return ''

    _ACTION_WORDS = {
        '투자', '확대', '수주', '수출', '강세', '급등', '호조', '개선', '전환',
        '성장', '증설', '본격화', '모멘텀', '부각', '수혜', '급증', '유입',
        '기대', '돌파', '체결', '진입', '진전', '취득', '매입', '소각', '기록',
        '급등세', '교체', '이슈', '테마', '관련', '시장', '관심', '증가',
        '거래', '증권사', '매수', '의견', '정책', '정부', '보조금',
        # '거래량 증가'(뉴스 0건 폴백) → 테마 '거래량' 오태깅 방지 (2026-10 텔레그램 '거래량 3종목')
        '거래량', '거래대금',
        '외국인', '기관', '순매수', '매수세', '수급', '상한가',
        '설비', '생산', '해외', '진출', '착공', '납품', '공급', '계약', '신규',
        '실적', '서프라이즈', '영업이익', '순이익', '매출',
        '인수', '합병', '기대감', '경영진', '특허', '지분',
        '자사주', '배당', '주주환원', '상장', '분할', '협력', '사업',
        '허가', '임상', '승인', '양산',
    }

    words = reason_text.split()
    for w in words:
        if w not in _ACTION_WORDS and _is_valid_theme_tag(w):
            return w
    return ''


def _extract_subject_from_titles(articles, stock_name=''):
    """뉴스 제목에서 핵심 주제어를 추출한다.
    종목명/일반어를 제외한 2~6자 고유명사를 찾는다.
    """
    import re as _re

    # "OOO 관련주", "OOO 테마" 패턴에서 OOO 추출
    all_titles = ' '.join(a.get('title', '') for a in articles)
    subject_pattern = _re.compile(r'([가-힣A-Za-z0-9]{2,8})\s*(?:관련주|테마주|테마|수혜주|대장주)')
    for m in subject_pattern.finditer(all_titles):
        candidate = m.group(1).strip()
        # _BAD_THEME_TAGS와 동일한 필터 적용
        if _is_valid_theme_tag(candidate) and candidate != stock_name:
            return candidate

    return ''


def _is_tag_grounded(theme_tag, articles, article_bodies=None):
    """theme_tag 가 뉴스 제목/본문에 실제로 등장하는지 검증.

    네이버 매핑에서 온 태그가 이 종목의 실제 상승 원인과 무관하게 고를 때
    (예: 빛샘전자 → "철도" 매핑) rise_reason 에 그 태그를 결합시키면 부자연스러움.
    grounding 실패한 태그는 Priority 1 에서 제외해 더 정직한 이유 생성.
    """
    if not theme_tag:
        return False
    text = ''
    if articles:
        text = ' '.join(a.get('title', '') for a in articles)
    if article_bodies:
        text += '\n' + '\n'.join(b for b in article_bodies if b)
    if not text:
        return False
    if theme_tag in text:
        return True
    # 3자 이상 태그의 주요 2글자 핵이 둘 다 들어오면 grounded 로 간주
    # (예: "광통신" → "광통" + "통신" 둘 다 포함 체크는 과할 수 있어 substring 만 사용)
    if len(theme_tag) >= 3:
        core = theme_tag
        if core in text:
            return True
    return False


def generate_rise_reason(articles, analyst_reports=None, theme_tag='', stock_name='',
                         article_bodies=None):
    """간결한 상승 이유 생성 (과거 사실 서술 톤)

    출력 예시:
    - "반도체 투자 확대 발표"
    - "광통신 관련 뉴스"
    - "신약 FDA 관련 뉴스"
    - "실적 관련 뉴스"
    - "자사주 소각"

    개선(2026-04-22): theme_tag 가 뉴스에 grounding 안 된 경우 (네이버 매핑이 종목과
    거리 먼 테마에 태깅했을 때) Priority 1 에서 제외해 엉뚱한 "{tag} {action}" 생성 방지.
    """
    all_titles = ''
    if articles:
        all_titles = ' '.join(a.get('title', '') for a in articles)

    action_text, action_priority = _find_best_action(all_titles)

    valid_tag = _is_valid_theme_tag(theme_tag)
    tag_grounded = valid_tag and _is_tag_grounded(theme_tag, articles, article_bodies)

    # ── Priority 1: theme_tag (grounded) + 강한 액션(>=6) ──
    # threshold 를 높게 잡아 "배당(5)"·"계약(5)" 같은 약한 액션이 tag 와 결합되는 걸 억제.
    # 약한 액션이면 "테마 관련 뉴스" 로 일반화 — 실제 상승이 '배당' 보다 '테마 전반' 일 경우가 많음.
    if tag_grounded:
        if action_text and action_priority >= 6:
            # 테마와 액션이 겹치면 액션만 사용
            if theme_tag in action_text:
                return action_text
            return f'{theme_tag} {action_text}'
        # 액션이 약하거나 없으면 "테마 관련 뉴스" (중립 서술)
        return f'{theme_tag} 관련 뉴스'

    # ── Priority 1b: grounded 안 됐지만 tag 있고 액션이 매우 강함 → 액션만 사용 (tag 버림) ──
    if valid_tag and not tag_grounded and action_text and action_priority >= 6:
        return action_text

    # ── Priority 2: 뉴스 제목에서 주제어 추출 + 액션 ──
    subject = _extract_subject_from_titles(articles, stock_name) if articles else ''
    if subject and action_text and action_priority >= 4:
        if subject in action_text:
            return action_text
        return f'{subject} {action_text}'

    # ── Priority 3: 액션만 사용 ──
    if action_text and action_priority >= 3:
        return action_text

    # ── Priority 4: 증권사 리포트 존재 여부 (중립 서술) ──
    # "매수 의견" 직접 노출은 투자 권유로 해석될 여지가 있어 리포트 발행 사실만 표기.
    if analyst_reports:
        return '증권사 리포트 공개'

    # ── Priority 5: 뉴스 제목에서 주제어만이라도 추출 ──
    if subject:
        return f'{subject} 이슈'

    # ── Priority 6: 약한 액션이라도 사용 ──
    if action_text:
        return action_text

    # ── Fallback ──
    return '거래량 증가'


# ══════════════════════════════════════
# 거래 강도 v2
# ══════════════════════════════════════

def calculate_trading_intensity(today_value, avg_5day_value,
                                inst_net=0, foreign_net=0,
                                turnover_rank_pct=50):
    """거래 강도 레이블 산출 v2

    Args:
        today_value: 오늘 거래대금
        avg_5day_value: 5일 평균 거래대금
        inst_net: 기관 순매수 금액
        foreign_net: 외국인 순매수 금액
        turnover_rank_pct: 회전율 백분위 (0=최고, 100=최저)

    Returns:
        tuple: (레이블, 상세dict)
    """
    if avg_5day_value <= 0 or today_value <= 0:
        return '보통', {'ratio': 0, 'supply': 'N/A', 'turnover_pct': turnover_rank_pct}

    ratio_pct = (today_value / avg_5day_value) * 100

    # 수급 보정
    if inst_net > 0 and foreign_net > 0:
        supply_type = 'both'
    elif inst_net > 0:
        supply_type = 'institution'
    elif foreign_net > 0:
        supply_type = 'foreign'
    else:
        supply_type = 'retail'

    multiplier = SUPPLY_DEMAND_MULTIPLIER.get(supply_type, 1.0)
    adjusted_ratio = ratio_pct * multiplier

    # 회전율 보너스 (상위 10%이면 1등급 업)
    turnover_bonus = turnover_rank_pct <= TURNOVER_BONUS_PERCENTILE

    # 등급 판정
    if adjusted_ratio >= TRADING_INTENSITY['폭발']:
        label = '폭발'
    elif adjusted_ratio >= TRADING_INTENSITY['급증']:
        label = '급증'
    elif adjusted_ratio >= TRADING_INTENSITY['활발']:
        label = '활발'
    else:
        label = '보통'

    # 회전율 보너스 적용 (1등급 업)
    if turnover_bonus and label != '폭발':
        upgrade = {'보통': '활발', '활발': '급증', '급증': '폭발'}
        label = upgrade.get(label, label)

    detail = {
        'ratio': round(ratio_pct, 1),
        'adjusted_ratio': round(adjusted_ratio, 1),
        'supply': supply_type,
        'multiplier': multiplier,
        'turnover_pct': turnover_rank_pct,
        'turnover_bonus': turnover_bonus,
    }

    return label, detail
