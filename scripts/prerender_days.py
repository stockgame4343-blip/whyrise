"""날짜별 급등주 SEO 페이지 — rise-history/{date}.json → public/day/{date}.html 정적 생성.

왜: "9월 30일 상한가", "오늘 급등주 이유" 같은 날짜 검색은 종목 페이지(/stock/)로는
받지 못한다. 사이트의 날짜 화면(rise.html?date=)은 JS 렌더라 크롤러가 빈 셸만 본다.
매 거래일 1페이지씩 쌓이는 정적 아카이브가 검색 유입의 두 번째 축이 된다.

- 출력은 결정적(빌드 시각 없음) — 데이터가 같으면 파일 바이트가 같아 git diff 가 생기지 않는다.
- 오늘 날짜는 장 마감(15:40 KST) 이후에만 만든다(장중 부분 데이터가 '하루 결과'로 색인되는 것 방지).
- 같은 날 기사 근거가 없으면 빈칸 대신 단서(최근 이슈·키워드 추정·테마)를 흐리게 + 라벨로 표기한다.

    python scripts/prerender_days.py            # 전체 날짜
    python scripts/prerender_days.py 20260930   # 특정 날짜만
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from scripts.llm_reasons import is_generic  # noqa: E402,F401
from scripts.reason_extract import display as rx_display  # noqa: E402

SITE = 'https://orgo.kr'
PUBLIC = ROOT / 'public'
RISE_DIR = PUBLIC / 'data' / 'rise-history'
CALENDAR = PUBLIC / 'data' / 'leaders-calendar.json'
OUT_DIR = PUBLIC / 'day'
KST = timezone(timedelta(hours=9))
MIN_RATE = 10.0          # 사이트 타임라인 노출 기준과 동일
HOT_RATE = 15.0          # 텔레그램·캘린더 '급등' 기준
LIMIT_RATE = 29.5        # 상한가 근접
MAX_ROWS = 80
WEEKDAYS = '월화수목금토일'
JUNK_THEMES = {'거래량', '거래대금'}
CSS_VER = '20261001a'


def _esc(s) -> str:
    return (str(s or '').replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def _d(ymd: str) -> datetime:
    return datetime.strptime(ymd, '%Y%m%d')


def label_long(ymd: str) -> str:
    d = _d(ymd)
    return f'{d.year}년 {d.month}월 {d.day}일({WEEKDAYS[d.weekday()]})'


def label_short(ymd: str) -> str:
    d = _d(ymd)
    return f'{d.month}월 {d.day}일'


def _amount(won) -> str:
    try:
        v = float(won or 0)
    except (TypeError, ValueError):
        return ''
    if v >= 1e12:
        return f'{v / 1e12:.1f}조'
    if v >= 1e8:
        return f'{v / 1e8:,.0f}억'
    return ''


def is_delisting(row: dict) -> bool:
    return str(row.get('rise_reason') or '').startswith('정리매매')


def is_new_listing(row: dict) -> bool:
    return '신규상장' in str(row.get('theme_tag') or '')


def display_reason(row: dict) -> str:
    d = rx_display(row)
    return '' if d['unknown'] else d['text']


def _named_news(row: dict) -> dict | None:
    name = row.get('name') or ''
    for n in row.get('news') or []:
        title = str(n.get('title') or '')
        link = str(n.get('link') or '')
        if name and name in title and link.startswith('https://'):
            return n
    return None


def theme_groups(rows: list[dict], min_count: int = 2) -> list[dict]:
    by: dict[str, dict] = {}
    for r in rows:
        tag = str(r.get('theme_tag') or '').strip()
        if not tag or tag in JUNK_THEMES or '신규상장' in tag:
            continue
        g = by.setdefault(tag, {'name': tag, 'count': 0, 'sum': 0.0, 'top': r})
        g['count'] += 1
        g['sum'] += float(r.get('change_rate') or 0)
        if float(r.get('change_rate') or 0) > float(g['top'].get('change_rate') or 0):
            g['top'] = r
    out = [dict(g, avg=g['sum'] / g['count']) for g in by.values() if g['count'] >= min_count]
    return sorted(out, key=lambda g: (-g['count'], -g['avg'], g['name']))


def load_day(ymd: str) -> dict | None:
    p = RISE_DIR / f'{ymd}.json'
    try:
        day = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return None
    if str(day.get('date')) != ymd or not isinstance(day.get('rankings'), list):
        return None
    return day


def load_snapshot(ymd: str) -> list[dict]:
    """같은 날 marketmap 스냅샷 — rise-history(OHLC 이벤트 기반)에 빠진 급등주 보충용.

    상장 초기 종목(전일 종가 없음)이나 빌드 시점 OHLC 지연으로 이벤트가 안 생긴 종목이
    있어, 텔레그램·발행실(marketing_digest)과 같은 방식으로 합쳐 숫자를 맞춘다.
    """
    try:
        mm = json.loads((PUBLIC / 'data' / 'marketmap' / f'{ymd}.json').read_text(encoding='utf-8'))
    except Exception:
        return []
    if str(mm.get('date') or '').replace('-', '')[:8] != ymd or not isinstance(mm.get('items'), list):
        return []
    out = []
    for it in mm['items']:
        if not re.fullmatch(r'[0-9A-Z]{6}', str(it.get('ticker') or '')) or not it.get('name'):
            continue
        if not isinstance(it.get('change_rate'), (int, float)):
            continue
        out.append({'ticker': it['ticker'], 'name': it['name'], 'market': it.get('market') or '',
                    'change_rate': float(it['change_rate']), 'trading_value': it.get('trading_value') or 0,
                    'sector': it.get('sector') or '', 'rise_reason': '', 'theme_tag': '', 'news': []})
    return out


def page_rows(day: dict, snapshot: list[dict] | None = None) -> tuple[list[dict], list[dict]]:
    seen, rows, delisting = set(), [], []
    merged = list(day['rankings'])
    known = {r.get('ticker') for r in merged}
    merged += [r for r in (snapshot or []) if r['ticker'] not in known]
    for r in sorted(merged, key=lambda r: -(r.get('change_rate') or 0)):
        t = r.get('ticker')
        if not t or t in seen or not re.fullmatch(r'[0-9A-Z]{6}', t):
            continue
        if not isinstance(r.get('change_rate'), (int, float)) or r['change_rate'] < MIN_RATE:
            continue
        seen.add(t)
        (delisting if is_delisting(r) else rows).append(r)
    return rows, delisting


def summary_line(ymd: str, rows: list[dict], leader: dict | None, groups: list[dict]) -> str:
    hot = [r for r in rows if r['change_rate'] >= HOT_RATE]
    limit = [r for r in rows if r['change_rate'] >= LIMIT_RATE]
    parts = [f'{label_short(ymd)} +15% 이상 {len(hot)}종목']
    if limit:
        parts.append(f'상한가 근접 {len(limit)}종목')
    if groups:
        g = groups[0]
        parts.append(f'{g["name"]} {g["count"]}종목 평균 +{g["avg"]:.1f}%')
    if leader and leader.get('name'):
        parts.append(f'대장 {leader["name"]} +{float(leader.get("rate") or 0):.1f}%')
    return ' · '.join(parts)


def _ld_dumps(data) -> str:
    """JSON-LD 안의 '<', '>', '&' 를 유니코드 이스케이프 — 데이터가 </script> 로 태그를 닫지 못하게."""
    return (json.dumps(data, ensure_ascii=False)
            .replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026'))


def _json_ld(ymd: str, title: str, desc: str, rows: list[dict]) -> str:
    url = f'{SITE}/day/{ymd}'
    data = {
        '@context': 'https://schema.org',
        '@graph': [
            {'@type': 'WebPage', 'name': title, 'url': url, 'description': desc,
             'inLanguage': 'ko', 'datePublished': f'{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}'},
            {'@type': 'BreadcrumbList', 'itemListElement': [
                {'@type': 'ListItem', 'position': 1, 'name': 'ORGO', 'item': f'{SITE}/'},
                {'@type': 'ListItem', 'position': 2, 'name': '날짜별 급등주', 'item': f'{SITE}/day/'},
                {'@type': 'ListItem', 'position': 3, 'name': label_short(ymd), 'item': url},
            ]},
            {'@type': 'ItemList', 'name': f'{label_short(ymd)} 급등주', 'numberOfItems': len(rows[:20]),
             'itemListElement': [
                 {'@type': 'ListItem', 'position': i + 1, 'name': r['name'],
                  'url': f'{SITE}/stock/{r["ticker"]}'} for i, r in enumerate(rows[:20])]},
        ],
    }
    return '<script type="application/ld+json">' + _ld_dumps(data) + '</script>'


HEAD = '''<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>{title}</title>
    <meta name="description" content="{desc}">
    <meta name="naver-site-verification" content="d1fa48b231a7701c86a0da43d87179bc4e40dc9d" />
    <meta name="theme-color" content="#0a0b0f">
    <meta name="robots" content="{robots}">
    <meta name="googlebot" content="{robots},max-image-preview:large,max-snippet:-1">
    <link rel="canonical" href="{canonical}">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="ORGO">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{desc}">
    <meta property="og:url" content="{canonical}">
    <meta property="og:image" content="{og_image}">
    <meta property="og:locale" content="ko_KR">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{title}">
    <meta name="twitter:description" content="{desc}">
    <meta name="twitter:image" content="{og_image}">
    <link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
    <link rel="stylesheet" href="/css/style.css?v=20260702a">
    <link rel="stylesheet" href="/css/whyrise.css?v=20261002c">
    <link rel="stylesheet" href="/css/app-shell.css?v=20260702c">
    <link rel="stylesheet" href="/css/day.css?v={css_ver}">
    {json_ld}
</head>
<body>
    <script>(function(){{try{{if((localStorage.getItem('theme')||'dark')==='light')document.documentElement.setAttribute('data-theme','light');}}catch(e){{}}}})();</script>
    <header class="top-bar">
        <div class="top-bar__inner frame">
            <a class="top-bar__logo" href="/" aria-label="ORGO 홈"><strong style="font-size:26px;font-weight:900;letter-spacing:-1.5px">ORGO</strong></a>
            <nav class="top-bar__nav">
                <a href="/" class="top-bar__link">홈</a>
                <a href="/day/" class="top-bar__link">날짜별</a>
                <a href="/report.html" class="top-bar__link">리포트</a>
                <a href="/sample2.html" class="top-bar__link">대장캘린더</a>
                <a href="/leaders2.html" class="top-bar__link">시각화</a>
            </nav>
        </div>
    </header>
    <main class="frame day-page">
'''

FOOT = '''
        <p class="day-cta">매일 장전·장중·마감 흐름은 텔레그램으로 받아보세요 → <a href="https://t.me/whyorgo" rel="noopener">t.me/whyorgo</a></p>
    </main>
    <div class="footer"><footer class="footer__wrap"><div class="frame footer__inner">
        <p class="footer__links"><a href="/policy.html#terms">이용약관</a><span>·</span><a href="/policy.html#privacy">개인정보처리방침</a><span>·</span><a href="/policy.html#data">데이터·뉴스 정책</a><span>·</span><a href="/policy.html#contact">문의</a></p>
        <p class="footer__disclaimer"><strong>본 사이트는 유사투자자문업 신고를 하지 않았으며, 어떠한 형태의 투자자문·종목 추천·매수/매도 권유도 제공하지 않습니다.</strong><br>모든 정보는 공개 데이터를 기계적으로 집계한 과거 기록으로 오류·지연이 있을 수 있으며, 투자 판단과 그 손익은 이용자 본인 책임입니다. '관련 보도'는 같은 날 보도 제목을 인용한 것으로 상승 원인을 확정하지 않습니다.</p>
        <p class="footer__copy">&copy; 2026 ORGO.</p>
    </div></footer></div>
</body>
</html>
'''


def render_day(ymd: str, day: dict, calendar_day: dict | None, prev_ymd: str, next_ymd: str,
               snapshot: list[dict] | None = None) -> str:
    rows, delisting = page_rows(day, snapshot)
    hot = [r for r in rows if r['change_rate'] >= HOT_RATE]
    groups = theme_groups(hot) or theme_groups(rows)
    leader = (calendar_day or {}).get('stock')
    title = f'{label_long(ymd)} 급등주·상한가, 왜 올랐나 | ORGO'
    desc = summary_line(ymd, rows, leader, groups) + '. 종목별 상승 이유와 같은 날 관련 보도를 정리했습니다.'
    desc = desc[:155]
    canonical = f'{SITE}/day/{ymd}'
    og_image = f'{SITE}/og-default.png'
    robots = 'index,follow' if rows else 'noindex,follow'

    parts = [HEAD.format(title=_esc(title), desc=_esc(desc), canonical=canonical, og_image=og_image,
                         robots=robots, css_ver=CSS_VER, json_ld=_json_ld(ymd, title, desc, rows))]
    parts.append(f'        <p class="day-crumb"><a href="/">홈</a> › <a href="/day/">날짜별 급등주</a> › {label_short(ymd)}</p>')
    parts.append(f'        <h1>{_esc(label_long(ymd))} 급등주, 왜 올랐나</h1>')
    parts.append(f'        <p class="day-lead">{_esc(summary_line(ymd, rows, leader, groups))}. '
                 'ORGO가 장 마감 기준으로 +10% 이상 오른 종목과 같은 날 보도를 모았습니다.</p>')

    cards = [('+15% 이상', f'{len(hot)}종목'),
             ('상한가 근접(+29.5%↑)', f'{sum(1 for r in rows if r["change_rate"] >= LIMIT_RATE)}종목')]
    if leader and leader.get('name'):
        ipo = ' (상장 첫날)' if leader.get('listing_day') else ''
        cards.append(('오늘의 대장', f'{leader["name"]}{ipo} +{float(leader.get("rate") or 0):.1f}%'))
    if groups:
        cards.append(('많이 오른 테마', f'{groups[0]["name"]} {groups[0]["count"]}종목'))
    parts.append('        <div class="day-cards">' + ''.join(
        f'<div class="day-card"><b>{_esc(k)}</b><span>{_esc(v)}</span></div>' for k, v in cards) + '</div>')

    if groups:
        parts.append('        <h2>테마별로 보면</h2>\n        <ul class="day-groups">' + ''.join(
            f'<li><strong>{_esc(g["name"])}</strong> {g["count"]}종목 · 평균 +{g["avg"]:.1f}% '
            f'(최고 <a href="/stock/{g["top"]["ticker"]}">{_esc(g["top"]["name"])}</a> '
            f'+{g["top"]["change_rate"]:.1f}%)</li>' for g in groups[:6]) + '</ul>')

    if rows:
        parts.append('        <h2>오른 종목과 이유</h2>')
        trs = []
        for r in rows[:MAX_ROWS]:
            d = rx_display(r)
            if d['unknown'] and leader and leader.get('listing_day') and leader.get('ticker') == r.get('ticker'):
                # 상장 첫날 대장 — rise-history(OHLC 기반)엔 없고 스냅샷으로만 들어오는 종목
                d = dict(d, text='상장 첫날 (공모가 대비)', unknown=False, label='신규상장', link='')
            tags = ''
            if is_new_listing(r):
                tags += '<span class="day-tag">신규상장</span>'
            theme = str(r.get('theme_tag') or '').strip()
            if theme and theme not in JUNK_THEMES and '신규상장' not in theme:
                tags += f'<span class="day-tag">{_esc(theme)}</span>'
            # 리스트는 출처 태그 없이 문장만 — 같은 날 근거 없는 단서(최근 이슈·추정·테마)는 흐린 글씨
            why = (f'<span class="day-reason{" day-reason--none" if d.get("hint") else ""}">'
                   f'{_esc(d["text"])}</span>')
            trs.append(
                f'<tr><td><a href="/stock/{r["ticker"]}">{_esc(r["name"])}</a>{tags}{why}</td>'
                f'<td class="r">+{r["change_rate"]:.1f}%</td>'
                f'<td class="v hide-sm">{_esc(_amount(r.get("trading_value")))}</td></tr>')
        more = len(rows) - min(len(rows), MAX_ROWS)
        if more > 0:
            trs.append(f'<tr><td colspan="3">… 외 {more}종목</td></tr>')
        parts.append('        <table class="day-table"><thead><tr><th>종목 · 이유</th><th class="r">등락률</th>'
                     '<th class="v hide-sm">거래대금</th></tr></thead><tbody>' + ''.join(trs) + '</tbody></table>')
    else:
        parts.append('        <p class="day-lead">이 날은 +10% 이상 오른 종목 기록이 없습니다.</p>')

    if delisting:
        parts.append('        <p class="day-lead" style="margin-top:16px">정리매매(상장폐지 절차) 종목은 급등 집계에서 제외했습니다: '
                     + ', '.join(_esc(r['name']) for r in delisting) + '.</p>')

    nav_prev = f'<a href="/day/{prev_ymd}">← {label_short(prev_ymd)} 급등주</a>' if prev_ymd else '<span></span>'
    nav_next = f'<a href="/day/{next_ymd}">{label_short(next_ymd)} 급등주 →</a>' if next_ymd else '<span></span>'
    parts.append(f'        <nav class="day-nav">{nav_prev}<a href="/rise.html?date={ymd}">인터랙티브 화면으로 보기</a>{nav_next}</nav>')
    parts.append(FOOT)
    return '\n'.join(parts)


def render_index(entries: list[tuple[str, int, str]]) -> str:
    title = '날짜별 급등주·상한가 기록 — 그날 왜 올랐나 | ORGO'
    desc = '거래일마다 +10% 이상 오른 한국 주식과 상승 이유, 테마, 대장주를 날짜별로 정리한 아카이브.'
    canonical = f'{SITE}/day/'
    ld = ('<script type="application/ld+json">' + _ld_dumps({
        '@context': 'https://schema.org', '@type': 'CollectionPage', 'name': title, 'url': canonical,
        'description': desc, 'inLanguage': 'ko'}) + '</script>')
    parts = [HEAD.format(title=_esc(title), desc=_esc(desc), canonical=canonical,
                         og_image=f'{SITE}/og-default.png', robots='index,follow', css_ver=CSS_VER, json_ld=ld)]
    parts.append('        <p class="day-crumb"><a href="/">홈</a> › 날짜별 급등주</p>')
    parts.append('        <h1>날짜별 급등주 기록</h1>')
    parts.append('        <p class="day-lead">거래일마다 많이 오른 종목과 이유를 남겨둡니다. 날짜를 누르면 그날의 종목·테마·관련 보도를 볼 수 있어요.</p>')
    by_month: dict[str, list] = {}
    for ymd, hot, leader in entries:
        by_month.setdefault(ymd[:6], []).append((ymd, hot, leader))
    for month in sorted(by_month, reverse=True):
        items = sorted(by_month[month], reverse=True)
        parts.append(f'        <section class="day-month"><h2>{month[:4]}년 {int(month[4:])}월</h2><ul>' + ''.join(
            f'<li><a href="/day/{ymd}">{label_long(ymd)}</a> <span>+15% {hot}종목'
            + (f' · 대장 {_esc(leader)}' if leader else '') + '</span></li>' for ymd, hot, leader in items) + '</ul></section>')
    parts.append(FOOT)
    return '\n'.join(parts)


def publishable_dates(now: datetime | None = None) -> list[str]:
    now = now or datetime.now(KST)
    today = now.strftime('%Y%m%d')
    try:
        dates = json.loads((RISE_DIR / 'dates.json').read_text(encoding='utf-8'))
    except Exception:
        dates = [p.stem for p in RISE_DIR.glob('*.json') if re.fullmatch(r'\d{8}', p.stem)]
    out = []
    for d in sorted(set(str(x) for x in dates)):
        if not re.fullmatch(r'\d{8}', d) or d > today:
            continue
        if d == today and now.strftime('%H%M') < '1540':
            continue
        out.append(d)
    return out


def _write_if_changed(path: Path, text: str) -> bool:
    try:
        if path.exists() and path.read_text(encoding='utf-8') == text:
            return False
    except Exception:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return True


def build_day_pages(only: str = '', now: datetime | None = None) -> dict:
    dates = publishable_dates(now)
    try:
        cal_days = json.loads(CALENDAR.read_text(encoding='utf-8')).get('days') or {}
    except Exception:
        cal_days = {}
    written = same = 0
    entries = []
    for i, ymd in enumerate(dates):
        day = load_day(ymd)
        if not day:
            continue
        snapshot = load_snapshot(ymd)
        rows, _ = page_rows(day, snapshot)
        leader = (cal_days.get(ymd) or {}).get('stock') or {}
        entries.append((ymd, sum(1 for r in rows if r['change_rate'] >= HOT_RATE), leader.get('name') or ''))
        if only and ymd != only:
            continue
        prev_ymd = dates[i - 1] if i > 0 else ''
        next_ymd = dates[i + 1] if i + 1 < len(dates) else ''
        html = render_day(ymd, day, cal_days.get(ymd), prev_ymd, next_ymd, snapshot)
        if _write_if_changed(OUT_DIR / f'{ymd}.html', html):
            written += 1
        else:
            same += 1
    if _write_if_changed(OUT_DIR / 'index.html', render_index(entries)):
        written += 1
    print(f'  [prerender-days] day/*.html: {written} 갱신, {same} 동일 (날짜 {len(entries)}개)')
    return {'written': written, 'same': same, 'dates': [e[0] for e in entries]}


if __name__ == '__main__':
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg and not re.fullmatch(r'\d{8}', arg):
        sys.exit('usage: prerender_days.py [YYYYMMDD]')
    build_day_pages(arg)
