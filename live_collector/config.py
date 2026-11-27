"""설정 상수 — stock-rise collector/ 를 whyrise 로 옮긴 사본 (2026-11-27, stock-rise 의존 단계적 독립 2단계)

원본: stockgame4343-blip/stock-rise collector/ (7d99fe49). 로직은 그대로, 저장 위치만 whyrise 의
public/data/live/ 로 바꿨다 — whyrise public/data/ 의 기존 파일(rise-history·stock-history 등)과 섞이지 않게.
"""
import os

# 경로
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(BASE_DIR, 'public', 'data', 'live'))
COLLECTOR_DIR = os.path.dirname(os.path.abspath(__file__))
SECTOR_CACHE_PATH = os.path.join(COLLECTOR_DIR, 'sector_cache.json')
NEWS_HISTORY_PATH = os.path.join(COLLECTOR_DIR, 'news_history.json')
THEME_CACHE_PATH = os.path.join(COLLECTOR_DIR, 'theme_cache.json')
THEME_CACHE_DAYS = 30  # 테마 태그 캐시 유효기간 (일)
TAG_OVERRIDES_PATH = os.path.join(COLLECTOR_DIR, 'tag_overrides.json')
TAG_FEEDBACK_PATH = os.path.join(COLLECTOR_DIR, 'tag_feedback.json')
NAVER_MAPPING_PATH = os.path.join(COLLECTOR_DIR, 'naver_mapping.json')

# 수집 설정
TOP_N = 100
DATA_RETENTION_DAYS = 0  # 0 = 무한 보관 (cleanup_old_data 비활성화). 양수 설정 시 해당 일수 초과 JSON 자동 삭제
NEWS_HISTORY_DAYS = 7

# 종목 유형 whitelist — 네이버 API 응답의 stockEndType 중 수집 대상
# 'stock' = 일반 주식, 'etf' = 상장지수펀드, 'etn' = 상장지수증권, 'reits' = 리츠 등
# 빈 튜플이면 필터링 없음 (전부 수집). 일반 주식만 보려면 ('stock',).
ALLOWED_STOCK_END_TYPES = ('stock',)

# ── 테마 태그 선정: 뉴스 키워드와 매핑 테마명 교차 매칭 가중치 ──
# 네이버 매핑의 종목별 테마 풀에서 primary/secondary 를 고를 때,
# 뉴스에서 추출된 키워드와 테마명이 일치하면 당일 테마 등락률 위에 이 값을 더해 우선시.
# 당일 테마 등락률(보통 -5~+10%) 대비 충분히 크게 설정해야 실제 상승 원인과 맞는 테마가 올라감.
THEME_KEYWORD_MATCH_BOOST = 15.0      # 정확 매칭 (테마명 ↔ 키워드)
THEME_KEYWORD_PARTIAL_BOOST = 7.5     # 부분 매칭 (3자 이상 공통 substring)
# 뉴스 키워드 추출 시 상위 N개까지 사용
NEWS_KEYWORDS_TOP_N = 10

# 크롤링 설정
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
]
# 1.0~2.5s 시절 한 사이클 15~22분 → 15분 수집 그리드에 못 맞춰 단축 (평균 0.85s, 약 1.2req/s)
REQUEST_DELAY_MIN = 0.5
REQUEST_DELAY_MAX = 1.2

# ── 거래 강도 설정 ──
# 5일 평균 대비 기준 (%)
TRADING_INTENSITY = {
    '폭발': 500,
    '급증': 300,
    '활발': 150,
    '보통': 0,
}

# 수급 보정계수 (기관/외인 순매수 반영)
SUPPLY_DEMAND_MULTIPLIER = {
    'both':        1.3,   # 기관+외인 동반 순매수
    'institution': 1.1,   # 기관만 순매수
    'foreign':     1.1,   # 외인만 순매수
    'retail':      0.9,   # 개인만
}

# 회전율 보너스 (거래대금/시총 상위 10% → 1등급 업)
TURNOVER_BONUS_PERCENTILE = 10

# 주요 언론사 (상승 이유 생성 시 참고)
MAJOR_PRESS = [
    '한국경제', '매일경제', '연합뉴스', '조선비즈', '머니투데이',
    '이데일리', '서울경제', '파이낸셜뉴스', '헤럴드경제', '한국투자증권',
    '삼성증권', 'NH투자증권', '키움증권', 'KB증권',
]

# 뉴스 중복 판단 자카드 유사도 임계값
NEWS_DEDUP_THRESHOLD = 0.5

# ── 대장점수 설정 ──
# 연속출현 조회 기간 (거래일)
LEADER_HISTORY_DAYS = 5

# 거래강도(ti): 5일평균 대비 비율 → 점수
VOLUME_RATIO_THRESHOLDS = [(10.0, 12), (5.0, 9), (3.0, 7), (1.5, 4), (0.0, 2)]
# 거래강도(ti): 시총보정 회전율 → 점수
TURNOVER_THRESHOLDS = [(20.0, 5), (8.0, 3), (0.0, 1)]
# 시총 구간별 회전율 보정 배수 (대형주 동일 회전율이 더 의미있음)
MCAP_TURNOVER_MULT = [(1_000_000_000_000, 2.5), (300_000_000_000, 1.5), (0, 1.0)]
# 수급 보정 → 점수
SUPPLY_BONUS = {'both': 3, 'institution': 2, 'foreign': 2, 'none': 0}

# 테마파워(tp): 모멘텀(평균 등락률) → 점수
THEME_MOMENTUM_THRESHOLDS = [(25.0, 20), (20.0, 16), (15.0, 12), (12.0, 8), (0.0, 4)]
# 테마파워(tp): 지속일 → 점수
THEME_PERSIST_THRESHOLDS = [(4, 10), (3, 7), (2, 4), (1, 1)]
# 테마파워(tp): 종목 수 → 점수
THEME_BREADTH_THRESHOLDS = [(5, 5), (3, 3), (2, 2), (1, 1)]

# 대장성(tl): 연속 출현 hit_rate → 점수
LEADER_HITRATE_THRESHOLDS = [(1.0, 15), (0.75, 12), (0.5, 8), (0.01, 4)]
LEADER_HITRATE_FIRST = 2  # 첫 출현 시 기본점수

# 태그 없는 종목 기본점수
NO_TAG_TP_DEFAULT = 3
NO_TAG_TL_DEFAULT = 5
