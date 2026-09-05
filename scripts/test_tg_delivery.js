'use strict';
const assert=require('node:assert/strict');
const {Ledger}=require('./delivery_ledger');
const {test}=require('node:test');
test('telegram receipt survives a process restart and ambiguity blocks resending',async()=>{
    const originalFetch=global.fetch,load=Ledger.prototype.load,save=Ledger.prototype.save;
    const keys=['TG_DELIVERY_TOKEN','GITHUB_REPOSITORY','GITHUB_WORKFLOW','GITHUB_REF_NAME'];
    const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    Object.assign(process.env,{TG_DELIVERY_TOKEN:'test',GITHUB_REPOSITORY:'test/repo',GITHUB_WORKFLOW:'test',GITHUB_REF_NAME:'master'});
    let state={},calls=0;
    Ledger.prototype.load=async()=>({state});
    Ledger.prototype.save=async(rec,value)=>{state={...value};rec.state=state;};
    const restart=()=>{delete require.cache[require.resolve('./tg_common')];return require('./tg_common');};
    try {
        global.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:42}})};};
        await restart().sendMessage('token','channel','first');
        assert.equal(state.status,'published');
        const replay=await restart().sendMessage('token','channel','AI wording changed');
        assert.equal(replay.result.message_id,42);assert.equal(calls,1);
        state={};global.fetch=async()=>{calls++;throw Error('network timeout');};
        await assert.rejects(restart().sendMessage('token','channel','new'),/uncertain/);
        assert.equal(state.status,'uncertain');const before=calls;
        await assert.rejects(restart().sendMessage('token','channel','new'),/reconciliation/);
        assert.equal(calls,before);
        state={};global.fetch=async()=>{calls++;return {ok:false,status:429,json:async()=>({ok:false,error_code:429})};};
        await assert.rejects(restart().sendMessage('token','channel','limited'),/429/);
        assert.equal(state.status,'retryable');
        global.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:43}})};};
        await restart().sendMessage('token','channel','limited');
        assert.equal(state.status,'published');
        const afterRetry=calls;
        state={};Ledger.prototype.save=async()=>{throw Error('ledger unavailable');};
        await assert.rejects(restart().sendMessage('token','channel','new'),/ledger unavailable/);
        assert.equal(calls,afterRetry);
    }finally{
        global.fetch=originalFetch;Ledger.prototype.load=load;Ledger.prototype.save=save;
        for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
    }
});

test('recurring watcher delivers distinct events and replays each receipt after restart',async()=>{
    const originalFetch=global.fetch,load=Ledger.prototype.load,save=Ledger.prototype.save;
    const keys=['TG_DELIVERY_TOKEN','GITHUB_REPOSITORY','GITHUB_WORKFLOW'];
    const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    Object.assign(process.env,{TG_DELIVERY_TOKEN:'test',GITHUB_REPOSITORY:'test/repo',GITHUB_WORKFLOW:'watch'});
    const records=new Map();let calls=0;
    Ledger.prototype.load=async(date,key)=>({key:date+key,state:records.get(date+key)||{}});
    Ledger.prototype.save=async(rec,value)=>{records.set(rec.key,value);rec.state=value;};
    const restart=()=>{delete require.cache[require.resolve('./tg_common')];return require('./tg_common');};
    try {
        global.fetch=async(_url,opts)=>{
            assert.equal(JSON.parse(opts.body).delivery_key,undefined,'Internal event keys must not leak into Telegram payload');
            return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:++calls}})};
        };
        for(const key of ['lunch','cb:8','sidecar:코스피','cb:15','sidecar:코스닥']) {
            const receipt=await restart().sendMessage('token','channel','caption',{delivery_key:key});
            const replay=await restart().sendMessage('token','channel','changed caption',{delivery_key:key});
            assert.deepEqual(replay,receipt);
        }
        assert.equal(calls,5);
        assert.equal(records.size,5);
    }finally{
        global.fetch=originalFetch;Ledger.prototype.load=load;Ledger.prototype.save=save;
        for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
    }
});

test('Telegram reasons reject mismatched dates, unsupported causes, and stale or unrelated evidence',()=>{
    const tg=require('./tg_common');
    const news={title:'테스트전자 공급계약 체결',date:'2026-09-04',link:'https://example.com/news'};
    const row={ticker:'000001',name:'테스트전자',rise_reason:'대규모 공급계약 체결',reason_source:'llm',reason_confidence:'high',reason_evidence:[news],news:[news]};
    assert.equal(tg.verifiedReason(row,'20260904'),'대규모 공급계약 체결');
    assert.equal(tg.verifiedReason({...row,reason_confidence:'low'},'20260904'),'관련 보도: 테스트전자 공급계약 체결');
    assert.equal(tg.verifiedReason({...row,reason_source:'raw'},'20260904'),'관련 보도: 테스트전자 공급계약 체결');
    assert.equal(tg.verifiedReason({...row,reason_evidence:[],news:[]},'20260904'),'');
    for(const bad of [{...news,date:'20260905'},{...news,date:'20260830'},{...news,title:'다른회사 공급계약 체결'},{...news,link:'javascript:alert(1)'},{...news,date:'20260231'}]) {
        assert.equal(tg.verifiedReason({...row,reason_evidence:[bad],news:[bad]},'20260904'),'');
    }
    assert.deepEqual(tg.refinedReasonsFromDay({date:'20260903',rankings:[row]},'20260904'),{});
    assert.deepEqual(tg.refinedReasonsFromDay({date:'20260904',rankings:[null,row]},'20260904'),{'000001':'대규모 공급계약 체결'});
    assert.deepEqual(tg.refinedReasonsFromDay({date:'invalid',rankings:[row]},'invalid'),{});
});

test('dated flowmap capture rejects wrong-day data before starting a browser',async()=>{
    const tg=require('./tg_common');
    await assert.rejects(tg.captureFlowmaps('.',[],{date:'20260904',day:{date:'20260903',rankings:[]}}),/Matching flowmap snapshot/);
    await assert.rejects(tg.captureFlowmaps('.',[],{date:'20260231',day:{date:'20260231',rankings:[]}}),/Invalid flowmap snapshot date/);
});

test('editorial comparisons count distinct qualifying stocks without future or partial comparisons',()=>{
    const e=require('./tg_editorial');
    const stock=(ticker,rate)=>({ticker,name:'종목'+ticker,change_rate:rate,trading_value:1e10});
    const day={date:'20260904',is_final:true,rankings:[stock('000001',20),stock('000001',20),stock('000002',16),stock('000003',10)]};
    const previous={date:'20260903',is_final:true,rankings:[stock('000001',15),stock('000004',18)]};
    const c=e.comparison(day,previous);
    assert.equal(c.count,2);assert.equal(c.previousCount,2);assert.equal(c.continuing.length,1);assert.equal(c.newCount,1);
    assert.equal(e.comparison(day,{...previous,date:'20260905'}),null);
    assert.equal(e.comparison(day,{...previous,is_final:false}),null);
    assert.equal(e.comparison(day,{...previous,rankings:day.rankings}),null);
    assert.match(e.countLine(day,null),/ORGO 수집 종목/);
    assert.doesNotMatch(e.countLine(day,null),/증가|감소/);
});

test('slot captions answer distinct questions and keep follow-up observations factual',()=>{
    const e=require('./tg_editorial');
    const row={ticker:'000001',name:'검증전자',change_rate:20,trading_value:1e10};
    const day={date:'20260904',is_final:true,rankings:[row]};
    const texts=[e.daily(day.date,{leader:row,theme:null},null,{},day,null),e.intraday(day.date,[{...row,rate:20,vol:1e10}],{}),e.themes(day.date,{themes:[{key:'반도체',count:3,avgRate:18}],sectors:[]}),e.evening(day.date,day,null,{})];
    for(const text of texts){assert.ok(text.length<800);assert.equal((text.match(/<a href/g)||[]).length,1);assert.doesNotMatch(text,/목표가|매수|매도|확실|최초/);}
    assert.match(texts[0],/오늘의 대장/);assert.match(texts[1],/개별 주도주/);assert.match(texts[2],/테마 확산/);assert.match(texts[3],/저녁 복기/);
    assert.match(e.daily(day.date,{leader:null},null,{},day,null),/대장 조건을 충족한 종목이 없어요/);
});

test('calendar commentary includes explicit no-leader days and excludes future records',()=>{
    const e=require('./tg_editorial');
    const cal={'20260901':{stock:{ticker:'000001',name:'가전자'}},'20260902':{stock:null},'20260903':{stock:{ticker:'000001',name:'가전자'}},'20260904':{stock:{ticker:'000002',name:'나전자'}},'20260907':{stock:{ticker:'000002',name:'나전자'}}};
    const text=e.calendarObservation(cal,'20260901','20260903');
    assert.match(text,/3거래일/);assert.match(text,/가전자 대장 2일/);assert.match(text,/대장 없는 날은 1일/);assert.doesNotMatch(text,/나전자/);
    assert.match(e.calendarObservation({'20260902':{stock:null}},'20260901','20260903'),/모두 대장 조건/);
});

test('closing editorial requires final dated rankings and reuses the published calendar leader',()=>{
    const e=require('./tg_editorial'),fs=require('fs');
    const originalRead=fs.readFileSync;
    let day={date:'20260904',is_final:true,rankings:[]};
    fs.readFileSync=file=>String(file).endsWith('leaders-calendar.json') ? JSON.stringify({days:{'20260904':{stock:{ticker:'000001',name:'캘린더대장',rate:40,vol:1e12}}}}) : JSON.stringify(day);
    try {
        assert.equal(e.finalSnapshot('fixture','20260904').is_final,true);
        assert.equal(e.calendarLeaders('fixture','20260904',day).leader.name,'캘린더대장');
        day={...day,is_final:false};assert.throws(()=>e.finalSnapshot('fixture','20260904'),/Final matching/);
        day={...day,is_final:true,date:'20260903'};assert.throws(()=>e.finalSnapshot('fixture','20260904'),/Final matching/);
        assert.throws(()=>e.calendarLeaders('fixture','20260903',day),/calendar entry/);
    }finally{fs.readFileSync=originalRead;}
});
