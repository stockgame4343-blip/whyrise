"""scripts/build-history.py 단위 테스트 — is_52w_high 3-상태·이벤트 윈도우 분리·
override bake/원복·override-sync 단일 날짜 동기화·워크플로우 불변식 (네트워크 없음).

실행: python scripts/test_build_history.py
"""
import argparse
import copy
import importlib.util
import inspect
import json
import re
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

_spec = importlib.util.spec_from_file_location('build_history', _REPO / 'scripts' / 'build-history.py')
bh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bh)


def _row(day_idx: int, high: float, close: float | None = None) -> dict:
    """영업일 흉내 — 날짜 문자열은 정렬만 되면 됨."""
    base = date(2024, 1, 1) + timedelta(days=day_idx)
    return {
        'localDate': base.strftime('%Y%m%d'),
        'highPrice': high,
        'closePrice': close if close is not None else high,
        'accumulatedTradingVolume': 1000,
    }


def _ohlc(highs: list[float]) -> list[dict]:
    return [_row(i, h) for i, h in enumerate(highs)]


class OhlcCacheRangeTest(unittest.TestCase):
    """넓은 전날 cache 에서 부족 구간만 받아 병합 — 52주 전송량 회귀 방지."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_dir = bh._OHLC_CACHE_DIR
        self.orig_fetch = bh.naver_client.fetch_ohlc_daily
        self.orig_time = bh.time.time
        bh._OHLC_CACHE_DIR = Path(self.tmp.name)
        self.fake_now = self.orig_time()
        bh.time.time = lambda: self.fake_now
        bh._ohlc_cache_stats.update(hit=0, miss=0)
        self.calls = []

    def tearDown(self):
        bh._OHLC_CACHE_DIR = self.orig_dir
        bh.naver_client.fetch_ohlc_daily = self.orig_fetch
        bh.time.time = self.orig_time
        self.tmp.cleanup()

    def _seed(self, start, end, rows, fetched_at=None):
        if fetched_at is None:
            fetched_at = self.fake_now - 100
        p = Path(self.tmp.name) / '005930.json'
        p.write_text(json.dumps({'ticker': '005930', 'start': start, 'end': end,
                                 'fetched_at': fetched_at, 'rows': rows}), encoding='utf-8')

    def _fake(self, rows_by_range):
        def fetch(ticker, start, end):
            self.calls.append((ticker, start, end))
            return rows_by_range.get((start, end), [])
        bh.naver_client.fetch_ohlc_daily = fetch

    def test_next_day_fetches_tail_only_and_merges(self):
        self._seed('20250101', '20260710', [
            {'localDate': '20250102', 'closePrice': 10},
            {'localDate': '20260710', 'closePrice': 20},
        ])
        self._fake({('20260710', '20260711'): [
            {'localDate': '20260710', 'closePrice': 21},
            {'localDate': '20260711', 'closePrice': 22},
        ]})
        rows = bh.fetch_ohlc_cached('005930', '20250301', '20260711')
        self.assertEqual(self.calls, [('005930', '20260710', '20260711')])
        by_date = {r['localDate']: r for r in rows}
        self.assertEqual(by_date['20260710']['closePrice'], 21)
        self.assertEqual(by_date['20260711']['closePrice'], 22)
        blob = json.loads((Path(self.tmp.name) / '005930.json').read_text(encoding='utf-8'))
        self.assertEqual(blob['start'], '20250101')
        self.assertEqual(blob['end'], '20260711')

    def test_wider_same_day_request_fetches_head_only(self):
        self._seed('20250301', '20260711', [{'localDate': '20260301', 'closePrice': 20}])
        self._fake({('20250220', '20250301'): [
            {'localDate': '20250220', 'closePrice': 10},
        ]})
        bh.fetch_ohlc_cached('005930', '20250220', '20260711')
        self.assertEqual(self.calls, [('005930', '20250220', '20250301')])

    def test_stale_intraday_cache_refreshes_last_day_only(self):
        today = date.today().strftime('%Y%m%d')
        self._seed('20250101', today, [{'localDate': today, 'closePrice': 20}],
                   fetched_at=self.fake_now - 2000)
        self._fake({(today, today): [{'localDate': today, 'closePrice': 21}]})
        rows = bh.fetch_ohlc_cached('005930', '20250301', today, ttl_s=20 * 60)
        self.assertEqual(self.calls, [('005930', today, today)])
        self.assertEqual(rows[-1]['closePrice'], 21)

    def test_empty_partial_response_falls_back_to_full_request(self):
        self._seed('20250101', '20260710', [{'localDate': '20260710', 'closePrice': 20}])
        self._fake({
            ('20260710', '20260711'): [],
            ('20250301', '20260711'): [{'localDate': '20260711', 'closePrice': 22}],
        })
        rows = bh.fetch_ohlc_cached('005930', '20250301', '20260711')
        self.assertEqual(self.calls, [
            ('005930', '20260710', '20260711'),
            ('005930', '20250301', '20260711'),
        ])
        self.assertEqual(rows, [{'localDate': '20260711', 'closePrice': 22}])


class Is52wHighTest(unittest.TestCase):

    def test_251_prior_rows_returns_none(self):
        # idx=251 → 직전 251개뿐 — unknown
        ohlc = _ohlc([100.0] * 251 + [999.0])
        self.assertIsNone(bh.is_52w_high(ohlc, 251))

    def test_various_short_windows_return_none(self):
        ohlc = _ohlc([100.0] * 100)
        self.assertIsNone(bh.is_52w_high(ohlc, 0))
        self.assertIsNone(bh.is_52w_high(ohlc, 1))
        self.assertIsNone(bh.is_52w_high(ohlc, 99))

    def test_252_prior_rows_true(self):
        # idx=252 → 직전 정확히 252개 완비 — 신고가 True
        ohlc = _ohlc([100.0] * 252 + [150.0])
        self.assertIs(bh.is_52w_high(ohlc, 252), True)

    def test_252_prior_rows_false(self):
        # 직전 252개 안에 더 높은 고가 존재 — False
        ohlc = _ohlc([100.0] * 100 + [200.0] + [100.0] * 151 + [150.0])
        self.assertEqual(len(ohlc), 253)
        self.assertIs(bh.is_52w_high(ohlc, 252), False)

    def test_equal_to_prior_max_is_true(self):
        ohlc = _ohlc([100.0] * 252 + [100.0])
        self.assertIs(bh.is_52w_high(ohlc, 252), True)

    def test_lookback_is_exactly_252(self):
        # 253번째 전(윈도우 밖)의 고가는 무시돼야 함
        ohlc = _ohlc([999.0] + [100.0] * 252 + [150.0])
        self.assertIs(bh.is_52w_high(ohlc, 253), True)

    def test_missing_high_price_returns_none(self):
        ohlc = _ohlc([100.0] * 253)
        ohlc[252]['highPrice'] = 0
        self.assertIsNone(bh.is_52w_high(ohlc, 252))

    def test_invalid_prior_high_makes_window_unknown(self):
        invalid_values = (None, 0, -1, 'not-a-number', float('nan'), float('inf'), True)
        for invalid in invalid_values:
            with self.subTest(invalid=invalid):
                ohlc = _ohlc([100.0] * 252 + [150.0])
                ohlc[100]['highPrice'] = invalid
                self.assertIsNone(bh.is_52w_high(ohlc, 252))

    def test_numeric_string_high_is_accepted(self):
        ohlc = _ohlc([100.0] * 252 + [150.0])
        ohlc[100]['highPrice'] = '100.0'
        self.assertIs(bh.is_52w_high(ohlc, 252), True)


class EventWindowTest(unittest.TestCase):
    """event_start 이전 OHLC 는 lookback 전용 — 이벤트로 출력되지 않아야 한다."""

    def _build(self, ohlc, event_start):
        return bh.build_events_for_ticker(
            ticker='000001', name='테스트', market='KOSPI',
            ohlc=ohlc, cutoff=10.0,
            stockrise_lookup={},
            fetch_news_fn=lambda t, d: [],
            meta={'sector': '테스트섹터'},
            event_start=event_start,
        )

    def test_events_only_within_window(self):
        # 3 영업일 연속 +20%: day0→1, day1→2 두 사건. event_start=day2 → day2 사건만
        ohlc = [_row(0, 100.0), _row(1, 120.0), _row(2, 144.0)]
        all_events = self._build(ohlc, event_start='')
        self.assertEqual(len(all_events), 2)
        windowed = self._build(ohlc, event_start=ohlc[2]['localDate'])
        self.assertEqual(len(windowed), 1)
        self.assertEqual(windowed[0]['date'], ohlc[2]['localDate'])

    def test_short_history_event_has_unknown_52w(self):
        # 직전 252거래일 미만 → 이벤트의 is_52w_high 는 None (json null)
        ohlc = [_row(0, 100.0), _row(1, 120.0)]
        events = self._build(ohlc, event_start='')
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]['is_52w_high'])

    def test_full_lookback_event_has_bool_52w(self):
        highs = [100.0] * 253
        ohlc = [_row(i, h) for i, h in enumerate(highs)]
        ohlc[-1]['highPrice'] = ohlc[-1]['closePrice'] = 130.0   # +30% 사건 + 신고가
        events = self._build(ohlc, event_start=ohlc[-1]['localDate'])
        self.assertEqual(len(events), 1)
        self.assertIs(events[0]['is_52w_high'], True)


class ApplyOverridesTest(unittest.TestCase):
    """bake 시 pre_override 백업, override 삭제 시 원복."""

    def setUp(self):
        bh._overrides_memo.clear()

    def tearDown(self):
        bh._overrides_memo.clear()

    def _event(self):
        return {
            'date': '20990101',   # 실제 override 파일이 존재할 수 없는 미래 일자
            'change_rate': 15.0,
            'rise_reason': '원본 사유',
            'reason_confidence': 'mid',
            'reason_source': 'news',
            'reason_status': 'filled',
            'theme_tag': '원본테마',
        }

    def test_bake_saves_backup_and_restore_on_delete(self):
        ev = self._event()
        # bake — 메모 캐시에 override 주입 (파일 IO 없이)
        bh._overrides_memo['20990101'] = {'000001': {'rise_reason': '관리자 사유', 'theme_tag': '새테마'}}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['rise_reason'], '관리자 사유')
        self.assertEqual(ev['theme_tag'], '새테마')
        self.assertEqual(ev['reason_source'], 'admin')
        self.assertEqual(ev['pre_override']['rise_reason'], '원본 사유')
        # 삭제 — override 파일에서 사라짐 → 백업으로 원복
        bh._overrides_memo['20990101'] = {}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['rise_reason'], '원본 사유')
        self.assertEqual(ev['reason_source'], 'news')
        self.assertEqual(ev['theme_tag'], '원본테마')
        self.assertNotIn('pre_override', ev)

    def test_rebake_keeps_original_backup(self):
        ev = self._event()
        bh._overrides_memo['20990101'] = {'000001': {'rise_reason': '1차 수정'}}
        bh.apply_overrides([ev], '000001')
        bh._overrides_memo['20990101'] = {'000001': {'rise_reason': '2차 수정'}}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['rise_reason'], '2차 수정')
        # 백업은 항상 최초 원본 — admin 값이 백업을 오염시키지 않음
        self.assertEqual(ev['pre_override']['rise_reason'], '원본 사유')
        self.assertEqual(ev['pre_override']['theme_tag'], '원본테마')

    def test_rebake_clearing_theme_and_note_reveals_original(self):
        """재저장 = replace — 나중 저장에서 지운 theme/note 는 이전 admin 값이 아니라 원본."""
        ev = self._event()
        bh._overrides_memo['20990101'] = {'000001': {
            'rise_reason': '1차 수정', 'theme_tag': '새테마', 'note': '메모1'}}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['theme_tag'], '새테마')
        self.assertEqual(ev['note'], '메모1')
        # 2차 저장 — theme_tag/note 지움(서버는 키 생략으로 저장)
        bh._overrides_memo['20990101'] = {'000001': {'rise_reason': '2차 수정'}}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['rise_reason'], '2차 수정')
        self.assertEqual(ev['theme_tag'], '원본테마', '지운 테마 → 원본 테마 복원')
        self.assertNotIn('note', ev, '지운 note → 원본 부재 복원')
        # 백업(최초 원본)은 재저장에도 오염되지 않음
        self.assertEqual(ev['pre_override']['rise_reason'], '원본 사유')
        self.assertEqual(ev['pre_override']['theme_tag'], '원본테마')
        self.assertNotIn('note', ev['pre_override'])

    def test_delete_after_note_bake_restores_absence(self):
        ev = self._event()
        bh._overrides_memo['20990101'] = {'000001': {'rise_reason': '관리자 사유', 'note': '메모'}}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['note'], '메모')
        bh._overrides_memo['20990101'] = {}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['rise_reason'], '원본 사유')
        self.assertNotIn('note', ev)
        self.assertNotIn('pre_override', ev)

    def test_legacy_admin_bake_without_backup_never_creates_backup(self):
        """구버전 bake(백업 없음, reason_source=admin) — admin 값으로 백업을 만들면
        그게 '원본'으로 굳어 오염된다. 백업 생성 금지, 최신 기여 덧적용만."""
        ev = self._event()
        ev['rise_reason'] = '구버전 admin 사유'
        ev['reason_source'] = 'admin'
        ev['reason_status'] = 'edited'
        bh._overrides_memo['20990101'] = {'000001': {'rise_reason': '새 사유'}}
        bh.apply_overrides([ev], '000001')
        self.assertEqual(ev['rise_reason'], '새 사유')
        self.assertNotIn('pre_override', ev)


class OverrideSyncCoreTest(unittest.TestCase):
    """_sync_ticker_events — target 날짜 1건만 교체/제거, 나머지 보존 + 종목 전체 수렴.

    reconstruct_fn 주입으로 네트워크 없이 검증. override 는 메모 캐시 주입
    (기존 ApplyOverridesTest 패턴).
    """

    TICKER = '000001'

    def setUp(self):
        bh._overrides_memo.clear()

    def tearDown(self):
        bh._overrides_memo.clear()

    def _ev(self, date_str, reason='원본 사유', source='news', **extra):
        e = {
            'date': date_str,
            'change_rate': 15.0,
            'close_price': 1000,
            'trading_volume': 10,
            'trading_value': 10000,
            'rise_reason': reason,
            'reason_confidence': 'mid',
            'reason_source': source,
            'reason_status': 'filled',
            'theme_tag': '원본테마',
            'news': [],
            'sector': '섹터',
            'is_52w_high': None,
            'source': 'estimated',
        }
        e.update(extra)
        return e

    def _seed(self, mapping):
        bh._overrides_memo.update(mapping)

    def test_legacy_admin_save_reconstructs_and_backs_up(self):
        """레거시 bake(백업 없음) 저장 — 소스 원본 복원 후 bake, 무관 이벤트는 객체째 보존."""
        enriched = self._ev('20990301', reason='LLM 정제 사유', source='llm', market_cap=777)
        legacy = self._ev('20990201', reason='구 admin 사유', source='admin',
                          reason_status='edited', market_cap=555)
        old = self._ev('20990101', reason='아주 오래된 원본')
        events = [enriched, legacy, old]
        snapshot = copy.deepcopy(events)
        self._seed({'20990201': {self.TICKER: {'rise_reason': '새 admin 사유'}},
                    '20990301': {}, '20990101': {}})
        rebuilt = self._ev('20990201', reason='소스 원본 사유')
        synced, _ = bh._sync_ticker_events(
            events, self.TICKER, '20990201', lambda: (bh._RECON_EVENT, dict(rebuilt)))
        self.assertIsNotNone(synced)
        self.assertEqual([e['date'] for e in synced], ['20990301', '20990201', '20990101'])
        self.assertIs(synced[0], enriched)
        self.assertIs(synced[2], old)
        self.assertEqual(synced[0], snapshot[0], '무관 LLM/enrich 이벤트 값 무변경')
        self.assertEqual(synced[2], snapshot[2])
        target = synced[1]
        self.assertEqual(target['rise_reason'], '새 admin 사유')
        self.assertEqual(target['reason_source'], 'admin')
        self.assertEqual(target['pre_override']['rise_reason'], '소스 원본 사유',
                         '백업은 admin 값이 아니라 소스 원본')
        self.assertEqual(target['market_cap'], 555, '재구성이 못 채우는 enrich 필드 승계')

    def test_save_normal_event_creates_backup_without_source(self):
        """일반 이벤트 저장 — 파일 내 원본으로 백업 생성, 소스 재구성 호출 금지."""
        ev = self._ev('20990201')
        self._seed({'20990201': {self.TICKER: {'rise_reason': '새 사유', 'theme_tag': '새테마'}}})
        synced, _ = bh._sync_ticker_events(
            [ev], self.TICKER, '20990201',
            lambda: self.fail('로컬 백업 가능 — 소스 재구성 불필요'))
        target = synced[0]
        self.assertEqual(target['rise_reason'], '새 사유')
        self.assertEqual(target['theme_tag'], '새테마')
        self.assertEqual(target['pre_override']['rise_reason'], '원본 사유')
        self.assertEqual(target['pre_override']['theme_tag'], '원본테마')

    def test_legacy_admin_delete_restores_from_source_even_old(self):
        """재빌드 윈도우(~395일)를 한참 벗어난 옛 레거시 bake 삭제도 소스 재구성으로 원복."""
        recent = self._ev('20990301', reason='LLM 정제 사유', source='llm')
        legacy = self._ev('20200105', reason='구 admin 사유', source='admin',
                          reason_status='edited', market_cap=555,
                          news=[{'title': '검증된 기존 기사'}], sector='기존섹터',
                          trading_volume=987654, trading_value=123456789,
                          is_52w_high=True, custom_enriched='보존값')
        self._seed({'20200105': {}, '20990301': {}})
        rebuilt = self._ev('20200105', reason='소스 원본 사유',
                           news=[{'title': '재조회 최신 기사'}], sector='재구성섹터',
                           trading_volume=1, trading_value=2,
                           is_52w_high=False, custom_enriched='덮으면안됨')
        synced, _ = bh._sync_ticker_events(
            [recent, legacy], self.TICKER, '20200105', lambda: (bh._RECON_EVENT, dict(rebuilt)))
        self.assertEqual(len(synced), 2)
        self.assertIs(synced[0], recent)
        restored = synced[1]
        self.assertEqual(restored['rise_reason'], '소스 원본 사유')
        self.assertEqual(restored['reason_source'], 'news')
        self.assertNotIn('pre_override', restored)
        self.assertEqual(restored['market_cap'], 555)
        self.assertEqual(restored['news'], [{'title': '검증된 기존 기사'}])
        self.assertEqual(restored['sector'], '기존섹터')
        self.assertEqual(restored['trading_volume'], 987654)
        self.assertEqual(restored['trading_value'], 123456789)
        self.assertIs(restored['is_52w_high'], True)
        self.assertEqual(restored['custom_enriched'], '보존값')

    def test_reconstructed_origin_only_replaces_override_fields(self):
        existing = self._ev('20200105', reason='admin', source='admin',
                            news=[{'title': '기존'}], sector='기존', custom='keep')
        rebuilt = self._ev('20200105', reason='원본', source='stockrise',
                           news=[{'title': '새것'}], sector='새것', custom='drop')
        merged = bh._merge_reconstructed_origin(existing, rebuilt)
        self.assertEqual(merged['rise_reason'], '원본')
        self.assertEqual(merged['reason_source'], 'stockrise')
        self.assertEqual(merged['news'], [{'title': '기존'}])
        self.assertEqual(merged['sector'], '기존')
        self.assertEqual(merged['custom'], 'keep')

    def test_insufficient_source_fails_without_touching_events(self):
        """소스 부족 — None 반환(쓰기 금지 신호), 기존 이벤트는 무변경."""
        legacy = self._ev('20200105', source='admin', reason_status='edited')
        other = self._ev('20990301')
        events = [other, legacy]
        snapshot = copy.deepcopy(events)
        self._seed({'20200105': {}, '20990301': {}})
        synced, _ = bh._sync_ticker_events(
            events, self.TICKER, '20200105', lambda: (bh._RECON_INSUFFICIENT, None))
        self.assertIsNone(synced)
        self.assertEqual(events, snapshot)

    def test_save_missing_event_reconstructs_and_inserts_sorted(self):
        """target 이벤트가 파일에 없으면 소스 재구성으로 삽입(내림차순 위치) 후 bake."""
        events = [self._ev('20990301'), self._ev('20990101')]
        self._seed({'20990201': {self.TICKER: {'rise_reason': '새 사유'}},
                    '20990301': {}, '20990101': {}})
        rebuilt = self._ev('20990201', reason='소스 원본 사유')
        synced, _ = bh._sync_ticker_events(
            events, self.TICKER, '20990201', lambda: (bh._RECON_EVENT, dict(rebuilt)))
        self.assertEqual([e['date'] for e in synced], ['20990301', '20990201', '20990101'])
        self.assertEqual(synced[1]['rise_reason'], '새 사유')
        self.assertEqual(synced[1]['pre_override']['rise_reason'], '소스 원본 사유')

    def test_delete_with_backup_restores_locally(self):
        """백업 있는 bake 삭제 — 소스 재구성 없이 pre_override 원복."""
        ev = self._ev('20990201', reason='admin 사유', source='admin', reason_status='edited')
        ev['pre_override'] = {'rise_reason': '원본 사유', 'reason_confidence': 'mid',
                              'reason_source': 'news', 'reason_status': 'filled',
                              'theme_tag': '원본테마'}
        self._seed({'20990201': {}})
        synced, _ = bh._sync_ticker_events(
            [ev], self.TICKER, '20990201',
            lambda: self.fail('백업 원복 가능 — 소스 재구성 불필요'))
        self.assertEqual(synced[0]['rise_reason'], '원본 사유')
        self.assertNotIn('pre_override', synced[0])

    def test_source_below_cutoff_removes_only_target(self):
        """소스 기준 컷 미달 — target 이벤트만 제거, 무관 이벤트 보존."""
        legacy = self._ev('20200105', source='admin', reason_status='edited')
        other = self._ev('20990301')
        self._seed({'20200105': {}, '20990301': {}})
        synced, _ = bh._sync_ticker_events(
            [other, legacy], self.TICKER, '20200105', lambda: (bh._RECON_NO_EVENT, None))
        self.assertEqual([e['date'] for e in synced], ['20990301'])
        self.assertIs(synced[0], other)

    def test_whole_ticker_convergence_applies_other_dates(self):
        """코얼레싱으로 다른 날짜 payload 가 유실돼도, 살아남은 실행이 커밋된 override
        상태 전체를 수렴 — 다른 날짜의 저장 bake + 백업 원복 삭제가 함께 반영된다."""
        d1 = self._ev('20990301')
        d2 = self._ev('20990201')
        d3 = self._ev('20990101', reason='admin 사유', source='admin', reason_status='edited')
        d3['pre_override'] = {'rise_reason': '원본 사유', 'reason_confidence': 'mid',
                              'reason_source': 'news', 'reason_status': 'filled',
                              'theme_tag': '원본테마'}
        self._seed({'20990301': {self.TICKER: {'rise_reason': 'D1 사유'}},
                    '20990201': {self.TICKER: {'rise_reason': 'D2 사유'}},
                    '20990101': {}})
        synced, _ = bh._sync_ticker_events(
            [d1, d2, d3], self.TICKER, '20990301',
            lambda: self.fail('target 은 일반 이벤트 — 소스 재구성 불필요'))
        self.assertEqual(synced[0]['rise_reason'], 'D1 사유')
        self.assertEqual(synced[1]['rise_reason'], 'D2 사유')
        self.assertEqual(synced[1]['pre_override']['rise_reason'], '원본 사유')
        self.assertEqual(synced[2]['rise_reason'], '원본 사유')
        self.assertNotIn('pre_override', synced[2])


class OverrideSyncValidationTest(unittest.TestCase):
    """--ticker/--date 검증 — 형식 오류는 파일/네트워크 접근 전에 실패해야 한다."""

    def _args(self, **kw):
        base = {'ticker': '000001', 'date': '20990101', 'cutoff': 10.0, 'days': 365}
        base.update(kw)
        return argparse.Namespace(**base)

    def test_invalid_date_formats_fail(self):
        for bad in ('', '2026-07-11', '2026711', '20261301', '20260732', 'abcdefgh'):
            with self.subTest(date=bad):
                self.assertEqual(bh.build_override_sync(self._args(date=bad)), 1)

    def test_invalid_ticker_fails(self):
        self.assertEqual(bh.build_override_sync(self._args(ticker='00001')), 1)

    def test_parse_yyyymmdd(self):
        self.assertEqual(bh._parse_yyyymmdd('20260711'), date(2026, 7, 11))
        self.assertIsNone(bh._parse_yyyymmdd('20260011'))
        self.assertIsNone(bh._parse_yyyymmdd(None))


class OverrideSyncScopeInvariantsTest(unittest.TestCase):
    """override-sync 경로는 공유 파생물 재생성·광범위 윈도우 재빌드를 하면 안 된다."""

    _FORBIDDEN = ('build_report_summary', 'build_rise_history', 'build_pref_themes',
                  'build_screening_index', 'build_stock_prerender', 'build_sitemap',
                  'write_index', 'merge_ticker_events')

    def test_no_shared_regeneration_or_window_rebuild(self):
        src = (inspect.getsource(bh.build_override_sync)
               + inspect.getsource(bh._sync_ticker_events)
               + inspect.getsource(bh._reconstruct_target_event))
        for name in self._FORBIDDEN:
            self.assertNotIn(name, src, f'override-sync 경로에서 {name} 호출 금지')


class WorkflowInvariantsTest(unittest.TestCase):
    """build-history.yml — 비손실 concurrency 전략 + override job 최소 스텝."""

    @classmethod
    def setUpClass(cls):
        cls.text = (_REPO / '.github' / 'workflows' / 'build-history.yml').read_text(encoding='utf-8')

    def _job_block(self, job):
        lines = self.text.splitlines()
        jobs_at = next(i for i, ln in enumerate(lines) if ln.rstrip() == 'jobs:')
        start = next(i for i in range(jobs_at, len(lines))
                     if lines[i].rstrip() == f'  {job}:')
        end = next((i for i in range(start + 1, len(lines))
                    if re.match(r'^  [\w-]+:\s*$', lines[i])), len(lines))
        return '\n'.join(lines[start:end])

    def test_override_job_has_per_target_group(self):
        block = self._job_block('override-sync')
        self.assertIn('group: build-history-override-${{ github.event.client_payload.ticker }}-'
                      '${{ github.event.client_payload.date }}', block,
                      '종목+날짜별 그룹 - 서로 다른 target dispatch 코얼레싱 방지')
        self.assertIn('cancel-in-progress: false', block)

    def test_build_job_keeps_global_group_and_excludes_override_dispatch(self):
        block = self._job_block('build')
        self.assertRegex(block, re.compile(r'^\s+group: build-history\s*$', re.M))
        self.assertIn('cancel-in-progress: false', block)
        self.assertIn("!(github.event_name == 'repository_dispatch' && "
                      "github.event.action == 'override-saved' && "
                      "github.event.client_payload.ticker != '')", block,
                      'ticker payload override dispatch 는 build job 에서 제외')
        self.assertIn("grep -Ev '^public/data/stock-history/[0-9]{6}\\.json$'", block,
                      '전역 빌드와 fast override 종목 파일만 충돌할 때 구분')
        self.assertIn('git checkout --ours -- "$file"', block,
                      'rebase 시 최신 원격 override 종목 파일 보존')
        self.assertIn("if: steps.mode.outputs.mode == 'full' || "
                      "steps.mode.outputs.mode == 'incremental' || "
                      "steps.mode.outputs.mode == 'marketmap-only'", block,
                      'OHLC 미사용 intraday/estimate 모드의 대용량 cache churn 방지')

    def test_override_sync_flag_only_in_override_job(self):
        self.assertNotIn('--override-sync', self._job_block('build'))
        self.assertIn('--override-sync', self._job_block('override-sync'))

    def test_override_job_minimal_side_effects(self):
        block = self._job_block('override-sync')
        low = block.lower()
        for banned in ('telegram', 'upload-artifact', 'build_leaders_calendar',
                       '--llm-refine', '--incremental'):
            self.assertNotIn(banned, low, f'override job 에 부수효과 스텝 금지: {banned}')
        self.assertIn('public/data/stock-history/${OV_TICKER}.json', block,
                      '커밋 대상은 종목 파일 1개뿐')
        self.assertIn('git add "$TARGET"', block)
        self.assertNotIn('git add public/data/ ', block, '광범위 stage 금지')
        self.assertIn('git reset --hard FETCH_HEAD', block,
                      'push 경합 시 최신 원격에서 재계산하는 재시도 경로')


class DownstreamNoneTest(unittest.TestCase):
    """unknown(None) 이 신고가 True 로 집계되지 않아야 한다."""

    def test_bool_coercion_of_none_is_false(self):
        self.assertFalse(bool(None))

    def test_estimate_reason_none_skips_high_pattern(self):
        from scripts.estimate_reasons import estimate_reason
        est = estimate_reason(news_items=[], change_rate=15.0, is_52w_high=None, meta=None)
        self.assertNotEqual(est['rise_reason'], '52주 신고가 도달')


if __name__ == '__main__':
    unittest.main()
