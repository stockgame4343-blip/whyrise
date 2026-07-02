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

SITE = 'https://orgo.kr'
MAX_EVENTS = 60          # 스냅샷에 넣을 최근 이벤트 상한 (파일 크기 가드)
GENERIC_SUMMARY = {'52주 신고가 도달', '상한가 — 사유 미수집', '시장 관심 증가', '-', ''}

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
    reason = _top_freq(filled, lambda e: (
        '' if (e.get('rise_reason') or '').strip() in GENERIC_SUMMARY
        else (e.get('rise_reason') or '').strip()))
    parts = [p for p in (theme, reason) if p]
    if not parts:
        sector = _top_freq(events, lambda e: (e.get('sector') or '').strip())
        parts = [sector] if sector else []
    return ' · '.join(parts)


def _timeline_html(events: list[dict]) -> str:
    if not events:
        return '<div class="event-empty">최근 1년간 +10% 이상 기록이 없습니다.</div>'
    rows = []
    for e in events[:MAX_EVENTS]:
        rate = e.get('change_rate')
        rate_s = f'+{rate:.1f}%' if isinstance(rate, (int, float)) else ''
        reason = (e.get('rise_reason') or '').strip() or '이유 수집 중'
        theme = (e.get('theme_tag') or '').strip()
        rows.append(
            '<li class="prerender-item">'
            f'<time class="prerender-date">{_fmt_date(e.get("date") or "")}</time> '
            f'<b class="prerender-rate">{rate_s}</b> — {_esc(reason)}'
            + (f' <em class="prerender-theme">[{_esc(theme)}]</em>' if theme else '')
            + '</li>')
    more = len(events) - min(len(events), MAX_EVENTS)
    if more > 0:
        rows.append(f'<li class="prerender-item">… 외 {more}건</li>')
    return '<ol class="prerender-list">' + ''.join(rows) + '</ol>'


def _json_ld(ticker: str, name: str, desc: str) -> str:
    data = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebPage',
                'name': f'{name} 왜 오름? 급등 이유와 1년 이력',
                'url': f'{SITE}/stock/{ticker}',
                'description': desc,
                'inLanguage': 'ko',
            },
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
            + json.dumps(data, ensure_ascii=False) + '</script>\n')


def _render_one(template: str, ticker: str, history: dict) -> str:
    name = history.get('name') or ticker
    market = history.get('market') or ''
    events = history.get('events') or []
    n = len(events)
    latest = events[0] if events else None

    title = f'{name} 왜 오름? 급등 이유·1년 이력 - ORGO'
    if latest:
        desc = (f'{name} 최근 1년 급등 {n}회. 최근 {_fmt_date(latest.get("date") or "")} '
                f'{latest.get("change_rate", 0):+.1f}% — '
                f'{(latest.get("rise_reason") or "이유 수집 중").strip()}')
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
    out = out.replace(ANCHORS['head_end'], _json_ld(ticker, name, desc) + '</head>')
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
                      + _timeline_html(events) + '</section>')
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
        html = _render_one(template, ticker, history)
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
