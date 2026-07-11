"""api/admin-override.py 핸들러 단위 테스트 — 비객체 JSON 400 · 임의 타입 정제 ·
DELETE 재디스패치(멱등) (네트워크 없음 — GitHub 호출 전부 스텁, stdlib only).

실행: python scripts/test_admin_override_api.py
"""
import importlib.util
import io
import json
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    'admin_override', _REPO / 'api' / 'admin-override.py')
ao = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ao)

# 인증/토큰은 모듈 전역을 직접 고정 — 실행 환경의 env 유무와 무관하게 결정적
ao.GITHUB_TOKEN = 'test-github-token'
ao.ADMIN_TOKEN = 'test-admin-token'
ao.SESSION_SECRET = 'test-session-secret'


def make_handler(path='', body=b'', authed=True):
    """BaseHTTPRequestHandler 소켓 초기화 우회 — 요청 상태만 주입한 핸들러."""
    h = ao.handler.__new__(ao.handler)
    h.path = path
    cookie = f'wr_admin={ao._sign()}' if authed else ''
    h.headers = {'Cookie': cookie, 'Content-Length': str(len(body))}
    h.rfile = io.BytesIO(body)
    h._responses = []
    h._respond = lambda status, b: h._responses.append((status, b))
    return h


class SanitizeTest(unittest.TestCase):

    def test_strips_tags_and_control_chars(self):
        self.assertEqual(ao._sanitize('<b>급등</b>\x00\x01 사유', 500), '급등 사유')

    def test_length_cap(self):
        self.assertEqual(ao._sanitize('a' * 600, 500), 'a' * 500)

    def test_non_string_types_become_empty(self):
        for v in (None, 123, 1.5, True, ['x'], {'k': 'v'}):
            with self.subTest(v=v):
                self.assertEqual(ao._sanitize(v, 500), '')


class PostValidationTest(unittest.TestCase):

    def setUp(self):
        self.saved = []
        self.dispatched = []
        self.store = {}
        self._orig = (ao._get_overrides, ao._save_overrides, ao._trigger_rebuild)
        ao._get_overrides = lambda date: (dict(self.store.get(date, {})),
                                          'sha' if date in self.store else None)
        ao._save_overrides = (lambda date, overrides, sha, message:
                              self.saved.append((date, overrides)))
        ao._trigger_rebuild = (lambda date='', ticker='':
                               (self.dispatched.append((date, ticker)) or True))

    def tearDown(self):
        ao._get_overrides, ao._save_overrides, ao._trigger_rebuild = self._orig

    def _post(self, raw, authed=True):
        h = make_handler(body=raw, authed=authed)
        h.do_POST()
        return h._responses[-1]

    def test_unauthed_401(self):
        status, _ = self._post(b'{}', authed=False)
        self.assertEqual(status, 401)

    def test_non_object_json_body_is_400_not_500(self):
        for raw in (b'[1,2,3]', b'"str"', b'123', b'null', b'true'):
            with self.subTest(raw=raw):
                status, _ = self._post(raw)
                self.assertEqual(status, 400)

    def test_non_string_date_ticker_is_400_not_crash(self):
        raw = json.dumps({'date': 20260701, 'ticker': ['005930'],
                          'rise_reason': 'x'}).encode('utf-8')
        status, _ = self._post(raw)
        self.assertEqual(status, 400)

    def test_invalid_calendar_or_unicode_digits_are_400(self):
        for date_value, ticker in (('20260230', '005930'), ('２０２６０７０１', '005930'),
                                   ('20260701', '００５９３０')):
            with self.subTest(date=date_value, ticker=ticker):
                raw = json.dumps({'date': date_value, 'ticker': ticker,
                                  'rise_reason': 'x'}).encode('utf-8')
                status, _ = self._post(raw)
                self.assertEqual(status, 400)

    def test_non_string_fields_treated_as_empty(self):
        raw = json.dumps({'date': '20260701', 'ticker': '005930',
                          'rise_reason': 123, 'theme_tag': ['a'],
                          'note': {'x': 1}}).encode('utf-8')
        status, _ = self._post(raw)
        self.assertEqual(status, 200)
        entry = self.saved[-1][1]['005930']
        self.assertEqual(entry['rise_reason'], '')
        self.assertNotIn('theme_tag', entry)
        self.assertNotIn('note', entry)
        self.assertEqual(self.dispatched[-1], ('20260701', '005930'))

    def test_save_replaces_entry_and_omits_cleared_fields(self):
        # 이전 저장에 theme/note 가 있어도 최신 entry 로 전체 교체 — 지운 필드는 키 생략
        self.store['20260701'] = {'005930': {
            'rise_reason': '이전 사유', 'theme_tag': '이전테마', 'note': '이전메모'}}
        raw = json.dumps({'date': '20260701', 'ticker': '005930',
                          'rise_reason': '새 사유', 'theme_tag': '', 'note': ''}
                         ).encode('utf-8')
        status, _ = self._post(raw)
        self.assertEqual(status, 200)
        entry = self.saved[-1][1]['005930']
        self.assertEqual(entry['rise_reason'], '새 사유')
        self.assertNotIn('theme_tag', entry, '지운 필드 키 생략 → 빌드/JS 가 원본 복원')
        self.assertNotIn('note', entry)


class DeleteDispatchTest(unittest.TestCase):

    def setUp(self):
        self.saved = []
        self.dispatched = []
        self.store = {}
        self._orig = (ao._get_overrides, ao._save_overrides, ao._trigger_rebuild)
        ao._get_overrides = lambda date: (dict(self.store.get(date, {})),
                                          'sha' if date in self.store else None)
        ao._save_overrides = (lambda date, overrides, sha, message:
                              self.saved.append((date, overrides)))
        ao._trigger_rebuild = (lambda date='', ticker='':
                               (self.dispatched.append((date, ticker)) or True))

    def tearDown(self):
        ao._get_overrides, ao._save_overrides, ao._trigger_rebuild = self._orig

    def _delete(self, date='20260701', ticker='005930'):
        h = make_handler(path=f'/api/admin-override?date={date}&ticker={ticker}')
        h.do_DELETE()
        return h._responses[-1]

    def test_delete_present_saves_and_dispatches(self):
        self.store['20260701'] = {'005930': {'rise_reason': 'x'}}
        status, _ = self._delete()
        self.assertEqual(status, 200)
        self.assertEqual(len(self.saved), 1)
        self.assertNotIn('005930', self.saved[-1][1])
        self.assertEqual(self.dispatched, [('20260701', '005930')])

    def test_delete_absent_still_dispatches(self):
        # ticker 이미 없음(파일도 없음) — 커밋은 생략, dispatch 는 항상.
        # 이전 삭제의 dispatch 가 실패해 bake 만 잔존해도 DELETE 재시도로 원복 가능.
        status, body = self._delete()
        self.assertEqual(status, 200)
        self.assertTrue(body.get('ok'))
        self.assertTrue(body.get('sync_queued'))
        self.assertEqual(self.saved, [], '없는 항목엔 커밋 없음')
        self.assertEqual(self.dispatched, [('20260701', '005930')])

    def test_delete_twice_is_idempotent(self):
        self.store['20260701'] = {'005930': {'rise_reason': 'x'}}
        self._delete()
        self.store['20260701'] = {}          # 1차 삭제가 반영된 상태
        status, _ = self._delete()
        self.assertEqual(status, 200)
        self.assertEqual(len(self.saved), 1, '2차 삭제는 커밋 없음')
        self.assertEqual(self.dispatched,
                         [('20260701', '005930'), ('20260701', '005930')],
                          'dispatch 는 매번 — 재시도 경로 보장')

    def test_dispatch_failure_is_visible_but_delete_stays_successful(self):
        ao._trigger_rebuild = lambda date='', ticker='': False
        status, body = self._delete()
        self.assertEqual(status, 200)
        self.assertTrue(body.get('ok'))
        self.assertIs(body.get('sync_queued'), False)


if __name__ == '__main__':
    unittest.main()
