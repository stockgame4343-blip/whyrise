"""Offline regression tests for API input validation and upstream failures.

Run: python scripts/test_api_stability.py
No credentials or network calls are used.
"""
import base64
import importlib.util
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

API = Path(__file__).resolve().parent.parent / 'api'
sys.path.insert(0, str(API))
import _auth as auth


def load(name):
    spec = importlib.util.spec_from_file_location('stability_' + name.replace('-', '_'), API / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


login = load('admin-login')
admin = load('admin-override')
ratings = load('ratings')
market = load('marketmap')


def handler(module, body=None):
    raw = json.dumps(body, ensure_ascii=True).encode() if body is not None else b''
    h = module.handler.__new__(module.handler)
    h.path = '/'
    h.headers = {'Content-Length': str(len(raw))}
    h.rfile, h.wfile = io.BytesIO(raw), io.BytesIO()
    h.status, h.response_headers = None, {}
    h.send_response = lambda status: setattr(h, 'status', status)
    h.send_header = lambda key, value: h.response_headers.__setitem__(key, value)
    h.end_headers = lambda: None
    return h


def response(h):
    return json.loads(h.wfile.getvalue())


class OfflineTest(unittest.TestCase):
    def setUp(self):
        self.guard = patch('urllib.request.urlopen', side_effect=AssertionError('Unexpected network call'))
        self.guard.start()
        self.addCleanup(self.guard.stop)


class AuthTest(OfflineTest):
    def setUp(self):
        super().setUp()
        p = patch.object(auth, 'AUTH_SECRET', 'test-secret')
        p.start()
        self.addCleanup(p.stop)

    def signed_payload(self, payload):
        body = auth._b64e(json.dumps(payload).encode())
        return body + '.' + auth._signature(body)

    def test_redirect_rejects_external_and_header_injection_paths(self):
        for value in ['/\\example.com/x', '//example.com', '/ok\r\nX-Test: yes', '/\t/x', '/x\x00', 'https://example.com', None, 12]:
            with self.subTest(value=value):
                self.assertEqual(auth.safe_next(value), '/')

    def test_redirect_preserves_local_destination(self):
        self.assertEqual(auth.safe_next('/stock/005930?date=20260904#news'), '/stock/005930?date=20260904#news')

    def test_session_round_trip_and_tampering(self):
        with patch.object(auth.time, 'time', return_value=1000):
            token = auth.sign_session({'sub': 'user-1', 'name': '테스트'})
            self.assertEqual(auth.verify_session(token)['name'], '테스트')
            self.assertIsNone(auth.verify_session(token[:-1] + ('1' if token[-1] != '1' else '2')))

    def test_bad_session_encoding_or_shape_is_unauthenticated(self):
        for token in ['é.x', 'abc.한글', 'abc', '', None, [], '!.0', 'a.' + '0' * 64]:
            with self.subTest(token=token):
                self.assertIsNone(auth.verify_session(token))

    def test_expired_boundary_and_malformed_signed_payload(self):
        with patch.object(auth.time, 'time', return_value=1000):
            for payload in [{'sub': 'u', 'exp': 999}, {'sub': 'u', 'exp': 1000}, {'sub': 'u', 'exp': 'bad'}, {'sub': 'u', 'exp': float('inf')}, [], {'exp': 1001}]:
                with self.subTest(payload=payload):
                    self.assertIsNone(auth.verify_session(self.signed_payload(payload)))


class LoginTest(OfflineTest):
    def post(self, body):
        h = handler(login, body)
        with patch.object(login, 'ADMIN_TOKEN', 'test-admin'), patch.object(login, 'SESSION_SECRET', 'test-secret'):
            h.do_POST()
        return h

    def test_non_object_or_non_string_token_is_bad_request(self):
        for body in [[], 123, 'value', {'token': 123}, {'token': []}]:
            with self.subTest(body=body):
                self.assertEqual(self.post(body).status, 400)

    def test_unicode_wrong_token_is_unauthorized(self):
        for token in ['잘못된 토큰', '\ud800']:
            self.assertEqual(self.post({'token': token}).status, 401)

    def test_correct_token_sets_protected_cookie(self):
        h = self.post({'token': 'test-admin'})
        self.assertEqual(h.status, 200)
        self.assertTrue(response(h)['authed'])
        cookie = h.response_headers['Set-Cookie']
        for flag in ['HttpOnly', 'Secure', 'SameSite=Lax']:
            self.assertIn(flag, cookie)
        self.assertNotIn('test-admin', cookie)


class GithubTest(OfflineTest):
    def test_empty_dispatch_success_is_reported_queued(self):
        with patch('urllib.request.urlopen', return_value=io.BytesIO(b'')) as fetch:
            self.assertTrue(admin._trigger_rebuild('20260904', '005930'))
            self.assertEqual(fetch.call_args.args[0].method, 'POST')

    def test_json_success_remains_decoded(self):
        with patch('urllib.request.urlopen', return_value=io.BytesIO(b'{"sha":"abc"}')):
            self.assertEqual(admin._gh('GET', '/test'), {'sha': 'abc'})

    def test_alphanumeric_ticker_post_and_delete_reach_github(self):
        for method in ['POST', 'DELETE']:
            with self.subTest(method=method), patch.object(admin, 'ADMIN_TOKEN', 'test-admin'), patch.object(admin, 'SESSION_SECRET', 'test-secret'), patch.object(admin, 'GITHUB_TOKEN', 'test-github'):
                existing = {'00088K': {'rise_reason': 'old'}} if method == 'DELETE' else {}
                stored = base64.b64encode(json.dumps(existing).encode()).decode()
                h = handler(admin, {'date': '20260904', 'ticker': '00088K', 'rise_reason': 'updated'})
                h.path = '/api/admin-override?date=20260904&ticker=00088K'
                h.headers['Cookie'] = 'wr_admin=' + admin._sign()
                with patch.object(admin, '_gh', side_effect=[{'content': stored, 'sha': 'old-sha'}, {'content': {'sha': 'new-sha'}}, None]) as gh:
                    getattr(h, 'do_' + method)()
                self.assertEqual(h.status, 200)
                self.assertTrue(response(h)['sync_queued'])
                self.assertEqual([call.args[0] for call in gh.call_args_list], ['GET', 'PUT', 'POST'])
                written = json.loads(base64.b64decode(gh.call_args_list[1].args[2]['content']))
                if method == 'POST':
                    self.assertEqual(written['00088K']['rise_reason'], 'updated')
                else:
                    self.assertNotIn('00088K', written)
                self.assertEqual(gh.call_args_list[2].args[2]['client_payload'], {'date': '20260904', 'ticker': '00088K'})

    def test_admin_login_and_override_normalize_environment_identically(self):
        for secret, expected in [(' test-secret \n', 'test-secret'), (' \n', 'test-admin')]:
            with self.subTest(secret=repr(secret)), patch.dict(os.environ, {'ADMIN_TOKEN': ' test-admin \n', 'SESSION_SECRET': secret}):
                configured_login = load('admin-login')
                configured_admin = load('admin-override')
                self.assertEqual(configured_login.ADMIN_TOKEN, 'test-admin')
                self.assertEqual(configured_admin.ADMIN_TOKEN, 'test-admin')
                self.assertEqual(configured_login.SESSION_SECRET, expected)
                self.assertEqual(configured_admin.SESSION_SECRET, expected)
                h = handler(configured_login, {'token': 'test-admin'})
                h.do_POST()
                self.assertEqual(h.status, 200)
                cookie = h.response_headers['Set-Cookie'].split(';', 1)[0]
                self.assertTrue(configured_admin._is_authed({'Cookie': cookie}))
                self.assertEqual(configured_login._sign(), configured_admin._sign())


class RatingsTest(OfflineTest):
    def setUp(self):
        super().setUp()
        for name, value in [('KV_URL', 'https://unused.invalid'), ('KV_TOKEN', 'test-token')]:
            p = patch.object(ratings, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(ratings, '_keys_for_request', return_value=('ratings', 'time', True))
        p.start()
        self.addCleanup(p.stop)

    def post(self, body, result=None):
        h = handler(ratings, body)
        with patch.object(ratings, '_kv_pipeline', return_value=result if result is not None else [{'result': 'OK'}, {'result': 'OK'}]) as kv:
            h.do_POST()
        return h, kv

    def test_non_object_body_does_not_write(self):
        for body in [[], 123, 'text']:
            with self.subTest(body=body):
                h, kv = self.post(body)
                self.assertEqual(h.status, 400)
                kv.assert_not_called()

    def test_invalid_numeric_stars_do_not_crash_or_leak_nonfinite_json(self):
        for stars in [float('nan'), float('inf'), -float('inf'), 10 ** 400, True]:
            with self.subTest(stars=str(stars)[:20]):
                h, kv = self.post({'ratings': {'005930': {'stars': stars, 'memo': 'keep'}}})
                self.assertEqual(h.status, 200)
                saved = json.loads(kv.call_args.args[0][0][2])
                self.assertEqual(saved, {'005930': {'memo': 'keep'}})

    def test_per_command_write_errors_are_not_success(self):
        for result in [[{'error': 'failed'}, {'result': 'OK'}], [{'result': 'OK'}, {'error': 'failed'}], [{'result': 'OK'}], []]:
            with self.subTest(result=result):
                h, _ = self.post({'ratings': {'005930': {'stars': 3}}}, result)
                self.assertEqual(h.status, 502)
                self.assertFalse(response(h)['ok'])

    def test_successful_write_preserves_supported_fields(self):
        h, kv = self.post({'ratings': {'005930': {'stars': 3, 'memo': '관심', 'excluded': False, 'unexpected': 'drop'}}})
        self.assertEqual(h.status, 200)
        self.assertEqual(response(h)['count'], 1)
        self.assertEqual(json.loads(kv.call_args.args[0][0][2]), {'005930': {'stars': 3, 'memo': '관심', 'excluded': False}})

    def test_read_command_failure_is_not_empty_success(self):
        for result in [[{'error': 'failed'}, {'result': None}], [{'result': '{}'}, {'error': 'failed'}]]:
            with self.subTest(result=result):
                h = handler(ratings)
                with patch.object(ratings, '_kv_pipeline', return_value=result):
                    h.do_GET()
                self.assertEqual(h.status, 502)

    def test_successful_read_and_empty_account(self):
        for raw, expected in [(None, {}), ('{"005930":{"stars":3}}', {'005930': {'stars': 3}})]:
            with self.subTest(raw=raw):
                h = handler(ratings)
                with patch.object(ratings, '_kv_pipeline', return_value=[{'result': raw}, {'result': '1000'}]):
                    h.do_GET()
                self.assertEqual(h.status, 200)
                self.assertEqual(response(h)['ratings'], expected)


class MarketTest(OfflineTest):
    def snapshot(self, exchange='KOSPI', date='2026-09-04T15:30:00', status='CLOSE'):
        stock = {'stockEndType': 'stock', 'itemCode': '005930' if exchange == 'KOSPI' else '000660', 'stockName': 'Test', 'marketValueRaw': 1000000000, 'closePriceRaw': 100, 'fluctuationsRatio': '2.0', 'localTradedAt': date, 'marketStatus': status}
        url = market.URL_MCAP.format(ex='', mkt=exchange, page=1)
        return {url: {'stocks': [stock]}}

    def get(self, fetched):
        h = handler(market)
        with patch.object(market, '_exchange_segment', return_value=''), patch.object(market, '_fetch_all', return_value=fetched):
            h.do_GET()
        return h

    def test_all_upstream_failure_is_not_cached_closed_market(self):
        h = self.get({url: None for url in market._build_urls('')})
        self.assertEqual(h.status, 502)
        self.assertEqual(h.response_headers['Cache-Control'], 'no-store')

    def test_valid_open_snapshot_has_date_and_live_cache(self):
        h = self.get(self.snapshot(status='OPEN'))
        self.assertEqual(h.status, 200)
        self.assertEqual(response(h)['date'], '20260904')
        self.assertEqual(response(h)['items'][0]['change_rate'], 2)
        self.assertEqual(h.response_headers['Cache-Control'], market.CACHE_OPEN)

    def test_kosdaq_metadata_fallback_retains_available_market(self):
        h = self.get(self.snapshot(exchange='KOSDAQ'))
        self.assertEqual(h.status, 200)
        self.assertEqual(response(h)['date'], '20260904')
        self.assertEqual(response(h)['items'][0]['market'], 'KOSDAQ')

    def test_missing_date_or_status_fails_without_cache(self):
        for fetched in [self.snapshot(date=''), self.snapshot(status='UNKNOWN')]:
            h = self.get(fetched)
            self.assertEqual(h.status, 502)
            self.assertEqual(h.response_headers['Cache-Control'], 'no-store')


if __name__ == '__main__':
    unittest.main()
