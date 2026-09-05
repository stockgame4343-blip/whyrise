'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {buildDigest}=require('./marketing_digest');
const {publishChannel}=require('./marketing_publish');
const tg=require('./tg_common');
const row={ticker:'005930',name:'삼성전자',change_rate:20,rise_reason:'장비 공급계약 체결',reason_source:'llm',reason_confidence:'mid',reason_evidence:[{title:'삼성전자 장비 공급계약'}],news:[{title:'삼성전자 장비 공급계약',date:'2026.09.04',link:'https://example.com/a'}]};
const day={date:'20260904',is_final:true,rankings:[row]};
test('supplements missing movers and discloses limited universe',()=>{
    const d=buildDigest(day,{date:day.date,items:[{ticker:'000660',name:'SK하이닉스',change_rate:16}]});
    assert.equal(d.coverage.total,2);assert.equal(d.coverage.supplemented,1);assert.equal(d.coverage.supported,1);
    assert.ok(d.posts.threads.text.includes('ORGO 수집 종목'));
    assert.ok(Array.from(d.posts.threads.text).length<=500);
    assert.ok(d.posts.toss.text.includes('ORGO 운영자'));
});
test('rejects partial data, ignores mismatched snapshot and old evidence',()=>{
    assert.throws(()=>buildDigest({...day,is_final:false},null));
    assert.equal(buildDigest(day,{date:'20260903',items:[{ticker:'000660',name:'SK하이닉스',change_rate:16}]}).coverage.total,1);
    assert.equal(buildDigest({...day,rankings:[{...row,news:[{...row.news[0],date:'2026.08.01'}]}]},null).coverage.supported,0);
});
test('deduplicates ticker and never treats raw reason as verified',()=>{
    const d=buildDigest({...day,rankings:[row,{...row,reason_source:'stockrise'}]},null);
    assert.equal(d.coverage.total,1);assert.equal(d.coverage.supported,0);
});
function ledger(initial={}) {return {state:initial,async load(){return {state:this.state};},async save(rec,state){this.state={...state};rec.state=this.state;}};}
const env={THREADS_ACCESS_TOKEN:'test',THREADS_USER_ID:'123'};
test('successful publish is durable and repeated run never sends again',async()=>{
    const l=ledger();let calls=0;const api=async()=>({id:String(++calls)});const d=buildDigest(day,null);
    assert.equal((await publishChannel(d,'threads',env,l,api)).status,'published');
    await publishChannel(d,'threads',env,l,api);assert.equal(calls,2);
});
test('ambiguous response is held and not resent',async()=>{
    const l=ledger();let calls=0;const api=async()=>{calls++;throw Error('timeout');};const d=buildDigest(day,null);
    assert.equal((await publishChannel(d,'threads',env,l,api)).status,'uncertain');
    assert.equal((await publishChannel(d,'threads',env,l,api)).requires_action,true);assert.equal(calls,1);
});
test('missing connection does not call platform or ledger',async()=>{
    assert.equal((await publishChannel(buildDigest(day,null),'threads',{},null)).status,'needs_connection');
});
test('telegram retries only explicit rate limit, escapes long HTML and does not expose token',async()=>{
    const original=global.fetch;let calls=0;let body;
    global.fetch=async(_url,opts)=>{body=JSON.parse(opts.body);calls++;return calls===1?{status:429,ok:false,json:async()=>({ok:false,error_code:429,parameters:{retry_after:0.001}})}:{status:200,ok:true,json:async()=>({ok:true,result:{message_id:1}})};};
    try {await tg.sendMessage('secret','123','<a href="https://orgo.kr">'+'가'.repeat(4100)+'</a>',{parse_mode:'HTML'});assert.equal(calls,2);assert.equal(body.parse_mode,undefined);assert.ok(Array.from(body.text).length<=4096);
        global.fetch=async()=>{throw Error('secret');};await assert.rejects(tg.sendMessage('secret','123','hello'),e=>!e.message.includes('secret')&&e.message.includes('uncertain'));
    }finally{global.fetch=original;}
});
