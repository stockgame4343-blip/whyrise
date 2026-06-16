"""
브랜드 에셋 SVG -> PNG 렌더러.

OG 이미지는 SVG면 카카오톡/페이스북 공유 미리보기에서 렌더되지 않으므로
반드시 PNG를 만들어 og:image 로 서빙해야 한다. (favicon.svg 는 브라우저가
직접 렌더하므로 PNG 불필요 — 미리보기만 생성)

사용법:
    cd whyrise && python scripts/render_brand_png.py
"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
PREVIEW = ROOT / "_tmp_previews"
PREVIEW.mkdir(exist_ok=True)

# (svg 경로, 출력 경로, 너비, 높이, 배율)
JOBS = [
    # 프로덕션 OG (정확히 1200x630)
    (PUBLIC / "og-default.svg", PUBLIC / "og-default.png", 1200, 630, 1),
    # 검수용 미리보기
    (PUBLIC / "og-default.svg", PREVIEW / "orgo-og-sample.png", 1200, 630, 1),
    (PUBLIC / "favicon.svg", PREVIEW / "orgo-favicon-128.png", 128, 128, 4),
    (PUBLIC / "favicon.svg", PREVIEW / "orgo-favicon-16.png", 16, 16, 8),
]

HTML = """<!doctype html><html><head><meta charset="utf-8">
<style>html,body{{margin:0;padding:0;background:transparent}}
svg{{display:block;width:{w}px;height:{h}px}}</style></head>
<body>{svg}</body></html>"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for svg_path, out_path, w, h, scale in JOBS:
            svg = svg_path.read_text(encoding="utf-8")
            page = browser.new_page(
                viewport={"width": w, "height": h},
                device_scale_factor=scale,
            )
            page.set_content(HTML.format(w=w, h=h, svg=svg))
            page.wait_for_timeout(150)
            page.screenshot(path=str(out_path), clip={"x": 0, "y": 0, "width": w, "height": h})
            page.close()
            print(f"[OK] {out_path.relative_to(ROOT)}  ({w}x{h} @{scale}x)")
        browser.close()


if __name__ == "__main__":
    main()
