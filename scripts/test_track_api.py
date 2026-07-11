"""api/track.py 회귀 테스트 — utm allowlist·referrer host·Origin·핸들러 레벨 검증.

네트워크/KV 접근 없음: 핸들러 테스트는 _kv_pipeline 을 기록용 스텁으로 교체한다.
실행: python scripts/test_track_api.py
"""
import importlib.util
import io
import json
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location('track_api', _REPO / 'api' / 'track.py')
track = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(track)


class UtmRefTest(unittest.TestCase):
    """visitor.js 가 만드는 utm:source[/campaign] 형식만 통과해야 한다."""

    def test_valid_utm_kept(self):
        self.assertEqual(track._ref_host('utm:telegram/daily'), 'utm:telegram/daily')
        self.assertEqual(track._ref_host('utm:share'), 'utm:share')
        self.assertEqual(track._ref_host('utm:google-ads/spring_2026.v1'),
                         'utm:google-ads/spring_2026.v1')

    def test_html_specials_rejected(self):
        self.assertEqual(track._ref_host('utm:<script>alert(1)</script>'), '')
        self.assertEqual(track._ref_host('utm:a"onmouseover=alert(1)'), '')
        self.assertEqual(track._ref_host("utm:a'b"), '')
        self.assertEqual(track._ref_host('utm:<img src=x onerror=alert(1)>'), '')

    def test_space_scheme_rejected(self):
        self.assertEqual(track._ref_host('utm:tele gram'), '')
        self.assertEqual(track._ref_host('utm:javascript:alert(1)'), '')
        self.assertEqual(track._ref_host('utm:data:text/html;base64,xx'), '')

    def test_extra_segment_and_length_rejected(self):
        self.assertEqual(track._ref_host('utm:a/b/c'), '')
        self.assertEqual(track._ref_host('utm:' + 'a' * 41), '')
        self.assertEqual(track._ref_host('utm:'), '')

    def test_non_ascii_rejected(self):
        # allowlist 는 ASCII 영숫자·._- 만 — 한글 utm 은 집계에서 제외(형식 위반)
        self.assertEqual(track._ref_host('utm:텔레그램'), '')


class RefHostTest(unittest.TestCase):
    """일반 referrer 는 검증된 DNS 호스트만, 자기 도메인은 제외."""

    def test_external_host_kept(self):
        self.assertEqual(track._ref_host('https://news.naver.com/article/1'), 'news.naver.com')
        self.assertEqual(track._ref_host('https://EXAMPLE.com/x?y=1'), 'example.com')

    def test_own_domains_excluded(self):
        self.assertEqual(track._ref_host('https://orgo.kr/page'), '')
        self.assertEqual(track._ref_host('https://www.orgo.kr/'), '')
        self.assertEqual(track._ref_host('https://whyrise.vercel.app/'), '')

    def test_markup_in_netloc_rejected(self):
        # urlparse 는 netloc 의 <> 를 그대로 반환 — 재검증으로 걸러야 함
        self.assertEqual(track._ref_host('http://<script>alert(1)</script>/'), '')
        self.assertEqual(track._ref_host('http://"onmouseover=x/'), '')

    def test_garbage_rejected(self):
        self.assertEqual(track._ref_host('not a url'), '')
        self.assertEqual(track._ref_host(''), '')
        self.assertEqual(track._ref_host(None), '')
        self.assertEqual(track._ref_host(['https://evil.example']), '')
        self.assertEqual(track._ref_host({'url': 'https://evil.example'}), '')
        self.assertEqual(track._ref_host('https://' + 'a' * 100 + '.com/'), '')


class OriginTest(unittest.TestCase):
    """same-origin allowlist — 외부 Origin 403, Origin 없음(sendBeacon/서버)은 허용."""

    def test_allowed_origins(self):
        for o in ('https://orgo.kr', 'https://www.orgo.kr', 'https://whyrise.vercel.app'):
            self.assertTrue(track._origin_allowed(o), o)

    def test_local_dev_allowed(self):
        self.assertTrue(track._origin_allowed('http://localhost:8000'))
        self.assertTrue(track._origin_allowed('http://127.0.0.1:3000'))

    def test_missing_origin_allowed(self):
        self.assertTrue(track._origin_allowed(''))

    def test_foreign_origins_rejected(self):
        for o in ('https://evil.com', 'null', 'https://orgo.kr.evil.com',
                  'http://orgo.kr', 'https://sub.orgo.kr'):
            self.assertFalse(track._origin_allowed(o), o)


class _StubHandler(track.handler):
    """소켓 없이 do_POST/do_OPTIONS 를 실행하는 스텁.

    BaseHTTPRequestHandler.__init__ 은 소켓을 받아 즉시 handle() 을 돌리므로
    호출하지 않고, 핸들러 메서드가 쓰는 속성·출력 메서드만 직접 구성한다.
    """

    def __init__(self, headers=None, body=b''):
        self.headers = dict(headers or {})
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = []

    def send_response(self, code, message=None):
        self.status = code

    def send_header(self, keyword, value):
        self.response_headers.append((keyword, value))

    def end_headers(self):
        pass

    def response_json(self):
        return json.loads(self.wfile.getvalue().decode('utf-8'))


class HandlerPostTest(unittest.TestCase):
    """do_POST 핸들러 레벨 — Origin 검증이 본문 읽기·KV 작업보다 먼저 실행돼야 한다."""

    def setUp(self):
        self._orig_kv = track._kv_pipeline
        self.kv_calls = []
        track._kv_pipeline = lambda commands: self.kv_calls.append(commands)

    def tearDown(self):
        track._kv_pipeline = self._orig_kv

    def _post(self, origin, payload):
        body = json.dumps(payload).encode('utf-8')
        headers = {'Content-Length': str(len(body))}
        if origin is not None:
            headers['Origin'] = origin
        h = _StubHandler(headers, body)
        h.do_POST()
        return h

    def test_allowed_origin_reaches_normal_handling(self):
        h = self._post('https://orgo.kr',
                       {'sid': 's1', 'pv': True, 'ref': 'https://news.naver.com/a'})
        self.assertEqual(h.status, 200)
        self.assertEqual(h.response_json(), {'ok': True})
        self.assertEqual(len(self.kv_calls), 1)
        cmds = self.kv_calls[0]
        self.assertEqual(cmds[0][:2], ['ZADD', track.ONLINE_KEY])
        self.assertEqual(cmds[0][3], 's1')
        zincrby = [c for c in cmds if c[0] == 'ZINCRBY']
        self.assertEqual(len(zincrby), 1)
        self.assertEqual(zincrby[0][3], 'news.naver.com')

    def test_foreign_and_null_origin_403_before_kv(self):
        for origin in ('https://evil.com', 'null', 'https://orgo.kr.evil.com'):
            with self.subTest(origin=origin):
                h = self._post(origin, {'sid': 's1', 'pv': True})
                self.assertEqual(h.status, 403)
                self.assertEqual(h.response_json(),
                                 {'ok': False, 'error': 'forbidden origin'})
                self.assertEqual(h.rfile.tell(), 0)   # 본문 읽기 전에 차단
        self.assertEqual(self.kv_calls, [])           # KV 파이프라인 미호출

    def test_missing_origin_allowed_documented_tradeoff(self):
        # Origin 없는 요청 허용은 ALLOWED_ORIGINS 주석에 문서화된 의도적 트레이드오프
        h = self._post(None, {'sid': 's2'})
        self.assertEqual(h.status, 200)
        self.assertEqual(h.response_json(), {'ok': True})
        self.assertEqual(len(self.kv_calls), 1)

    def test_malicious_ref_never_reaches_kv(self):
        for ref in ('utm:<img src=x onerror=alert(1)>',
                    'http://<script>alert(1)</script>/'):
            with self.subTest(ref=ref):
                self.kv_calls.clear()
                h = self._post('https://orgo.kr', {'sid': 's3', 'pv': True, 'ref': ref})
                self.assertEqual(h.status, 200)
                cmds = self.kv_calls[0]
                self.assertEqual([c for c in cmds if c[0] == 'ZINCRBY'], [])

    def test_non_object_body_and_non_string_sid_are_400(self):
        for payload in (['not', 'an', 'object'], {'sid': ['not-a-string']}):
            with self.subTest(payload=payload):
                self.kv_calls.clear()
                h = self._post('https://orgo.kr', payload)
                self.assertEqual(h.status, 400)
                self.assertEqual(self.kv_calls, [])


class HandlerOptionsTest(unittest.TestCase):
    """do_OPTIONS — 204 + Allow 만 응답, CORS 허용 헤더 재도입 방지."""

    def test_options_no_cors_headers(self):
        h = _StubHandler()
        h.do_OPTIONS()
        self.assertEqual(h.status, 204)
        headers = dict(h.response_headers)
        self.assertEqual(headers.get('Allow'), 'POST, OPTIONS')
        for name, _ in h.response_headers:
            self.assertFalse(name.lower().startswith('access-control-'), name)
        self.assertEqual(h.wfile.getvalue(), b'')


class NoWildcardCorsTest(unittest.TestCase):
    """OPTIONS 에서 Access-Control-Allow-Origin:* 재도입 방지 tripwire."""

    def test_source_has_no_acao(self):
        src = (_REPO / 'api' / 'track.py').read_text(encoding='utf-8')
        self.assertNotIn('Access-Control-Allow-Origin', src)


if __name__ == '__main__':
    unittest.main()
