"""기사 제목 → 사유 추출 회귀 테스트 (실제 2026-09-30·10-01 헤드라인). python scripts/test_reason_extract.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reason_extract as R  # noqa: E402


def cause(name, title):
    a = R.analyse_title(title, name)
    return a and a['reason']


class TitleTest(unittest.TestCase):
    def test_company_catalyst_without_name(self):
        self.assertEqual(cause('디아이', '디아이, 삼성전자에 153억 반도체 검사장비 공급'), '삼성전자에 153억 반도체 검사장비 공급')
        self.assertEqual(cause('녹십자웰빙', "GC녹십자웰빙, 보령과 '라이넥주' 공동 판매 계약"), '보령과 라이넥주 공동 판매 계약')

    def test_move_article_keeps_cause_drops_price_words(self):
        self.assertEqual(cause('LK삼양', 'LK삼양, 국방부 드론에 카메라 모듈 공급…이틀째 상한가'), '국방부 드론에 카메라 모듈 공급')
        self.assertEqual(cause('인벤티지랩', '[특징주] 인벤티지랩, 약물중독 치료제 美 특허 추가 취득… 6%대 강세'), '약물중독 치료제 美 특허 추가 취득')
        self.assertEqual(cause('시그네틱스', "반도체 수출 259% 급증…소부장株 불기둥, 시그네틱스 '上'[핫종목]"), '반도체 수출 259% 급증')
        self.assertEqual(cause('하이스틸', '美알래스카 LNG 투자 기대…하이스틸·세아제강 강세[핫종목]'), '美알래스카 LNG 투자 기대')

    def test_sector_move(self):
        self.assertEqual(cause('티에프이', '삼전닉스 보합인데 반도체 장비주 강세…티에프이 15%↑[핫종목]'), '반도체 장비주 동반 강세')
        self.assertEqual(cause('KBI동양철관', "[특징주] '韓 LNG 대미투자' 전망에 철강주 등 강세(종합)"), '철강주 동반 강세 — 韓 LNG 대미투자 전망')

    def test_rejects_unrelated_or_negative(self):
        self.assertIsNone(R.analyse_title('[코스닥 주담대 주의보] LK삼양, 담보가치 하락 속 동전주 탈피 추진', 'LK삼양'))
        self.assertIsNone(R.analyse_title('세미티에스·AP위성 등 8곳, 대신증권 콥데이 참가', '세미티에스'))
        self.assertIsNone(R.analyse_title('[제주소식] 한진그룹 한국공항, 제주 취약계층 지원 성금 5천만원 기부', '한국공항'))
        self.assertIsNone(R.analyse_title('코스닥 개장 직후 강세… 2차전지·반도체 장비주 지수 지지', 'X'))
        self.assertFalse(R.name_in('한국공항公, 김원준 사장 취임', '한국공항'))
        self.assertFalse(R.name_in('디아이씨, 신규 수주', '디아이'))
        self.assertTrue(R.name_in('디아이는 공급 계약', '디아이'))

    def test_special_labels(self):
        self.assertEqual(cause('부산주공', '부산주공, 정리매매 첫날 91% 급락…주가 40원으로[종목 NOW]'), '정리매매 기간 (상장폐지 절차)')
        self.assertEqual(cause('코스모로보틱스', "'매출 부풀리기' 의혹 코스모로보틱스, 하한가 딛고 20% 반등"), '하한가·급락 후 반등')
        self.assertEqual(cause('대덕전자', '“대덕전자, 실적 기반 경쟁사 주가 캐치업…목표가 19만원 상향”-iM'), '증권사 목표가 19만원 상향 (iM)')

    def test_other_stock_move_and_fragments_are_not_causes(self):
        self.assertIsNone(R.analyse_title('화이자, 멧세라 인수에 디앤디파마텍 상한가, 美 타임이 픽한 뉴로핏...', '뉴로핏'))
        self.assertEqual(cause('아이로보틱스', '“반도체 다음 주자” 로봇주 ‘불기둥’…두산로보틱스 17%대↑[특징.....'), '로봇주 동반 강세')
        self.assertEqual(cause('쿠콘', '[ET특징주]쿠콘, 지역화폐 예산 확대 소식에 상승세'), '지역화폐 예산 확대 소식')

    def test_report_title_and_series_article(self):
        a = R.analyse_title('“비에이치아이, 수주 확대·올해 사상 최대 실적 가시화” iM', '비에이치아이')
        self.assertEqual((a['reason'], a['kind']), ('수주 확대·올해 사상 최대 실적 가시화 (iM)', 'analyst'))
        a = R.analyse_title("[격랑의 알로이스]② 경영권 할인매각…'미래산업'에 쏠린 눈", '미래산업')
        self.assertEqual(a['kind'], 'related')
        self.assertNotIn('②', a['reason'])
        # 따옴표 뒤 일반 단어는 증권사 꼬리표가 아니다
        self.assertEqual(R.clean_title('에코프로 ‘불기둥’ 계속')[1], '')

    def test_round3_regressions(self):
        # 기업 이벤트(액면병합·거래재개), 실적 수치 보존, 다른 자산 움직임이 원인인 경우
        self.assertEqual(cause('진영', '[특징주] 진영, 액면병합 후 거래 첫날 ‘상한가’'), '액면병합 후 거래 첫날')
        self.assertEqual(cause('대동', '대동, 2분기 영업익 64%↑… AI·로보틱스 전환 속도'), '2분기 영업익 64% 증가')
        self.assertEqual(cause('대한유화', '‘기름값 폭등’에 정유·석화 랠리…롯데케미칼·대한유화 10%대 급등.....'), '기름값 폭등')
        self.assertEqual(cause('티사이언티픽', "티사이언티픽, 비트코인 강세에 '빗썸 지분 7.17%' 부각"), '비트코인 강세에 빗썸 지분 7.17% 부각')
        self.assertEqual(cause('SK증권', '[특징주] SK증권, 상한가 직행?SK하이닉스 자사주 매입 단독 중개'), 'SK하이닉스 자사주 매입 단독 중개')
        self.assertEqual(cause('한성기업', "'애국 테마 매수세' 모나미·한성기업 연일 상한가"), '애국 테마')
        self.assertEqual(cause('X', 'X, 관리종목 지정 해제에 급등'), '관리종목 지정 해제')
        # 원인이 아닌 것: 순위 로봇 기사, 다른 회사(효성重), 낚시 문구, 종목 나열·등락률, 적자 기사
        self.assertIsNone(R.analyse_title('[서울데이터랩]SK증권우 29.98% 상한가 금일 증시 상승률 1위로 마감', 'SK증권우'))
        self.assertIsNone(R.analyse_title('[특징주] “효성重 놓쳤다면 여기로”…효성, 장 초반 ‘상한가’ 직.....', '효성'))
        self.assertEqual(cause('포스코퓨처엠', '[특징주] 2차전지주 급등…엘앤에프 14%·포스코퓨처엠 8%대↑'), '2차전지주 동반 강세')
        self.assertIsNone(R.analyse_title('비투엔, 작년 영업손실 67억...적자 폭 확대', '비투엔'))
        self.assertIsNone(R.analyse_title('X 관리종목 지정 우려', 'X'))

    def test_category_labels_are_not_reasons(self):
        for r in ('로봇/자동화', '방산', '트럼프/관세', '신약/임상', '5G 테마 상한가', '실적 호조'):
            self.assertTrue(R.is_template_reason(r), r)
        self.assertTrue(R.should_replace('로봇주 강세', {'reason': 'x', 'kind': 'sector'}))
        d = R.display({'rise_reason': '로봇/자동화', 'theme_tag': ''})
        self.assertEqual((d['text'], d['label']), ('로봇 관련주', '테마'))
        d = R.display({'rise_reason': '거래량 증가', 'change_rate': 400.0, 'theme_tag': '남북경협'})
        self.assertEqual(d['text'], '거래 재개·기준가 변경 영향')

    def test_truncated_tail_is_dropped(self):
        self.assertEqual(cause('HT로보틱스', "HT로보틱스, 산업부 '2026 월드클래스 플러스' 선정… 최대 50억원 R&D ..."), '산업부 2026 월드클래스 플러스 선정')


class PickTest(unittest.TestCase):
    def news(self, title, day='2026-10-01'):
        return {'title': title, 'link': 'https://n.news.naver.com/x', 'date': day}

    def test_old_articles_are_not_evidence(self):
        n = [self.news('LK삼양, 국방부 드론에 카메라 모듈 공급…이틀째 상한가', '2026.08.11')]
        self.assertIsNone(R.pick_reason('LK삼양', n, '20261001'))

    def test_move_article_is_high(self):
        p = R.pick_reason('대한제강', [self.news('알래스카 LNG 사업, 1300㎞ 가스관 필요…대한제강 22%↑[핫종목]')], '20261001')
        self.assertEqual((p['confidence'], p['kind']), ('high', 'move'))

    def test_catalyst_beats_interview(self):
        n = [self.news('디아이 대표 “내년이 더 기대된다”'), self.news('디아이, 삼성전자에 153억 반도체 검사장비 공급')]
        p = R.pick_reason('디아이', n, '20261001')
        self.assertEqual((p['reason'], p['evidence']), ('삼성전자에 153억 반도체 검사장비 공급', [1]))

    def test_weak_named_is_labelled_related(self):
        p = R.pick_reason('지투지바이오', [self.news('이희용 지투지바이오 대표 “월1회 SC 비만약 대세될 것”')], '20261001')
        self.assertEqual(p['confidence'], 'low')
        self.assertTrue(p['reason'].startswith('관련 보도: '))


class ContextTest(unittest.TestCase):
    def rows(self):
        n = lambda t: {'title': t, 'link': 'https://n.news.naver.com/x', 'date': '2026.10.01'}
        return [
            {'name': '원일티엔아이', 'theme_tag': '원자력발전소 해체', 'sector': '에너지장비및서비스', 'change_rate': 29.9, 'news': [
                n('[특징주] 1200억달러 투자해 美 대형 원전 8기 건설 소식에…원전주 강...')]},
            {'name': '리브스메드', 'theme_tag': '의료기기', 'sector': '건강관리장비와용품', 'change_rate': 18.8, 'news': []},
            {'name': '지투지바이오', 'theme_tag': '치매', 'sector': '제약', 'change_rate': 20.5, 'news': []},
            {'name': '보로노이', 'theme_tag': '치매', 'sector': '제약', 'change_rate': 11.6, 'news': []},
            {'name': '아리바이오', 'theme_tag': '치매', 'sector': '제약', 'change_rate': 12.0, 'news': []},
            {'name': '브릴스', 'theme_tag': '로봇(산업용/협동로봇 등)', 'theme_tags': ['로봇(산업용/협동로봇 등)', '2026 하반기 신규상장'], 'sector': '기계', 'change_rate': 59.7, 'news': []},
            {'name': '세미티에스', 'theme_tag': '반도체 장비', 'theme_tags': ['반도체 장비', '2026 상반기 신규상장'], 'sector': '반도체와반도체장비', 'change_rate': 22.9, 'news': []},
        ]

    def test_sector_cause_theme_and_ipo(self):
        rows = self.rows()
        ctx = R.build_day_context(rows, '20261001')
        self.assertEqual(R.explain(rows[0], '20261001', ctx)['reason'],
                         '원전주 동반 강세 — 1200억달러 투자해 美 대형 원전 8기 건설 소식')
        # '건강관리장비와용품'의 '강관'·'장비' 같은 부분 일치로 엉뚱한 업종을 붙이지 않는다
        self.assertIsNone(R.explain(rows[1], '20261001', ctx))
        self.assertEqual(R.explain(rows[2], '20261001', ctx)['reason'], '치매 테마 3종목 동반 상승')
        self.assertEqual(R.explain(rows[5], '20261001', ctx)['reason'], '상장 첫날 (공모가 대비)')
        # 수개월 전 상장주(반기 태그)는 '상장 첫날'로 단정하지 않는다
        self.assertIsNone(R.explain(rows[6], '20261001', ctx))

    def test_specific_reason_not_overwritten_by_co_move(self):
        sector = {'reason': '반도체주 동반 강세 — 마이크론·수출 호조', 'kind': 'sector'}
        named = {'reason': '삼성전자에 153억 반도체 검사장비 공급', 'kind': 'catalyst'}
        self.assertFalse(R.should_replace('전력반도체 MOU 체결', sector))
        self.assertTrue(R.should_replace('전력반도체 MOU 체결', named))
        self.assertTrue(R.should_replace('수주 공시', sector))
        self.assertTrue(R.should_replace('52주 신고가 도달', sector))
        self.assertTrue(R.should_replace('반도체 테마 강세', {'reason': 'x', 'kind': 'theme'}))
        self.assertFalse(R.should_replace('수주 공시', None))

    def test_unknown_rows_show_a_hint_not_blank(self):
        # 최근 이슈(날짜 표기) > 키워드 추정 > 테마 > 업종 — '이유 확인 중' 같은 빈 표시는 쓰지 않는다
        news = [{'title': '넥사다이내믹스, 경영진 개편 직후 해외 수주 성공', 'link': 'https://n.news.naver.com/a',
                 'date': '2026.09.21'}]
        h = R.recent_hint('넥사다이내믹스', news, '20261001')
        self.assertEqual(h['text'], '9/21 경영진 개편 직후 해외 수주 성공')
        self.assertIsNone(R.recent_hint('넥사다이내믹스', news, '20261020'))    # 2주 넘으면 단서로도 안 씀
        d = R.display({'rise_reason': '', 'reason_source': 'news_extract', 'reason_hint': h, 'theme_tag': 'OLED'})
        self.assertEqual((d['text'], d['label'], d['unknown'], d['hint']), (h['text'], '최근 이슈', True, True))
        d = R.display({'rise_reason': '', 'reason_source': 'news_extract', 'reason_previous': '수주 공시', 'theme_tag': 'OLED'})
        self.assertEqual((d['text'], d['label']), ('수주 공시', '추정'))
        d = R.display({'rise_reason': '거래량 증가', 'theme_tag': '카메라모듈/부품'})
        self.assertEqual((d['text'], d['label']), ('카메라모듈 관련주', '테마'))
        d = R.display({'rise_reason': '거래량 증가', 'sector': '반도체와반도체장비'})
        self.assertEqual((d['text'], d['label']), ('반도체와반도체장비', '업종'))
        self.assertNotEqual(R.display({'rise_reason': ''})['text'], R.UNKNOWN_TEXT)

    def test_sector_co_move_without_article(self):
        rows = [{'name': n, 'sector': '반도체와반도체장비', 'theme_tag': t, 'change_rate': 12.0, 'news': []}
                for n, t in (('가', 'HBM'), ('나', '유리 기판'), ('다', 'CXL'))]
        ctx = R.build_day_context(rows, '20261001')
        self.assertEqual(R.explain(rows[0], '20261001', ctx)['reason'], '반도체주 3종목 동반 상승')
        rows2 = rows[:2]
        self.assertIsNone(R.explain(rows2[0], '20261001', R.build_day_context(rows2, '20261001')))

    def test_template_detection(self):
        for r in ('수주 공시', '정책 관련 뉴스', '양산 보도', '상장 이슈', '거래량 증가', '흑자 전환', '외국인·기관 순매수'):
            self.assertTrue(R.is_template_reason(r), r)
        for r in ('아포텍스 품목 확대', '전력반도체 MOU 체결', '삼성전자에 153억 반도체 검사장비 공급'):
            self.assertFalse(R.is_template_reason(r), r)


if __name__ == '__main__':
    unittest.main()
