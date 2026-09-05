'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {buildDigest}=require('./marketing_digest');
const {publishChannel}=require('./marketing_publish');
const tg=require('./tg_common');
const row={ticker:'005930',name:'삼성전자',theme_tag:'반도체',change_rate:20,rise_reason:'장비 공급계약 체결',reason_source:'llm',reason_confidence:'mid',reason_evidence:[{title:'삼성전자 장비 공급계약'}],news:[{title:'삼성전자 장비 공급계약',date:'2026.09.04',link:'https://example.com/a'}]};
const companions=[{ticker:'111111',name:'동반A',theme_tag:'반도체',change_rate:1},{ticker:'222222',name:'동반B',theme_tag:'반도체',change_rate:2}];
const day={date:'20260904',is_final:true,rankings:[row,...companions]};
test('supplements missing movers and discloses limited universe',()=>{
    const d=buildDigest(day,{date:day.date,items:[{ticker:'000660',name:'SK하이닉스',change_rate:16}]});
    assert.equal(d.coverage.total,2);assert.equal(d.coverage.supplemented,1);assert.equal(d.coverage.supported,1);
    assert.ok(d.scope.includes('ORGO 수집 종목'));
    assert.ok(d.stories.some(s=>s.id==='market'));
    assert.equal(d.posts.threads.images.length,2);
    assert.ok(Array.from(d.posts.threads.text).length<=500);
    assert.ok(d.posts.toss.text.length<180);
    assert.ok(!d.posts.toss.text.includes('투자 권유'));
});
test('rejects partial data, ignores mismatched snapshot and old evidence',()=>{
    assert.throws(()=>buildDigest({...day,is_final:false},null));
    assert.equal(buildDigest(day,{date:'20260903',items:[{ticker:'000660',name:'SK하이닉스',change_rate:16}]}).coverage.total,1);
    assert.equal(buildDigest({...day,rankings:[{...row,news:[{...row.news[0],date:'2026.08.01'}]},...companions]},null).coverage.supported,0);
});
test('deduplicates ticker and never treats raw reason as verified',()=>{
    const d=buildDigest({...day,rankings:[row,{...row,reason_source:'stockrise'},...companions]},null);
    assert.equal(d.coverage.total,1);assert.equal(d.coverage.supported,0);
});
function ledger(initial={}) {return {state:initial,async load(){return {state:this.state};},async save(rec,state){this.state={...state};rec.state=this.state;}};}
const env={THREADS_ACCESS_TOKEN:'test',THREADS_USER_ID:'123'};
const readyAssets=async(d,c)=>d.posts[c].images.map(p=>'https://orgo.kr'+p);
function mockApi(log){return async(url,token,method='GET',fields)=>{log.push({url,method,fields});return method==='GET'?{status:'FINISHED',status_code:'FINISHED'}:{id:String(log.length)};};}
test('successful publish is durable and repeated run never sends again',async()=>{
    const l=ledger(),calls=[],api=mockApi(calls);const d=buildDigest(day,null);
    assert.equal((await publishChannel(d,'threads',env,l,api,readyAssets)).status,'published');
    await publishChannel(d,'threads',env,l,api,readyAssets);assert.equal(calls.length,3);assert.equal(calls[0].fields.media_type,'IMAGE');
});
test('ambiguous response is held and not resent',async()=>{
    const l=ledger();let calls=0;const api=async()=>{calls++;throw Error('timeout');};const d=buildDigest(day,null);
    assert.equal((await publishChannel(d,'threads',env,l,api,readyAssets)).status,'uncertain');
    assert.equal((await publishChannel(d,'threads',env,l,api,readyAssets)).requires_action,true);assert.equal(calls,1);
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

test('calendar captions count only elapsed month and never invent a first-ever event',()=>{
    const stock={ticker:'005930',name:'삼성전자',rate:20};
    const calendar={days:{'20260831':{stock},'20260902':{stock},'20260904':{stock},'20260907':{stock}}};
    const d=buildDigest(day,null,new Date(),calendar);
    assert.ok(d.stories.find(s=>s.id==='calendar').caption.includes('2번째'));
    assert.deepEqual(Object.keys(d.calendar_days),['20260902','20260904']);
    assert.equal(d.default_story,'theme');
    assert.ok(!buildDigest(day,null).assets.some(a=>a.id==='calendar'));
    const none=buildDigest(day,null,new Date(),{days:{[day.date]:{stock:null}}});
    assert.ok(none.stories.find(s=>s.id==='leader').caption.includes('조건을 채운 종목이 없네요'));
});
test('market breadth is scoped, deduplicated and handles ties',()=>{
    const d=buildDigest(day,{date:day.date,items:[row,row,{ticker:'000660',name:'하이닉스',change_rate:-1}]});
    assert.deepEqual(d.breadth,{total:2,up:1,down:1,flat:0});
    assert.ok(d.stories.find(s=>s.id==='market').caption.includes('수가 같네요'));
});
test('carousel creates children then parent, waits for processing and publishes once',async()=>{
    const d=buildDigest(day,{date:day.date,items:[row]});
    for(const channel of ['threads','instagram']){
        const l=ledger(),calls=[],api=mockApi(calls);
        const settings={...env,INSTAGRAM_ACCESS_TOKEN:'test',INSTAGRAM_USER_ID:'123',INSTAGRAM_API_VERSION:'v26.0'};
        assert.equal((await publishChannel(d,channel,settings,l,api,readyAssets)).status,'published');
        const writes=calls.filter(c=>c.method==='POST');
        assert.equal(writes.length,4);assert.equal(writes[0].fields.is_carousel_item,'true');
        assert.equal(writes[2].fields.media_type,'CAROUSEL');assert.equal(writes[2].fields.children,'1,2');
        await publishChannel(d,channel,settings,l,api,readyAssets);assert.equal(calls.length,7);
    }
});
test('pending media resumes existing children without creating duplicates',async()=>{
    const d=buildDigest(day,{date:day.date,items:[row]}),l=ledger(),calls=[];
    let finished=false;
    const api=async(url,token,method='GET',fields)=>{calls.push({url,method,fields});return method==='GET'?{status:finished?'FINISHED':'IN_PROGRESS'}:{id:String(calls.length)};};
    assert.equal((await publishChannel(d,'threads',env,l,api,readyAssets)).status,'created');
    assert.equal(calls.filter(c=>c.method==='POST').length,2);
    finished=true;assert.equal((await publishChannel(d,'threads',env,l,api,readyAssets)).status,'published');
    assert.equal(calls.filter(c=>c.method==='POST').length,4);
});
test('child timeout is held and changed digest cannot reuse containers',async()=>{
    const d=buildDigest(day,{date:day.date,items:[row]}),l=ledger();let writes=0;
    const api=async()=>{if(++writes===2)throw Error('timeout');return {id:'first'};};
    assert.equal((await publishChannel(d,'threads',env,l,api,readyAssets)).status,'uncertain');
    await publishChannel(d,'threads',env,l,api,readyAssets);assert.equal(writes,2);
    const partial=ledger({status:'created',content_hash:'different',children:['first']});
    await assert.rejects(publishChannel(d,'threads',env,partial,api,readyAssets),/Digest changed/);
});
test('no publicly verified images means no platform write',async()=>{
    const l=ledger();const result=await publishChannel(buildDigest(day,null),'threads',env,l,()=>{throw Error('must not call');},async()=>null);
    assert.equal(result.status,'awaiting_image');assert.deepEqual(l.state,{});
});
test('snapshot rendering rejects other dates and strips future calendar and unverified reasons',()=>{
    const {snapshotBundle}=require('./marketing_render');
    const d=buildDigest(day,null,new Date(),{days:{[day.date]:{stock:{ticker:'005930',name:'삼성전자',reason:'추정 이유'}},'20260907':{stock:null}}});
    const b=snapshotBundle(day.date,d,day,null);
    assert.deepEqual(Object.keys(b.calendar.days),[day.date]);assert.equal(b.calendar.days[day.date].stock.reason,'');
    assert.throws(()=>snapshotBundle('20260903',d,day,null));
    assert.throws(()=>snapshotBundle(day.date,d,{...day,rankings:[{...row,change_rate:21},...companions]},null),/input changed/);
    const m=buildDigest(day,{date:day.date,items:[row]});assert.throws(()=>snapshotBundle(day.date,m,day,{date:'20260903',items:[row]}));
});

test('quiet days choose real market visuals or a calendar instead of an empty theme',()=>{
    const quiet={...day,rankings:[]};
    const map={date:day.date,items:[{...row,change_rate:0}]};
    const market=buildDigest(quiet,map);assert.equal(market.default_story,'market');assert.equal(market.coverage.total,0);
    assert.ok(!market.assets.some(a=>a.id==='theme-bubble'));
    const calendar=buildDigest(quiet,null,new Date(),{days:{[day.date]:{stock:null}}});assert.equal(calendar.default_story,'calendar');
    assert.ok(calendar.posts.threads.text.includes('없네요'));
    assert.throws(()=>buildDigest(quiet,{date:day.date,items:[]}));
    const noTheme=buildDigest({...day,rankings:[row]},map);assert.equal(noTheme.default_story,'market');
});

test('public image verification requires matching digest and exact immutable bytes',async()=>{
    const {checkAssets}=require('./marketing_publish'),crypto=require('crypto');
    const d=buildDigest(day,null),bytes=Buffer.from([255,216,255,217]),sha=crypto.createHash('sha256').update(bytes).digest('hex');
    const manifest={date:d.date,content_hash:d.content_hash,assets:{'theme-bubble.jpg':{file:'theme-bubble.'+sha.slice(0,12)+'.jpg',sha256:sha}}};
    const original=global.fetch;let corrupt=false;
    global.fetch=async url=>url.endsWith('assets.json')?{ok:true,json:async()=>manifest}:{ok:true,headers:new Headers({'content-type':'image/jpeg'}),arrayBuffer:async()=>corrupt?Buffer.from('wrong'):bytes};
    try{
        assert.equal((await checkAssets(d,'threads')).length,1);
        corrupt=true;assert.equal(await checkAssets(d,'threads'),null);
        corrupt=false;manifest.content_hash='stale';assert.equal(await checkAssets(d,'threads'),null);
    }finally{global.fetch=original;}
});

test('corrected visual inputs invalidate cached images even when captions and breadth match',()=>{
    const map={date:day.date,items:[{...row,change_rate:2,market_cap:100}]};
    const d=buildDigest(day,map),corrected=buildDigest(day,{...map,items:[{...map.items[0],change_rate:3}]});
    assert.deepEqual(d.breadth,corrected.breadth);assert.deepEqual(d.posts,corrected.posts);
    assert.notEqual(d.input_hash,corrected.input_hash);assert.notEqual(d.content_hash,corrected.content_hash);
    assert.notEqual(d.content_hash,buildDigest({...day,rankings:day.rankings.map(r=>({...r,trading_value:123}))},map).content_hash);
});
