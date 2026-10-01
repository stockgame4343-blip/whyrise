import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import date
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from scripts import llm_reasons as llm
spec = importlib.util.spec_from_file_location('stock_reason', ROOT / 'api/stock-reason.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

class ReasonQualityTest(unittest.TestCase):
    def target(self, day='20260904'):
        return llm._target_from_event('005930', '삼성전자', {
            'date':day, 'rise_reason':'시장 관심 증가', 'news':[
                {'title':'삼성전자 오래된 계약','date':'2026.07.01'},
                {'title':'삼성전자 공급계약','date':'2026.09.04','link':'https://example.com/a'},
                {'title':'삼성전자 공급계약','date':'2026.09.04','link':'https://example.com/copy'},
                {'title':'삼성전자 미래 실적','date':'2026.09.05'},
                {'title':'삼성전자 신규 수주','date':'2026.09.03','link':'https://example.com/b'},
            ]})

    def test_date_dedupe_and_original_indices(self):
        self.assertEqual([n['i'] for n in self.target()['news']], [1,4])

    def test_empty_evidence_cannot_replace(self):
        v=llm._validate({'action':'replace','reason':'공급계약 체결','confidence':'high','evidence':[]},self.target())
        self.assertEqual(v['action'],'no_evidence')

    def test_boolean_duplicate_and_stale_indices_do_not_raise_confidence(self):
        v=llm._validate({'action':'replace','reason':'공급계약 체결','confidence':'high','evidence':[True,1,1,0,999]},self.target())
        self.assertEqual(v['evidence'],[1]);self.assertEqual(v['confidence'],'mid')

    def test_two_unique_named_sources_can_be_high(self):
        v=llm._validate({'action':'replace','reason':'공급계약 체결','confidence':'high','evidence':[1,4]},self.target())
        self.assertEqual(v['confidence'],'high')

    def test_original_article_provenance(self):
        ev={'news':[{'title':'old'},{'title':'evidence'}]}
        llm._reorder_news(ev,[1])
        self.assertEqual(ev['reason_evidence'],[{'title':'evidence'}])
        self.assertEqual(ev['news'][0]['title'],'evidence')

    def test_backfill_same_ticker_dates_are_separate(self):
        a=self.target(); b=dict(a,date='20260903')
        def respond(items,key):
            self.assertEqual(len({i['ticker'] for i in items}),len(items))
            return [{'ticker':i['ticker'],'action':'keep'} for i in items]
        with patch.object(llm,'_call_batch',side_effect=respond):
            verdicts,stats=llm.refine([a,b],'test')
        self.assertEqual(len(verdicts),2);self.assertEqual(stats['sent'],2)

    def test_day_date_applied_before_news_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'20260904.json'
            p.write_text(json.dumps({'date':'20260904','rankings':[{'ticker':'005930','name':'삼성전자','change_rate':20,'news':[{'title':'삼성전자 계약','date':'2026.09.04','link':'https://example.com/a'}]}]}),encoding='utf8')
            self.assertEqual(len(llm.collect_day_targets(p)[0]['news']),1)

    def test_same_article_url_and_unverifiable_links_are_not_evidence(self):
        target=llm._target_from_event('005930','삼성전자',{'date':'20260904','news':[
            {'title':'삼성전자 계약','date':'2026.09.04','link':'https://example.com/a'},
            {'title':'삼성전자 계약 수정 제목','date':'2026.09.04','link':'https://example.com/a#headline'},
            {'title':'삼성전자 링크 없음','date':'2026.09.04'},
            {'title':'삼성전자 잘못된 링크','date':'2026.09.04','link':'javascript:alert(1)'},
        ]})
        self.assertEqual([n['i'] for n in target['news']],[0])

    def test_unrelated_articles_cannot_replace_or_reverse_reason(self):
        target=self.target()
        target['news']=[{'i':1,'title':'미국 시장 주요 지수 상승','date':'2026.09.04'}]
        for action in ('replace','flag_reversal'):
            self.assertEqual(llm._validate({'action':action,'reason':'신규 계약','evidence':[1]},target)['action'],'no_evidence')

    def test_fallback_preserves_existing_specific_reason(self):
        target=dict(self.target(),verify_only=True,rise_reason='신규 공급계약 체결',reason_source='stockrise')
        with patch.object(llm,'_call_batch',side_effect=RuntimeError('credit exhausted')):
            verdicts,_=llm.refine([target],'test')
        self.assertEqual(verdicts[('005930','20260904')]['action'],'keep')

    def test_named_news_survives_broad_news_limit(self):
        news=[{'title':f'시장 동향 {i}','date':'2026.09.04','link':f'https://example.com/{i}'} for i in range(12)]
        news.append({'title':'삼성전자 공급 계약','date':'2026.09.03','link':'https://example.com/contract'})
        target=llm._target_from_event('005930','삼성전자',{'date':'20260904','news':news})
        self.assertEqual(target['news'][0]['i'],12)
        self.assertEqual(llm.headline_fallback(target)['evidence'],[12])

    def test_malformed_evidence_fails_closed(self):
        for evidence in (1, '1', {'index':1}):
            self.assertEqual(llm._validate({'action':'replace','reason':'신규 계약','evidence':evidence},self.target())['action'],'no_evidence')

    def test_news_api_filters_before_limit(self):
        def row(title,day):
            return f'<td class="title"><a href="/a">{title}</a><td class="info">news</td><td class="date">{day}</td>'
        html=row('삼성전자 오래된 계약','2026.07.01')+row('삼성전자 현재 계약','2026.09.04')+row('삼성전자 미래 계약','2026.09.05')
        self.assertEqual([n['title'] for n in api._parse_news(html,'삼성전자',date(2026,9,4))],['삼성전자 현재 계약'])

    def test_no_api_uses_attributed_headline_not_causal_inference(self):
        target=self.target()
        with patch.object(llm,'_call_batch',side_effect=AssertionError('No paid call allowed')):
            verdicts,stats=llm.refine([target],'')
        v=verdicts[('005930','20260904')]
        self.assertEqual(v['source'],'news_headline')
        self.assertTrue(v['reason'].startswith('관련 보도: '))
        self.assertEqual(stats['sent'],0)

    def test_api_error_uses_fallback_and_reports_failure(self):
        with patch.object(llm,'_call_batch',side_effect=RuntimeError('credit exhausted')):
            verdicts,stats=llm.refine([self.target()],'test')
        self.assertEqual(stats['batch_errors'],1)
        self.assertEqual(verdicts[('005930','20260904')]['source'],'news_headline')

    def test_api_source_failure_is_not_successful_empty_news(self):
        handler=object.__new__(api.handler);handler.path='/?ticker=005930&date=20260904'
        result=[];handler._respond=lambda *args,**kwargs:result.append((args,kwargs))
        with patch.object(api,'_fetch_retry',return_value=None): handler.do_GET()
        self.assertEqual(result[0][0][0],502)

    def test_api_rejects_invalid_date_before_network(self):
        handler=object.__new__(api.handler);handler.path='/?ticker=005930&date=2026094'
        result=[];handler._respond=lambda *args,**kwargs:result.append(args)
        with patch.object(api,'_fetch_retry',side_effect=AssertionError('network')): handler.do_GET()
        self.assertEqual(result[0][0],400)

    # ── 2026-10: 상류 뉴스 단절 후 '거래량 증가' 일색 복구 ──
    def test_volume_label_is_generic_and_replaceable(self):
        self.assertTrue(llm.is_generic('거래량 증가'))
        t=llm._target_from_event('008970','KBI동양철관',{'date':'20260930','rise_reason':'거래량 증가','reason_source':'stockrise',
            'theme_tag':'강관업체(Steel pipe)','sector':'철강','news':[
                {'title':"[특징주] '韓 LNG 대미투자' 전망에 철강주 등 강세(종합)",'date':'2026-09-30','link':'https://n.news.naver.com/a'}]})
        self.assertFalse(t['verify_only'])
        v=llm.headline_fallback(t)
        self.assertEqual((v['action'],v['confidence']),('replace','low'))
        self.assertTrue(v['reason'].startswith('관련 보도: '))

    def test_theme_headline_requires_group_move_wording(self):
        t=llm._target_from_event('008970','KBI동양철관',{'date':'20260930','rise_reason':'거래량 증가','theme_tag':'철강 중소형',
            'news':[{'title':'철강 업계 노사 협상 타결','date':'2026-09-30','link':'https://n.news.naver.com/a'}]})
        self.assertEqual(llm.headline_fallback(t)['action'],'no_evidence')

    def test_delisting_trade_is_labelled_even_with_llm(self):
        t=llm._target_from_event('100120','부산주공',{'date':'20260930','rise_reason':'거래량 증가','news':[
            {'title':'부산주공, 정리매매 첫날 91% 급락…주가 40원으로','date':'2026-09-30','link':'https://n.news.naver.com/b'}]})
        with patch.object(llm,'_call_batch',side_effect=AssertionError('must not be sent')):
            verdicts,_=llm.refine([t],'key')
        self.assertEqual(verdicts[('100120','20260930')]['reason'],'정리매매 기간 (상장폐지 절차)')

    def test_html_entities_in_titles_are_decoded(self):
        t=llm._target_from_event('1','A사',{'date':'20260930','news':[{'title':'&quot;A사&quot; 계약','date':'2026-09-30','link':'https://x.com/1'}]})
        self.assertEqual(t['news'][0]['title'],'"A사" 계약')

if __name__=='__main__': unittest.main()
