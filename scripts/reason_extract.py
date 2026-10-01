"""뉴스 제목 → 급등 사유 한 줄 (규칙 기반 · LLM 없이 동작).

stock-rise(장중 수집)와 whyrise(마감 후 정제)가 같은 파일을 쓴다 — 두 저장소에 동일 사본.
수정 시 양쪽을 함께 바꿀 것: whyrise/scripts/reason_extract.py, stock-rise/collector/reason_extract.py

원칙
- 근거는 '그 종목 이름이 들어간, 그날(±3일) 기사 제목'뿐이다. 제목에 없는 사실을 만들지 않는다.
- 급등을 직접 다룬 기사([특징주]·'N%↑'·'상한가' 등)의 '원인 구절'을 우선한다.
- 하락·하한가·기부·인사·IR 참가·주담대 경고처럼 상승과 무관한 기사는 근거에서 뺀다.
- 동명이사(예: 한국공항 vs 한국공항公)는 이름 경계로 걸러낸다.

반환 (pick_reason)
  {'reason': str, 'confidence': 'high'|'mid'|'low', 'kind': 'move'|'catalyst'|'related'|'sector'
   |'rebound'|'analyst'|'delisting', 'evidence': [index], 'title': str}
  - high: 급등 기사가 원인을 명시 (예: "LK삼양, 국방부 드론에 카메라 모듈 공급…이틀째 상한가")
  - mid : 같은 날 종목 기사에 구체 사건(공급·특허·승인·수주 등)
  - low : 종목 기사지만 사건이 약함 → "관련 보도: …" 로 표기 / 업종 동반 강세 기사
"""
from __future__ import annotations

import html
import re
from datetime import datetime

REASON_MAX = 42
EVIDENCE_MAX_AGE_DAYS = 3

TAG_RE = re.compile(r'\[[^\[\]]{1,18}\]|【[^】]{1,18}】|〈[^〉]{1,18}〉|<[^<>]{1,18}>')
BROKER_NAMES = (r'(?:iM|KB|NH|DB|SK|IBK|BNK|LS|DS|키움|삼성|미래에셋|한투|한국투자|하나|신한|대신|유안타|교보|메리츠|'
                r'한화|현대차|이베스트|다올|상상인|신영|유진|하이|부국|케이프|한양|흥국|리딩|유화|카카오페이|토스)')
BROKER_TAIL_RE = re.compile(r'\s*[-–—]\s*([A-Za-z가-힣]{1,8}(?:투자증권|증권)?)\s*$'
                            r'|(?<=[”"’])\s*(' + BROKER_NAMES + r'(?:투자증권|증권)?)\s*$')
QUOTE_RE = re.compile(r'["“”‘’`\']')
BROKER_LEAD_RE = re.compile(r'^\s*([가-힣A-Za-z]{1,8}(?:투자증권|증권|證))\s*(?=["“‘\'])')
# "철강주, 알래스카 LNG 투자 기대에 강세" — 업종이 주어로 앞에 오는 형태
SECTOR_LEAD_RE = re.compile(r'^([가-힣A-Za-z0-9·]{1,12}?)(?:株|주),\s*(.+?)\s*(?:에|에도|으로|속에|덕에)\s*'
                            r'(?:장\s*초반\s*|일제히\s*|동반\s*)?(?:강세|급등|상승|들썩|훨훨|불기둥|상한가|껑충|강(?=\s*(?:…|⋯|\.{2,}|$)))')
SERIES_RE = re.compile(r'[①-⑳]|\((?:상|중|하|\d)\)|<\d>')
SEG_SPLIT_RE = re.compile(r'\s*(?:…|⋯|\.{2,}|··+|;)\s*')
TRUNC_TAIL_RE = re.compile(r'(?:…|⋯|\.{2,})\s*$')

# 주가 움직임 표현 (원인이 아님) — 원인 구절에서 지운다
MOVE_RE = re.compile(
    r"\d+(?:\.\d+)?\s*%\s*(?:대|이상|넘게|가까이|안팎)?\s*(?:↑|↓|급등|상승|강세|껑충|올라|오름|뛰어|뛴|치솟)"
    r"|(?:이틀|사흘|나흘|닷새|\d+\s*거래일|\d+일)\s*(?:째|연속)\s*(?:상한가|급등|강세|상승)"
    r"|장\s*(?:초반|중|마감)\s*(?:급등|강세|상승)?"
    r"|(?:주가\s*)?(?:상한가|급등세?|강세|훨훨|불기둥|껑충|들썩|날았다|치솟|폭등|오름세|상승세|상승\s*(?:마감|중|전환)|매수세(?:\s*유입)?|신고가|반등)"
    r"|'?上'?|↑")
MOVE_HINT_RE = re.compile(r"특징주|핫종목|급등|상한가|강세|↑|上|훨훨|불기둥|껑충|들썩|치솟|폭등|반등|신고가")
NEG_RE = re.compile(
    r'급락|하한가(?!\s*(?:딛|이후|뒤|후))|폭락|하락|약세|내림세|주의보|기부|성금|부고|별세|인사\b|취임|칼럼|사설|인터뷰|'
    r'콥데이|IR\s*참가|NDR|목표가\s*하향|매도\s*의견|조회공시|투자경고|투자주의|투자위험|거래\s*정지|불성실|'
    r'관리종목|감사의견|횡령|배임|압수수색|상장폐지')
REBOUND_RE = re.compile(r'(하한가|급락|폭락|낙폭)\s*(?:을\s*)?(?:딛고|이후|뒤|후|만에)\s*.*?반등|반등\s*성공')
DELIST_RE = re.compile(r'정리\s*매매')
ANALYST_RE = re.compile(r'목표\s*(?:주)?가\s*(?:([\d,.]+\s*만?\s*원)\s*(?:으로|로)?\s*)?(?:상향|올려|올렸)')
CATALYST_RE = re.compile(
    r'공급|계약|수주|특허|승인|허가|품목|임상|기술\s*이전|기술\s*수출|라이선스|인수|합병|M&A|'
    r'실적|흑자|영업\s*익|영업이익|매출|순이익|최대\s*(?:실적|매출)|공모|무상\s*증자|자사주|배당|소각|'
    r'선정|지정|협약|MOU|맞손|개발|출시|수출|투자\s*유치|양산|진출|편입|공개\s*매수|최대주주|경영권|'
    r'국책|예산|정책|납품|론칭|체결|파트너|입증|성공|돌파|증설|발표|확보|공개|낙찰|수혜|확정')
WEAK_ONLY_RE = re.compile(r'^(?:대표|회장|사장|CEO)\b|대표\s*["“]|“[^”]{0,30}”$')
SECTOR_MOVE_RE = re.compile(
    r"((?:[가-힣A-Za-z0-9·]{1,10}(?<![에데속만])\s)?[가-힣A-Za-z0-9·]{1,10}?)\s*(?:株|주|관련주|테마주)\s*(?:등\s*)?"
    r"(?:장\s*초반\s*|일제히\s*|동반\s*|줄줄이\s*|나란히\s*)?"
    r"(?:강세|급등|상승|들썩|훨훨|불기둥|상한가|껑충|강(?=\s*(?:…|⋯|\.{2,}|$)))")
SECTOR_WORD_RE = re.compile(r'^(?:[가-힣A-Za-z0-9·]{1,10}\s)?[가-힣A-Za-z0-9·]{1,10}?(?:株|주)$')
PARTICLE_TAIL_RE = re.compile(r'\s*(?:에도|에|으로|속에|속|덕에|덕분에)$')
NAME_FOLLOW_OK = re.compile(r'(?:은|는|이|가|을|를|의|에|에서|도|와|과|로|으로|만|까지|株|주가|측)(?![가-힣])|(?:株|측|주가)')
SECTOR_PREFIX = {'반도체', '2차전지', '이차전지', '원전', '방산', '조선', '바이오', '전력', 'AI', '로봇', '우주', '항공',
                 '자동차', '게임', '엔터', '화장품', '건설', '철강', '제약', '의료', '통신', '미디어', 'LNG', '수소',
                 '태양광', '풍력', '전선', '해운', '금융', '증권', '은행', '보험', '유리', 'HBM', '전기차', '배터리'}
STOP_SEGMENT = {'종합', '1보', '2보', '속보', '단독', '특징주', '핫종목'}


def _ymd(value) -> str:
    return re.sub(r'\D', '', str(value or ''))[:8]


def _days_before(event_ymd: str, news_ymd: str):
    try:
        return (datetime.strptime(event_ymd, '%Y%m%d') - datetime.strptime(news_ymd, '%Y%m%d')).days
    except ValueError:
        return None


def name_in(title: str, name: str) -> bool:
    """제목에 종목명이 '그 회사'로 등장하는지 — 한국공항公·디아이씨 같은 다른 회사 제외."""
    if not name or not title:
        return False
    start = 0
    while True:
        i = title.find(name, start)
        if i < 0:
            return False
        before = title[i - 1] if i > 0 else ''
        after = title[i + len(name):]
        ok_before = not before or not re.match(r'[가-힣]', before)
        if after[:1] == '公':
            ok_after = False
        elif not after or not re.match(r'[가-힣A-Za-z0-9]', after[0]):
            ok_after = True
        else:
            ok_after = bool(NAME_FOLLOW_OK.match(after))
        if ok_before and ok_after:
            return True
        start = i + 1


def clean_title(title: str) -> tuple[str, str, bool]:
    """(정리된 제목, 증권사 꼬리표, 잘림 여부)."""
    t = html.unescape(str(title or '')).strip()
    t = re.sub(r'<[^>]+>', '', t)
    truncated = bool(TRUNC_TAIL_RE.search(t))
    broker = ''
    m = BROKER_TAIL_RE.search(t)
    if m:
        broker = m.group(1) or m.group(2)
        t = t[:m.start()]
    lead = BROKER_LEAD_RE.match(t)
    if lead and not broker:
        broker = lead.group(1).replace('證', '증권')
        t = t[lead.end():]
    t = TAG_RE.sub(' ', t)
    t = re.sub(r'\((?:종합|\d보|속보)\)', ' ', t)
    t = QUOTE_RE.sub('', t)
    t = SERIES_RE.sub(' ', t)
    t = re.sub(r'\s+', ' ', t).strip(' ,·:-')
    return t, broker, truncated


def _remove_name(text: str, name: str) -> str:
    if not name:
        return text
    # 이름이 붙은 토큰 전체(예: GC녹십자웰빙) + 뒤따르는 조사/쉼표 제거
    return re.sub(r'[A-Za-z0-9]*' + re.escape(name) + r'(?:은|는|이|가|을|를|의|도|와|과|측)?\s*[,·]?\s*', ' ', text)


def _strip_moves(text: str) -> str:
    out = MOVE_RE.sub(' ', text)
    out = re.sub(r'\s+', ' ', out).strip(' ,·:-')
    return out


def _clip(text: str, n: int = REASON_MAX) -> str:
    text = re.sub(r'\s+', ' ', text).strip(' ,·:-')
    if len(text) <= n:
        return text
    cut = text[:n]
    sp = cut.rfind(' ')
    return (cut[:sp] if sp >= n * 0.6 else cut).rstrip(' ,·') + '…'


def _segments(clean: str, truncated: bool) -> list[str]:
    segs = [s.strip(' ,·:-') for s in SEG_SPLIT_RE.split(clean)]
    segs = [s for s in segs if s and s not in STOP_SEGMENT]
    if truncated and len(segs) > 1:
        segs = segs[:-1]          # 잘린 마지막 조각은 문장이 끊겨 있다
    elif truncated and segs and len(segs[-1].split()) >= 4:
        segs[-1] = segs[-1].rsplit(' ', 1)[0]   # 한 문장짜리 잘린 제목 — 끊긴 마지막 낱말만 버림
    return segs


def _cause_from_segment(seg: str, name: str) -> tuple[str, bool]:
    """세그먼트 → (원인 구절, 이 세그먼트가 종목/주가 움직임만 말하는가)."""
    has_name = bool(name) and name_in(seg, name)
    # "{원인}에 {업종}주 강세" — 업종 동반 상승 앞부분이 원인
    sm = SECTOR_MOVE_RE.search(seg)
    if sm:
        mb = re.search(r'^(.*\S)\s*(?:에도|에|으로|속에|속|덕에)\s*$', seg[:sm.start()].strip())
        if mb:
            return _clip(PARTICLE_TAIL_RE.sub('', mb.group(1))), False
    # "{원인}에 {종목} 강세" — 이름 앞부분이 원인
    if has_name:
        idx = seg.find(name)
        before = seg[:idx]
        mb = re.search(r'^(.*\S)\s*(?:에도|에|으로|속에|속|덕에)\s*$', before.strip())
        if mb and MOVE_HINT_RE.search(seg[idx:]):
            return _clip(PARTICLE_TAIL_RE.sub('', mb.group(1))), False
    parts = [p.strip() for p in re.split(r',\s*', seg) if p.strip()]
    kept = []
    for p in parts:
        if (has_name and not name_in(p, name) and MOVE_RE.search(p) and len(parts) > 1
                and not PARTICLE_TAIL_RE.search(_strip_moves(p))):
            continue                          # "…에 디앤디파마텍 상한가" — 다른 종목의 움직임
        core = _strip_moves(_remove_name(p, name)) if has_name else _strip_moves(p)
        core = re.sub(r'^(?:등|및|과|와)\s+', '', core).strip(' ,·')
        if has_name and name_in(p, name) and not CATALYST_RE.search(core) and len(core.replace(' ', '')) <= 8:
            continue                          # "하이스틸·세아제강 강세" 같은 '누가 올랐나' 조각
        if len(parts) > 1 and len(core.replace(' ', '')) <= 3 and not CATALYST_RE.search(core):
            continue                          # "화이자, …" 처럼 쉼표로 잘린 주어 조각
        if len(core.replace(' ', '')) < 3 or SECTOR_WORD_RE.match(core) or SECTOR_MOVE_RE.search(p):
            continue                          # "원전주 강세"·"반도체 장비株" — 업종 표기는 따로 붙인다
        kept.append(core)
    cause = PARTICLE_TAIL_RE.sub('', ', '.join(kept))
    return _clip(cause), not kept


def _sector_move(clean: str) -> str:
    m = SECTOR_MOVE_RE.search(clean)
    if not m:
        return ''
    words = m.group(1).strip('· ').split()
    # "삼전닉스 보합인데 반도체 장비" → 마지막 두 단어 중 업종어만
    words = [w for w in words if not re.search(r'(?:인데|지만|는데|에도|에|속)$', w)]
    # 앞 단어는 업종 수식어일 때만 ("반도체 장비주") — "다음 주자 로봇주"·"등 광통신주" 같은 조각 제외
    if len(words) >= 2 and words[-2] not in SECTOR_PREFIX:
        words = words[-1:]
    sector = ' '.join(words[-2:]).strip('·')
    if len(sector.replace(' ', '')) < 2 or sector in STOP_SEGMENT:
        return ''
    return f'{sector}주 강세'


MARKET_PHRASE_RE = re.compile(r'코스피|코스닥|지수|증시|마감|개장|\d{3,}선')


def _not_a_cause(text: str) -> bool:
    """업종 기사 앞부분이 원인이 아니라 시황·종목 나열인지."""
    t = (text or '').strip()
    if not t:
        return True
    if MARKET_PHRASE_RE.search(t):
        return True                           # "코스피 6,800선 붕괴" 같은 시황 문장
    if CATALYST_RE.search(t):
        return False
    return bool(re.search(r'\d+(?:\.\d+)?\s*%', t)
                or re.fullmatch(r'[가-힣A-Za-z0-9&]+(?:[·,]\s?[가-힣A-Za-z0-9&]+)+', t))


def analyse_title(title: str, name: str) -> dict | None:
    """한 기사 제목 → 원인 구절 후보. 근거로 못 쓰면 None."""
    clean, broker, truncated = clean_title(title)
    if not clean:
        return None
    named = name_in(clean, name)
    if DELIST_RE.search(clean) and named:
        return {'reason': '정리매매 기간 (상장폐지 절차)', 'kind': 'delisting', 'named': True, 'score': 99}
    if REBOUND_RE.search(clean) and named:
        return {'reason': '하한가·급락 후 반등', 'kind': 'rebound', 'named': True, 'score': 4}
    if NEG_RE.search(clean):
        return None
    am = ANALYST_RE.search(clean)
    if am and named:
        amount = (am.group(1) or '').replace(' ', '')
        label = f'증권사 목표가 {amount} 상향' if amount else '증권사 목표가 상향'
        return {'reason': label + (f' ({broker})' if broker else ''), 'kind': 'analyst', 'named': True, 'score': 3}

    lead = SECTOR_LEAD_RE.match(clean)
    if lead and not (named and name_in(lead.group(2), name)):
        sector_word = lead.group(1).strip('· ')
        cause = _clip(_strip_moves(lead.group(2)))
        if len(sector_word) >= 2 and len(cause.replace(' ', '')) >= 4 and not _not_a_cause(cause):
            return {'reason': _clip(f'{sector_word}주 동반 강세 — {cause}', REASON_MAX + 14), 'kind': 'sector',
                    'named': named, 'score': 2 if named else 1, 'broker': broker}
    segs = _segments(clean, truncated)
    is_move_article = bool(MOVE_HINT_RE.search(str(title)))
    causes = []
    for seg in segs:
        if (named and not name_in(seg, name) and MOVE_RE.search(seg) and not SECTOR_MOVE_RE.search(seg)
                and not PARTICLE_TAIL_RE.search(_strip_moves(seg))):
            continue                          # "기술이전 기대감 지놈앤컴퍼니 급등" — 다른 종목 이야기
        cause, who_only = _cause_from_segment(seg, name if named else '')
        if who_only or not cause:
            continue
        causes.append(cause)
    sector = _sector_move(clean)
    best = ''
    for c in causes:
        if CATALYST_RE.search(c):
            best = c
            break
    if not best and causes:
        best = causes[0]
    # 원인 구절이 업종 동반 강세 문장 그 자체이면 업종 표기로 통일
    if best and sector and _strip_moves(best).replace(' ', '') in sector.replace(' ', '').replace('주강세', ''):
        best = ''
    if not best and sector:
        return {'reason': f'{sector.replace(" 강세", "")} 동반 강세', 'kind': 'sector', 'named': named,
                'score': 2 if named else 1}
    if not best:
        return None
    weak = (bool(WEAK_ONLY_RE.search(html.unescape(str(title)))) or bool(WEAK_ONLY_RE.search(clean))
            or bool(SERIES_RE.search(str(title))))   # 연재·기획 기사(①②…)는 당일 재료가 아니다
    if named and broker and not is_move_article:
        # “{종목}, 수주 확대·실적 가시화” iM — 증권사 리포트 요약 제목
        return {'reason': _clip(f'{best} ({broker})'), 'kind': 'analyst', 'named': True, 'score': 3, 'broker': broker}
    if named and is_move_article:
        kind, score = 'move', 6 + (1 if CATALYST_RE.search(best) else 0)
    elif named and CATALYST_RE.search(best) and not weak:
        kind, score = 'catalyst', 4
    elif named:
        kind, score = 'related', 1
    else:
        if not sector:
            return None                       # 종목명 없는 기사는 '업종 동반 상승' 기사일 때만 근거
        kind, score = 'sector', 1
        if _not_a_cause(best):
            return {'reason': f'{sector.replace(" 강세", "")} 동반 강세', 'kind': 'sector', 'named': named,
                    'score': 1}                # "에스엠 17%·YG", "금호건설·금호건설우", "코스닥" — 원인 아님
        best = f'{sector.replace(" 강세", "")} 동반 강세 — {best}'
    return {'reason': _clip(best, REASON_MAX + 14 if kind == 'sector' else REASON_MAX), 'kind': kind,
            'named': named, 'score': score, 'broker': broker}


def theme_tokens(theme_tag: str = '', sector: str = '') -> list[str]:
    stop = {'중소형', '대형', '관련주', '테마', '업체', '소재', '부품', '장비', '기타', '신규상장', '상반기', '하반기',
            '거래량', '거래대금', '산업', '관련', '국내', '해외', '기업', '주요종목', '주요', '등'}
    out: list[str] = []
    for raw in (theme_tag or '', sector or ''):
        for w in re.sub(r'[()/·,\[\]]', ' ', raw).split():
            if len(w) < 2 or w in stop or w.isdigit():
                continue
            out.append(w)
            if len(w) >= 4 and re.fullmatch(r'[가-힣]+', w) and w[:2] not in stop:
                out.append(w[:2])
    return list(dict.fromkeys(out))


def pick_reason(name: str, news: list[dict], event_date: str, theme_tag: str = '', sector: str = '') -> dict | None:
    """종목 뉴스 목록 → 최선의 사유 1개 (없으면 None)."""
    ev = _ymd(event_date)
    tokens = theme_tokens(theme_tag, sector)
    best = None
    for i, n in enumerate(news or []):
        title = str((n or {}).get('title') or '')
        link = str((n or {}).get('link') or '')
        if not title or not link.startswith('http'):
            continue
        age = _days_before(ev, _ymd(n.get('date'))) if ev else 0
        if age is None or not 0 <= age <= EVIDENCE_MAX_AGE_DAYS:
            continue
        a = analyse_title(title, name)
        if not a:
            continue
        if not a['named']:
            # 종목명이 없는 기사는 같은 테마·업종 동반 상승 기사일 때만
            clean = clean_title(title)[0]
            if a['kind'] != 'sector' or not any(t in clean for t in tokens):
                continue
        score = a['score'] + (2 if age == 0 else 1 if age == 1 else 0)
        if a['kind'] == 'delisting':
            score = 999
        if best is None or score > best['_score']:
            best = dict(a, evidence=[i], title=title, _score=score)
    if not best:
        return None
    kind = best['kind']
    if kind in ('delisting',):
        conf = 'high'
    elif kind == 'move' and best['_score'] >= 8:
        conf = 'high'
    elif kind in ('move', 'catalyst', 'analyst', 'rebound'):
        conf = 'mid'
    else:
        conf = 'low'
    reason = best['reason']
    if conf == 'low' and kind == 'related':
        reason = '관련 보도: ' + _clip(clean_title(best['title'])[0].replace(name, '', 1).strip(' ,·:') or best['reason'], 60)
    return {'reason': reason, 'confidence': conf, 'kind': kind, 'evidence': best['evidence'], 'title': best['title']}


# 상류(stock-rise) 키워드 템플릿 사유 — 뉴스 키워드만 보고 만든 문구라 종목과 무관한 경우가 많다.
TEMPLATE_RE = re.compile(
    r'(?:관련\s*(?:뉴스|이슈|소식)|뉴스|보도|이슈|공시|발표|언급|관련|기록|급증|증가|테마\s*강세)$'
    r'|^(?:MOU 체결|계약 체결|공급 계약 체결|납품 계약 체결|라이선스 계약|흑자 전환|자사주 매입|자사주 소각|'
    r'특허 취득|임상 3상 진입|실실적 서프라이즈|실적 서프라이즈|경영진 교체|자본 구조 변경|주주환원 정책|'
    r'테마 대장주|테마 관련주|관세 정책 관련|국책사업 관련|보조금 관련|정부 정책 관련|증권사 리포트 공개|'
    r'외국인·기관 순매수|기관 순매수|외국인 순매수|상한가 — 사유 미수집|이유 분석 대기중|관련 뉴스 없음|'
    r'투자심리 개선 영향|바이오)$')


def is_template_reason(reason: str) -> bool:
    r = str(reason or '').strip()
    return (not r) or r == '-' or bool(TEMPLATE_RE.search(r))


WEAK_KINDS = ('sector', 'theme', 'related')


def should_replace(current: str, ex: dict | None) -> bool:
    """기존 사유를 기사 근거 결과(ex)로 바꿀지.

    키워드 템플릿·'52주 신고가' 같은 비(非)이유는 무엇으로든 교체하고, 이미 구체적인 사유
    ('전력반도체 MOU 체결')는 종목 자체 기사가 있을 때만 교체한다 — 업종·테마 동반이나
    '관련 보도'로 구체 사유를 덮지 않는다.
    """
    if not ex:
        return False
    cur = str(current or '').strip()
    if is_template_reason(cur) or re.match(r'^52주 신고가', cur):
        return True
    return ex.get('kind') not in WEAK_KINDS


# ── 하루 단위 맥락: 업종 동반 상승 기사 · 테마 동반 상승 ─────────────────────
# 종목 자체 기사가 없을 때, 같은 날 '업종 전체가 오른 이유'를 다룬 기사로 설명한다.
SECTOR_GROUPS = {
    '원전': ('원전', '원자력', 'SMR', '소형모듈원자로', '원자로'),
    '철강': ('철강', '강관', '제강', '스틸'),
    '반도체': ('반도체', 'HBM', '소부장', '시스템반도체', '온디바이스', '메모리', '파운드리', '소캠', 'SOCAMM', 'CXL'),
    '2차전지': ('2차전지', '이차전지', '배터리', '리튬', '양극재', '음극재', '전해질', '전고체'),
    '조선': ('조선', 'LNG선', '해운', '선박'),
    '방산': ('방산', '방위산업', '국방', 'K-방산', '드론'),
    '우주': ('우주', '항공우주', '위성', '누리호', '발사체'),
    '로봇': ('로봇', '휴머노이드', '협동로봇'),
    '바이오': ('바이오', '제약', '신약', '항암', '치매', '비만', 'mRNA', 'ADC', 'RNA', '면역', '바이오시밀러', '유전자', '줄기세포'),
    '화장품': ('화장품', 'K-뷰티', '뷰티', '화장'),
    '건설': ('건설', '재건', '시멘트'),
    '전력': ('전력', '전선', '변압기', '전력기기', '전력반도체', '송전', '전력망'),
    'AI': ('AI', '인공지능', '데이터센터'),
    '게임': ('게임',),
    '엔터': ('엔터', 'K-POP', '음반', '아이돌'),
    '자동차': ('자동차', '차부품', '완성차'),
    '가스': ('LNG', '가스', '셰일'),
}
# 기사 쪽 업종 표현 → 그룹 (기사는 '장비주'·'삼전닉스'처럼 줄여 쓴다)
ARTICLE_ALIASES = {'장비': '반도체', '삼전닉스': '반도체', '소부장': '반도체', '반도체': '반도체', '제강': '철강',
                   '강관': '철강', '철강': '철강', '원전': '원전', '원자력': '원전', '조선': '조선', '방산': '방산',
                   '우주': '우주', '로봇': '로봇', '바이오': '바이오', '제약': '바이오', '화장품': '화장품',
                   '건설': '건설', '전력': '전력', '전선': '전력', '2차전지': '2차전지', '이차전지': '2차전지',
                   '배터리': '2차전지', '게임': '게임', '엔터': '엔터', '자동차': '자동차', '가스관': '가스', 'LNG': '가스'}
# WICS 업종명(정확히 일치할 때만) → 그룹
WICS_GROUPS = {'반도체와반도체장비': '반도체', '철강': '철강', '조선': '조선', '우주항공과국방': '방산', '제약': '바이오',
               '생물공학': '바이오', '화장품': '화장품', '건설': '건설', '전기장비': '전력', '자동차부품': '자동차',
               '자동차': '자동차', '게임엔터테인먼트': '게임', '양방향미디어와서비스': None}
GROUP_LABEL = {'AI': 'AI 관련주', '가스': 'LNG·가스관 관련주', '엔터': '엔터주', '자동차': '자동차·부품주', '2차전지': '2차전지주'}
IPO_RE = re.compile(r'신규\s*상장')
THEME_JUNK = {'거래량', '거래대금', '보도', '테마', '뉴스'}


def sector_groups_of(theme: str, wics: str = '') -> set:
    """테마 태그(단어 시작 일치) + WICS 업종(정확 일치) → 업종 그룹. '건강관리'의 '강관' 같은 오매칭 방지."""
    words = [w for w in re.split(r'[\s()/·,\[\]（）]+', str(theme or '')) if w]
    out = {g for g, keys in SECTOR_GROUPS.items() if any(w.startswith(k) for w in words for k in keys)}
    g = WICS_GROUPS.get(str(wics or '').strip())
    if g:
        out.add(g)
    return out


def article_groups_of(sector_phrase: str) -> set:
    out = set()
    for w in re.split(r'[\s·,/]+', sector_phrase.replace('주 강세', '').replace('株', '')):
        for k, g in ARTICLE_ALIASES.items():
            if w.startswith(k) or w.endswith(k):
                out.add(g)
    return out


def build_day_context(rows: list[dict], day: str, min_rate: float = 10.0) -> dict:
    """그날 전 종목 뉴스 풀 → 업종별 대표 원인 기사, 테마별 동반 상승 수."""
    ev = _ymd(day)
    seen, pool = set(), []
    for r in rows or []:
        for n in (r or {}).get('news') or []:
            title = str((n or {}).get('title') or '')
            link = str((n or {}).get('link') or '')
            if not title or title in seen or not link.startswith('http') or _ymd(n.get('date')) != ev:
                continue
            seen.add(title)
            pool.append(n)
    sector_causes: dict[str, dict] = {}
    for n in pool:
        clean, _, truncated = clean_title(n['title'])
        if NEG_RE.search(clean):
            continue
        sector = _sector_move(clean)
        segs = _segments(clean, truncated)
        lead = None if sector else SECTOR_LEAD_RE.match(clean)
        if lead:
            sector = f'{lead.group(1).strip("· ")}주 강세'
            causes = [_clip(_strip_moves(lead.group(2)))]
        elif not sector:
            continue
        else:
            causes = []
            for seg in segs:
                c, who_only = _cause_from_segment(seg, '')
                if c and not who_only and not SECTOR_MOVE_RE.search(seg):
                    causes.append(c)
        cause = next((c for c in causes if CATALYST_RE.search(c)), causes[0] if causes else '')
        if _not_a_cause(cause):
            continue                          # 시황 문장·종목 나열은 원인이 아니다
        score = (3 if '특징주' in n['title'] else 0) + (2 if CATALYST_RE.search(cause) else 0) + len(segs)
        for g in article_groups_of(sector):
            cur = sector_causes.get(g)
            if not cur or score > cur['_score']:
                label = GROUP_LABEL.get(g, f'{g}주')
                sector_causes[g] = {'reason': _clip(f'{label} 동반 강세 — {cause}', REASON_MAX + 14),
                                    'item': dict(n), '_score': score, 'group': g}
    themes: dict[str, int] = {}
    for r in rows or []:
        tag = str((r or {}).get('theme_tag') or '').strip()
        if not tag or tag in THEME_JUNK or IPO_RE.search(tag):
            continue
        if (r.get('change_rate') or 0) >= min_rate:
            themes[tag] = themes.get(tag, 0) + 1
    return {'day': ev, 'sector_causes': sector_causes, 'themes': themes, 'pool': len(pool)}


def _theme_short(tag: str) -> str:
    return re.sub(r'\s*[\(（][^)）]*[\)）]', '', str(tag or '')).split('/')[0].strip()


def explain(row: dict, day: str, ctx: dict | None = None) -> dict | None:
    """종목 1개 → 사유. 우선순위: 종목 기사(강·중) > 신규상장 > 업종 동반 기사 > 종목 기사(약) > 테마 동반 상승.

    반환에 'evidence_items'(근거 기사 원본)가 있으면 그대로 저장한다(업종 기사는 종목 뉴스 목록 밖일 수 있다).
    """
    name = row.get('name') or ''
    theme = str(row.get('theme_tag') or '')
    news = row.get('news') or []
    p = pick_reason(name, news, day, theme, row.get('sector') or '')
    if p and p['confidence'] in ('high', 'mid'):
        return dict(p, evidence_items=[news[i] for i in p['evidence'] if 0 <= i < len(news)])
    tags = ' '.join([theme] + [str(t) for t in (row.get('theme_tags') or [])])
    if IPO_RE.search(tags) and float(row.get('change_rate') or 0) > 30.5:
        # 가격제한폭(±30%)을 넘는 상승은 상장 첫날(공모가 기준)뿐 — '신규상장' 태그는 반기 단위라 단독으론 안 쓴다
        return {'reason': '상장 첫날 (공모가 대비)', 'confidence': 'high', 'kind': 'ipo', 'evidence': [], 'evidence_items': []}
    ctx = ctx or {}
    groups = sector_groups_of(theme, row.get('sector') or '')
    for g in sorted(groups):
        sc = (ctx.get('sector_causes') or {}).get(g)
        if sc:
            return {'reason': sc['reason'], 'confidence': 'low', 'kind': 'sector', 'evidence': [],
                    'evidence_items': [sc['item']], 'title': sc['item'].get('title', '')}
    if p:
        return dict(p, evidence_items=[news[i] for i in p['evidence'] if 0 <= i < len(news)])
    n = (ctx.get('themes') or {}).get(theme.strip(), 0)
    short = _theme_short(theme)
    if n >= 3 and short and short not in THEME_JUNK:
        return {'reason': f'{short} 테마 {n}종목 동반 상승', 'confidence': 'low', 'kind': 'theme',
                'evidence': [], 'evidence_items': []}
    return None


# ── 표시 규칙 (public/js/reason.js 와 동일) ─────────────────────────────────
TRUSTED_SOURCES = ('llm', 'news_headline', 'news_extract', 'admin')
KIND_LABEL = {'move': '기사', 'catalyst': '기사', 'analyst': '리포트', 'rebound': '기사', 'delisting': '정리매매',
              'sector': '업종', 'theme': '테마', 'ipo': '신규상장', 'related': '', 'none': ''}
UNKNOWN_TEXT = '이유 확인 중'


def display(row: dict) -> dict:
    """사이트·정적 페이지·텔레그램 공통 — {'text','unknown','label','link','title'}"""
    row = row or {}
    reason = str(row.get('rise_reason') or '').strip()
    trusted = (row.get('reason_status') == 'edited' or row.get('reason_source') in TRUSTED_SOURCES
               or row.get('reason_origin') in ('news', 'toss'))
    if not trusted and (reason in ('', '-') or is_template_reason(reason) or re.search(r'테마\s*강세$|^바이오$', reason)):
        reason = ''
    if not reason and (row.get('change_rate') or 0) > 30.5 and not str(row.get('rise_reason') or '').startswith('정리매매') \
            and IPO_RE.search(' '.join([str(row.get('theme_tag') or '')] + [str(t) for t in row.get('theme_tags') or []])):
        # 가격제한폭(±30%)을 넘는 상승은 신규상장 첫날뿐
        return {'text': '상장 첫날 (공모가 대비)', 'unknown': False, 'label': '신규상장', 'link': '', 'title': '',
                'kind': 'ipo', 'confidence': 'high'}
    ev = None
    if reason:
        for it in row.get('reason_evidence') or []:
            if str((it or {}).get('link') or '').startswith('https://'):
                ev = it
                break
    label = ''
    if reason:
        if row.get('reason_source') == 'llm':
            label = 'AI'
        elif row.get('reason_origin') == 'toss' and row.get('reason_source') in (None, '', 'stockrise'):
            label = '토스 AI'
        elif row.get('reason_kind') in KIND_LABEL:
            label = KIND_LABEL[row['reason_kind']]
        elif ev:
            label = '기사'
    return {'text': reason or UNKNOWN_TEXT, 'unknown': not reason, 'label': label,
            'link': (ev or {}).get('link', ''), 'title': (ev or {}).get('title', ''),
            'kind': row.get('reason_kind') or '', 'confidence': row.get('reason_confidence') or ''}
