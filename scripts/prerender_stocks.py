"""종목 상세 SEO 프리렌더 — stock-history JSON → public/stock/{ticker}.html 정적 생성.

왜: /stock/{ticker} 는 클라이언트 JS 렌더라 크롤러(네이버·구글)가 빈 셸만 봤다.
"{종목명} 왜 오름 / 급등 이유" 롱테일 검색을 받으려면 정적 스냅샷이 필요하다.

방식: public/stock.html 을 템플릿으로 읽어 종목별 title/desc/canonical/OG/JSON-LD 와
타임라인 텍스트 스냅샷을 문자열 치환으로 삽입 (playwright 불필요, 전종목 수 초).
방문 시에는 기존 stock.js 가 그대로 하이드레이션(동일 mount id 를 덮어씀).

출력은 결정적(타임스탬프 없음) — 데이터가 안 바뀐 종목은 파일 바이트가 동일해
재생성해도 git diff 가 생기지 않는다.
"""
from __future__ import annotations

import json
from pathlib import Path

try:
    from scripts.reason_extract import display as rx_display
except ImportError:  # pragma: no cover — scripts/ 단독 실행
    from reason_extract import display as rx_display

SITE = 'https://orgo.kr'
MAX_EVENTS = 60          # 스냅샷에 넣을 최근 이벤트 상한 (파일 크기 가드)
GENERIC_SUMMARY = {'52주 신고가 도달', '상한가 — 사유 미수집', '시장 관심 증가', '-', ''}
ANSWER_EMPTY_HINTS = {'개별 종목 상승'}   # 답변형 요약에서 '단서'로 쓰기엔 정보가 없는 문구
# JSON-LD 발행처 — public/index.html 의 Organization(@id) 과 같은 엔티티
ORG_REF = {'@type': 'Organization', '@id': f'{SITE}/#organization', 'name': 'ORGO', 'url': f'{SITE}/'}

# 템플릿 앵커 — public/stock.html 의 원문과 정확히 일치해야 함 (드리프트 시 경고)
ANCHORS = {
    'title': '<title id="pageTitle">종목 - ORGO</title>',
    'desc': '<meta name="description" id="pageDesc" content="이 종목의 최근 1년 급등 날짜와 이유.">',
    'canonical': '<link rel="canonical" id="pageCanonical" href="https://orgo.kr/">',
    'og_title': '<meta property="og:title" id="pageOgTitle" content="종목 - ORGO">',
    'og_desc': '<meta property="og:description" id="pageOgDesc" content="이 종목의 최근 1년 급등 날짜와 이유.">',
    'tw_title': '<meta name="twitter:title" content="종목 - ORGO">',
    'h1': '<h1 class="stock-header__title" id="stockTitle">로딩 중…</h1>',
    'market': '<span class="stock-header__market" id="stockMarket"></span>',
    'summary': '<p class="stock-header__summary" id="stockSummary"></p>',
    'timeline': '<section class="timeline" id="timeline"></section>',
    'head_end': '</head>',
    'robots': '<meta name="robots" content="index,follow">',
}


def _esc(s) -> str:
    return (str(s or '')
            .replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;'))


def _fmt_date(ymd: str) -> str:
    if not ymd or len(ymd) != 8:
        return ymd or ''
    return f'{ymd[:4]}. {int(ymd[4:6])}. {int(ymd[6:8])}'


def _top_freq(items, key_fn):
    count = {}
    for it in items:
        k = key_fn(it)
        if k:
            count[k] = count.get(k, 0) + 1
    return max(count, key=count.get) if count else ''


def _summary(events: list[dict]) -> str:
    """stock.js buildSummary 의 축약판 — 최빈 테마 · 최빈 구체 사유."""
    filled = [e for e in events if e.get('reason_status') in ('filled', 'edited')] or events
    theme = _top_freq(filled, lambda e: (e.get('theme_tag') or '').strip())
    def _known(e):
        d = rx_display(e)
        return '' if d['unknown'] or d['kind'] in ('sector', 'theme') else d['text']
    reason = _top_freq(filled, _known)
    parts = [p for p in (theme, reason) if p]
    if not parts:
        sector = _top_freq(events, lambda e: (e.get('sector') or '').strip())
        parts = [sector] if sector else []
    return ' · '.join(parts)


def _topic(name: str) -> str:
    """주제 조사 은/는 — 끝 글자 받침 기준, 한글이 아니면 '은(는)'."""
    last = name[-1:] if name else ''
    if not ('가' <= last <= '힣'):
        return f'{name}은(는)'
    return f'{name}{"은" if (ord(last) - 0xAC00) % 28 else "는"}'


def _ymd_ko(ymd: str) -> str:
    return f'{ymd[:4]}년 {int(ymd[4:6])}월 {int(ymd[6:8])}일' if len(ymd or '') == 8 else ''


def _answer(name: str, events: list[dict]) -> str:
    """답변형 요약 한 단락 — 검색 위 AI 답변·챗봇이 그대로 인용할 수 있게 본문 맨 위에 둔다."""
    if not events:
        return ''
    latest = events[0]
    rate = latest.get('change_rate')
    rate_s = f' {rate:+.1f}%' if isinstance(rate, (int, float)) else ''
    s = (f'{_topic(name)} 최근 1년 동안 하루 +10% 이상 오른 날이 {len(events)}번 있었습니다. '
         f'가장 최근은 {_ymd_ko(str(latest.get("date") or ""))}{rate_s}')
    d = rx_display(latest)
    text = str(d.get('text') or '').strip()
    if text.startswith('관련 보도') and not d.get('unknown'):
        # '관련 보도'는 같은 날 기사 제목 인용일 뿐 원인 확정이 아니다 — '이유는'으로 단정하지 않는다
        s += f'이고, 같은 날 관련 보도는 \'{text.split(":", 1)[-1].strip()}\'입니다.'
    elif text and not d.get('unknown'):
        s += f'이고, 이유는 \'{text}\'입니다.'
    elif text and text not in ANSWER_EMPTY_HINTS:
        s += (f'입니다. 같은 날 확인된 근거는 없고, 단서는 \'{text}\''
              + (f'({d["label"]})' if d.get('label') else '') + '입니다.')
    else:
        s += '이며, 같은 날 확인된 근거는 없습니다.'
    theme = _top_freq(events, lambda e: (e.get('theme_tag') or '').strip())
    if theme:
        s += f' 자주 묶인 테마는 \'{theme}\'입니다.'
    return f'<p class="prerender-answer" style="margin:0 0 12px;line-height:1.6">{_esc(s)}</p>'


def _timeline_html(events: list[dict], day_pages: set | None = None) -> str:
    if not events:
        return '<div class="event-empty">최근 1년간 +10% 이상 기록이 없습니다.</div>'
    rows = []
    for e in events[:MAX_EVENTS]:
        rate = e.get('change_rate')
        rate_s = f'+{rate:.1f}%' if isinstance(rate, (int, float)) else ''
        d = rx_display(e)
        # 같은 날 근거가 없으면 단서(최근 이슈·추정·테마)에 라벨을 붙여 구분
        reason = d['text'] + (f' ({d["label"]})' if d.get('hint') and d['label'] else '')
        theme = (e.get('theme_tag') or '').strip()
        date_html = f'<time class="prerender-date">{_fmt_date(e.get("date") or "")}</time>'
        if day_pages and e.get('date') in day_pages:
            date_html = f'<a class="prerender-day" href="/day/{e.get("date")}">{date_html}</a>'
        rows.append(
            '<li class="prerender-item">'
            f'{date_html} '
            f'<b class="prerender-rate">{rate_s}</b> — {_esc(reason)}'
            + (f' <em class="prerender-theme">[{_esc(theme)}]</em>' if theme else '')
            + '</li>')
    more = len(events) - min(len(events), MAX_EVENTS)
    if more > 0:
        rows.append(f'<li class="prerender-item">… 외 {more}건</li>')
    return '<ol class="prerender-list">' + ''.join(rows) + '</ol>'


def _json_ld(ticker: str, name: str, desc: str, latest_ymd: str = '') -> str:
    page = {
        '@type': 'WebPage',
        'name': f'{name} 왜 오름? 급등 이유와 1년 이력',
        'url': f'{SITE}/stock/{ticker}',
        'description': desc,
        'inLanguage': 'ko',
        'isPartOf': {'@id': f'{SITE}/#website'},
        'publisher': ORG_REF,
        'about': {'@type': 'Corporation', 'name': name, 'tickerSymbol': ticker},
    }
    if len(latest_ymd or '') == 8:
        # 결정적 출력 유지 — 빌드 시각이 아니라 최근 급등일을 수정일로 쓴다
        page['dateModified'] = f'{latest_ymd[:4]}-{latest_ymd[4:6]}-{latest_ymd[6:]}'
    data = {
        '@context': 'https://schema.org',
        '@graph': [
            page,
            {
                '@type': 'BreadcrumbList',
                'itemListElement': [
                    {'@type': 'ListItem', 'position': 1, 'name': 'ORGO', 'item': f'{SITE}/'},
                    {'@type': 'ListItem', 'position': 2, 'name': name,
                     'item': f'{SITE}/stock/{ticker}'},
                ],
            },
        ],
    }
    return ('<script type="application/ld+json">'
            + json.dumps(data, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026') + '</script>\n')


def _render_one(template: str, ticker: str, history: dict, day_pages: set | None = None) -> str:
    name = history.get('name') or ticker
    market = history.get('market') or ''
    events = history.get('events') or []
    n = len(events)
    latest = events[0] if events else None

    # 검색어 그대로: "○○ 주가 급등 이유", 최근 상한가면 "○○ 상한가 이유" + 날짜·등락률·이유(짧을 때)
    title = f'{name} 주가 급등 이유·1년 이력 | ORGO'
    if latest and len(str(latest.get('date') or '')) == 8:
        ld, rate = str(latest['date']), float(latest.get('change_rate') or 0)
        kind = '상한가' if 29.5 <= rate <= 30.5 else '급등'
        d = rx_display(latest)
        why = '' if d.get('unknown') else str(d.get('text') or '')
        why = '' if why.startswith('관련 보도') or '동반' in why or len(why) > 16 else why
        head = f'{name} {kind} 이유 | {int(ld[4:6])}/{int(ld[6:])} {rate:+.1f}%'
        cand = f'{head} {why} | ORGO' if why else f'{head} · 급등 이력 | ORGO'
        if len(cand) <= 50:
            title = cand
    if latest:
        desc = (f'{name} 최근 1년 급등 {n}회. 최근 {_fmt_date(latest.get("date") or "")} '
                f'{latest.get("change_rate", 0):+.1f}% — '
                f'{rx_display(latest)["text"]}')
    else:
        desc = f'{name}의 최근 1년 급등 이력과 이유를 확인하세요.'
    desc = desc[:150]

    out = template
    out = out.replace(ANCHORS['title'], f'<title id="pageTitle">{_esc(title)}</title>')
    out = out.replace(ANCHORS['desc'],
                      f'<meta name="description" id="pageDesc" content="{_esc(desc)}">')
    out = out.replace(ANCHORS['canonical'],
                      f'<link rel="canonical" id="pageCanonical" href="{SITE}/stock/{ticker}">')
    out = out.replace(ANCHORS['og_title'],
                      f'<meta property="og:title" id="pageOgTitle" content="{_esc(title)}">')
    out = out.replace(ANCHORS['og_desc'],
                      f'<meta property="og:description" id="pageOgDesc" content="{_esc(desc)}">')
    out = out.replace(ANCHORS['tw_title'],
                      f'<meta name="twitter:title" content="{_esc(title)}">')
    if not events:
        # 이벤트 0건 = 씬 콘텐츠 — 색인 제외 (페이지 자체는 접근 가능)
        out = out.replace(ANCHORS['robots'], '<meta name="robots" content="noindex,follow">')
    out = out.replace(ANCHORS['head_end'],
                      _json_ld(ticker, name, desc, str((latest or {}).get('date') or '')) + '</head>')
    out = out.replace(ANCHORS['h1'],
                      '<h1 class="stock-header__title" id="stockTitle">'
                      f'<strong>{_esc(name)}</strong> 왜 오름?</h1>')
    out = out.replace(ANCHORS['market'],
                      f'<span class="stock-header__market" id="stockMarket">{_esc(market)}</span>')
    summary = _summary(events)
    if summary:
        out = out.replace(ANCHORS['summary'],
                          f'<p class="stock-header__summary" id="stockSummary">{_esc(summary)}</p>')
    out = out.replace(ANCHORS['timeline'],
                      '<section class="timeline" id="timeline">'
                      + _answer(name, events) + _timeline_html(events, day_pages) + '</section>')
    return out


def build_stock_prerender(stock_history_dir: Path, public_dir: Path) -> dict:
    """전 종목 프리렌더 — 내용이 바뀐 파일만 다시 쓴다(git diff 최소화)."""
    template_path = public_dir / 'stock.html'
    template = template_path.read_text(encoding='utf-8')
    missing = [k for k, a in ANCHORS.items() if a not in template]
    if missing:
        print(f'  [prerender] 템플릿 앵커 불일치 {missing} — stock.html 변경 확인 필요 (해당 치환 스킵)')

    out_dir = public_dir / 'stock'
    out_dir.mkdir(parents=True, exist_ok=True)
    # 날짜 → /day/{date} 내부 링크 (scripts/prerender_days.py 가 만드는 페이지만)
    try:
        from scripts.prerender_days import publishable_dates
        day_pages = set(publishable_dates())
    except Exception:
        day_pages = set()
    written = skipped = errors = 0
    for f in sorted(stock_history_dir.glob('*.json')):
        if f.name == 'index.json':
            continue
        try:
            history = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            errors += 1
            continue
        ticker = history.get('ticker') or f.stem
        html = _render_one(template, ticker, history, day_pages)
        out_path = out_dir / f'{ticker}.html'
        try:
            if out_path.exists() and out_path.read_text(encoding='utf-8') == html:
                skipped += 1
                continue
        except Exception:
            pass
        out_path.write_text(html, encoding='utf-8')
        written += 1
    print(f'  [prerender] stock/{{ticker}}.html: {written} 갱신, {skipped} 동일, {errors} 오류')
    return {'written': written, 'skipped': skipped, 'errors': errors}
