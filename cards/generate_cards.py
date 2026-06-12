# -*- coding: utf-8 -*-
"""
ORGO 데일리 카드 생성기 (프로토타입)
- 데이터: stock-rise raw {date}.json (대장 산출) + orgo.kr report-summary.json (주도섹터·핫테마)
- 출력: cards/out/{date}-{1,2,3}.png (1080x1080)
- 컴플라이언스: 사실 정보만 표기 (추천·매수·목표가 표현 금지) + 면책 문구 고정
사용: python cards/generate_cards.py [YYYYMMDD]
"""
import json
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

STOCK_RISE_RAW = "https://raw.githubusercontent.com/stockgame4343-blip/stock-rise/master/public/data"
ORGO_BASE = "https://orgo.kr"
OUT_DIR = Path(__file__).parent / "out"
FONT_PATH = (Path(__file__).parent.parent / "public" / "fonts" / "PretendardVariable.woff2").resolve()

# 대장 선정 — report.js 와 동일 기준: +20% 이상 중 거래대금 우선
LEADER_MIN_RATE = 20.0
TOP_N = 5
DISCLAIMER = "본 콘텐츠는 정보 제공 목적이며 투자 권유가 아닙니다"


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "orgo-cards/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def pick_date(argv):
    if len(argv) > 1 and argv[1].isdigit() and len(argv[1]) == 8:
        return argv[1]
    dates = fetch_json(f"{STOCK_RISE_RAW}/dates.json")
    lst = dates.get("dates") if isinstance(dates, dict) else dates
    return sorted(lst)[-1]


def fmt_date(ymd):
    days = ["월", "화", "수", "목", "금", "토", "일"]
    import datetime
    d = datetime.date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8]))
    return f"{ymd[:4]}.{ymd[4:6]}.{ymd[6:8]} ({days[d.weekday()]})"


def fmt_amount(v):
    if not v or v <= 0:
        return "-"
    if v >= 1e12:
        return f"{v / 1e12:.1f}조"
    if v >= 1e8:
        return f"{round(v / 1e8):,}억"
    return f"{round(v):,}"


def pick_leader(rankings):
    cands = [r for r in rankings if (r.get("change_rate") or 0) >= LEADER_MIN_RATE]
    if not cands:
        cands = sorted(rankings, key=lambda r: r.get("change_rate") or 0, reverse=True)[:5]
    cands.sort(key=lambda r: (r.get("trading_value") or 0, r.get("change_rate") or 0), reverse=True)
    return cands[0] if cands else None


CARD_CSS = """
@font-face { font-family: 'Pretendard Variable'; src: url('file:///%FONT%') format('woff2-variations'); font-weight: 45 920; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: 1080px; height: 1080px; overflow: hidden;
  font-family: 'Pretendard Variable', sans-serif; color: #fff;
  background: #0a0b0f; position: relative; }
.bg { position: absolute; inset: 0;
  background: radial-gradient(120% 90% at 85% -10%, rgba(229,57,53,0.42), transparent 55%),
              radial-gradient(110% 80% at -10% 110%, rgba(33,82,194,0.35), transparent 55%); }
.card { position: relative; height: 100%; padding: 72px 80px; display: flex; flex-direction: column; }
.top { display: flex; justify-content: space-between; align-items: baseline; }
.logo { font-size: 44px; font-weight: 900; letter-spacing: -1px; }
.logo small { font-size: 24px; font-weight: 600; color: rgba(255,255,255,0.55); margin-left: 14px; letter-spacing: 0; }
.date { font-size: 26px; font-weight: 600; color: rgba(255,255,255,0.65); }
.label { margin-top: 84px; font-size: 40px; font-weight: 800; color: #ff6b66; letter-spacing: 6px; }
.huge { margin-top: 18px; font-size: 128px; font-weight: 900; letter-spacing: -4px; line-height: 1.04; word-break: keep-all; }
.rate { margin-top: 10px; font-size: 96px; font-weight: 900; color: #ff4d49; letter-spacing: -2px; }
.meta { margin-top: 36px; font-size: 34px; font-weight: 600; color: rgba(255,255,255,0.78); line-height: 1.5; }
.meta b { color: #fff; font-weight: 800; }
.rows { margin-top: 40px; display: flex; flex-direction: column; gap: 22px; }
.row { display: flex; align-items: center; gap: 28px; background: rgba(255,255,255,0.045);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 22px; padding: 26px 34px; }
.row .rank { font-size: 44px; font-weight: 900; color: #ff6b66; width: 56px; }
.row .name { font-size: 46px; font-weight: 800; letter-spacing: -1px; flex: 1; word-break: keep-all; }
.row .sub { font-size: 30px; font-weight: 600; color: rgba(255,255,255,0.6); }
.row .pct { font-size: 44px; font-weight: 900; color: #ff4d49; }
.row--first { background: rgba(229,57,53,0.16); border-color: rgba(255,107,102,0.45); }
.foot { margin-top: auto; display: flex; flex-direction: column; gap: 12px; }
.cta { font-size: 30px; font-weight: 700; color: rgba(255,255,255,0.85); }
.cta b { color: #ff6b66; }
.disc { font-size: 21px; font-weight: 500; color: rgba(255,255,255,0.4); white-space: nowrap; }
"""


def html_shell(body, ymd):
    css = CARD_CSS.replace("%FONT%", str(FONT_PATH).replace("\\", "/"))
    return f"""<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><style>{css}</style></head>
<body><div class="bg"></div><div class="card">
<div class="top"><div class="logo">ORGO<small>orgo.kr</small></div><div class="date">{fmt_date(ymd)}</div></div>
{body}
<div class="foot"><div class="cta">왜 올랐는지 한눈에 — <b>orgo.kr</b></div><div class="disc">{DISCLAIMER}</div></div>
</div></body></html>"""


def card_leader(leader, ymd):
    name = leader.get("name", "")
    rate = leader.get("change_rate") or 0
    sector = leader.get("sector") or ""
    tv = fmt_amount(leader.get("trading_value"))
    meta = f"거래대금 <b>{tv}</b>"
    if sector:
        meta += f" · 섹터 <b>{sector}</b>"
    body = f"""
<div class="label">오늘의 대장</div>
<div class="huge">{name}</div>
<div class="rate">+{rate:.2f}%</div>
<div class="meta">{meta}</div>"""
    return html_shell(body, ymd)


def card_ranked(title, items, ymd, unit="종목"):
    rows = []
    for i, it in enumerate(items[:TOP_N]):
        first = " row--first" if i == 0 else ""
        rows.append(
            f'<div class="row{first}"><span class="rank">{i + 1}</span>'
            f'<span class="name">{it["name"]}</span>'
            f'<span class="sub">{it["count"]}{unit}</span>'
            f'<span class="pct">+{it["avg_rate"]:.1f}%</span></div>'
        )
    body = f"""
<div class="label">{title}</div>
<div class="rows">{''.join(rows)}</div>"""
    return html_shell(body, ymd)


def main():
    ymd = pick_date(sys.argv)
    print(f"date={ymd}")
    day = fetch_json(f"{STOCK_RISE_RAW}/{ymd}.json")
    rankings = day.get("rankings") or []
    summary = fetch_json(f"{ORGO_BASE}/data/report-summary.json")
    d1 = (summary.get("periods") or {}).get("d1") or {}
    sectors = [{"name": s["sector"], "count": s["count"], "avg_rate": s["avg_rate"]} for s in d1.get("sector_top") or []]
    themes = [{"name": t["theme"], "count": t["count"], "avg_rate": t["avg_rate"]} for t in d1.get("theme_top") or []]
    leader = pick_leader(rankings)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pages = []
    if leader:
        pages.append((f"{ymd}-1-leader.png", card_leader(leader, ymd)))
    if sectors:
        pages.append((f"{ymd}-2-sectors.png", card_ranked("주도 섹터 TOP 5", sectors, ymd)))
    if themes:
        pages.append((f"{ymd}-3-themes.png", card_ranked("핫테마 TOP 5", themes, ymd)))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(viewport={"width": 1080, "height": 1080}, device_scale_factor=1).new_page()
        for fname, html in pages:
            page.set_content(html, wait_until="networkidle")
            page.screenshot(path=str(OUT_DIR / fname))
            print(f"saved {fname}")
        browser.close()


if __name__ == "__main__":
    main()
