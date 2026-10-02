"""날짜별 SEO 페이지·IndexNow 회귀 테스트 — python scripts/test_prerender_days.py"""
import sys
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from scripts import prerender_days as pd  # noqa: E402
from scripts import indexnow_ping as ip  # noqa: E402


def row(name, rate, reason='', theme='', ticker=None, news=None):
    return {'ticker': ticker or f'{abs(hash(name)) % 900000 + 100000:06d}', 'name': name, 'change_rate': rate,
            'rise_reason': reason, 'theme_tag': theme, 'trading_value': 5e10, 'news': news or []}


class DayPageTest(unittest.TestCase):
    def day(self):
        return {'date': '20260930', 'rankings': [
            row('동일스틸럭스', 31.4, '관련 보도: 알래스카 LNG 기대…철강株 급등', '철강 중소형', '023790'),
            row('금강철강', 23.6, '거래량 증가', '철강 중소형', '053260'),
            row('빅웨이브로보틱스', 43.6, '거래량 증가', '2026 하반기 신규상장', '0035S0'),
            row('부산주공', 18.9, '정리매매 기간 (상장폐지 절차)', '거래량', '100120'),
            row('작은상승', 5.0, '거래량 증가', '', '111111'),
        ]}

    def test_page_hides_generic_reason_and_excludes_delisting(self):
        html = pd.render_day('20260930', self.day(), {'stock': {'name': '덕산넵코어스', 'rate': 23.1, 'theme': '2026 하반기 신규상장'}}, '20260929', '')
        self.assertIn('2026년 9월 30일(수) 급등주, 왜 올랐나', html)
        self.assertIn('관련 보도: 알래스카 LNG 기대', html)
        self.assertNotIn('>거래량 증가<', html)
        self.assertNotIn('확인 중', html)
        # 근거 없는 '거래량 증가'는 테마 단서로 대신 (흐리게 + 라벨)
        self.assertIn('<span class="day-reason day-reason--none">철강 중소형 관련주</span>', html)
        self.assertNotIn('reason-src', html)          # 리스트엔 출처 태그를 달지 않는다
        self.assertIn('정리매매(상장폐지 절차) 종목은 급등 집계에서 제외', html)
        self.assertNotIn('href="/stock/100120"', html)
        self.assertIn('<span class="day-tag">신규상장</span>', html)
        self.assertNotIn('작은상승', html)            # +10% 미만 제외
        self.assertIn('href="/day/20260929"', html)
        # 반기 '신규상장' 태그만으로 상장 첫날이라 단정하지 않는다
        self.assertIn('덕산넵코어스 +23.1%', html)
        self.assertNotIn('덕산넵코어스 (', html)
        self.assertIn('<link rel="canonical" href="https://orgo.kr/day/20260930">', html)

    def test_listing_day_leader_gets_ipo_reason(self):
        cal = {'stock': {'ticker': '0035S0', 'name': '빅웨이브로보틱스', 'rate': 43.6, 'listing_day': True}}
        html = pd.render_day('20260930', self.day(), cal, '', '')
        self.assertIn('빅웨이브로보틱스 (상장 첫날) +43.6%', html)
        self.assertIn('상장 첫날 (공모가 대비)', html)

    def test_theme_groups_skip_junk_and_ipo_tags(self):
        rows, _ = pd.page_rows(self.day())
        names = [g['name'] for g in pd.theme_groups(rows)]
        self.assertEqual(names, ['철강 중소형'])

    def test_escaping(self):
        d = {'date': '20260930', 'rankings': [row('<script>', 20.0, '관련 보도: "a" & <b>', '', '222222')]}
        html = pd.render_day('20260930', d, None, '', '')
        self.assertNotIn('<script>"', html)
        self.assertIn('&lt;script&gt;', html)

    def test_today_waits_for_close(self):
        before = pd.publishable_dates(datetime(2026, 9, 30, 15, 0, tzinfo=pd.KST))
        after = pd.publishable_dates(datetime(2026, 9, 30, 16, 0, tzinfo=pd.KST))
        if '20260930' in after:
            self.assertNotIn('20260930', before)

    def test_render_is_deterministic(self):
        a = pd.render_day('20260930', self.day(), None, '', '')
        b = pd.render_day('20260930', self.day(), None, '', '')
        self.assertEqual(a, b)


class IndexNowTest(unittest.TestCase):
    def test_paths_to_urls(self):
        urls = ip.urls_from_paths(['public/stock/005930.html', 'public/day/20260930.html',
                                   'public/data/rise-history/20260930.json', 'public/stock/../x.html'])
        self.assertEqual(urls, ['https://orgo.kr/', 'https://orgo.kr/day/',
                                'https://orgo.kr/stock/005930', 'https://orgo.kr/day/20260930'])

    def test_no_pages_no_ping(self):
        self.assertEqual(ip.urls_from_paths(['public/data/x.json']), [])

    def test_key_file_matches(self):
        self.assertEqual((ROOT / 'public' / f'{ip.KEY}.txt').read_text(encoding='utf-8').strip(), ip.KEY)


if __name__ == '__main__':
    unittest.main()
