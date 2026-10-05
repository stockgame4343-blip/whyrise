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
    assert.equal(d.default_story,'close');                                          // 텔레그램 마감과 같은 구성이 기본
    assert.deepEqual(d.stories.find(s=>s.id==='close').assets,['leader','theme-bubble']);
    assert.deepEqual(d.posts.threads.images.map(u=>u.split('/').pop()),['leader.jpg','theme-bubble.jpg']);
    assert.ok(d.stories.some(s=>s.id==='theme')&&d.stories.some(s=>s.id==='calendar'));   // 다른 구성은 그대로 고를 수 있다
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

// ── 쓰레드 링크 댓글 · 네이버 블로그 원고 — 2026-10 ──
const {publishThreadsReply}=require('./marketing_publish');
const Copy=require('./marketing_copy');
function multiLedger(){const store={};return {store,async load(date,ch){const k=date+':'+ch;return {k,state:store[k]||{}};},async save(rec,state){store[rec.k]={...state};rec.state=store[rec.k];}};}
test('threads post keeps the link out of the body and in the first reply',()=>{
    const d=buildDigest(day,null);
    assert.doesNotMatch(d.posts.threads.text,/https?:\/\//);
    assert.match(d.posts.threads.reply,/https:\/\/orgo\.kr\/rise\.html\?date=20260904&utm_source=threads/);   // 사이트 본 화면으로
    assert.doesNotMatch(d.posts.threads.reply,/orgo\.kr\/day\//);
    assert.ok(Array.from(d.posts.threads.text).length<=500);
});
test('threads reply waits for the main post and is never resent',async()=>{
    const d=buildDigest(day,null),l=multiLedger(),calls=[];
    const api=async(url,token,method,fields)=>{calls.push({url,fields});return {id:'r'+calls.length};};
    const env={THREADS_USER_ID:'123',THREADS_ACCESS_TOKEN:'t'};
    assert.equal((await publishThreadsReply(d,env,l,api)).status,'awaiting_post');
    l.store['20260904:threads']={status:'published',post_id:'p1'};
    const r=await publishThreadsReply(d,env,l,api);
    assert.equal(r.status,'published');assert.equal(calls[0].fields.reply_to_id,'p1');assert.equal(calls[0].fields.media_type,'TEXT');
    await publishThreadsReply(d,env,l,api);assert.equal(calls.length,2);
});
test('naver blog draft: SEO title, facts only, link and disclaimer, no advisory words',()=>{
    const d=buildDigest(day,null),b=d.naver_blog;
    assert.match(b.title,/9월 4일/);assert.ok(Array.from(b.title).length<=42);
    assert.match(b.html,/orgo\.kr\/rise\.html\?date=20260904&amp;utm_source=naver_blog/);
    assert.doesNotMatch(b.html,/orgo\.kr\/day\//);
    assert.match(b.html,/투자 권유가 아닙니다/);
    assert.doesNotMatch(b.html.replace(/투자 권유가 아닙니다/g,''),/매수|매도|추천|목표가|급등 예상/);
    assert.ok(b.tags.length>=4&&b.tags.length<=12);assert.ok(b.tags.every(t=>!/\s/.test(t)));   // 태그는 핵심만 12개 이내
    assert.ok(b.tags.includes('9월4일상한가')&&b.tags.includes('9월4일급등주'));
    assert.match(b.html,/장비 공급계약 체결/);   // 근거 있는 이유는 본문에 실린다
});
test('analyst target-price reasons are not repeated on external channels',()=>{
    const r={...row,ticker:'000777',name:'리포트전자',rise_reason:'증권사 목표가 19만원 상향 (iM)',reason_source:'news_extract',reason_kind:'analyst'};
    const m=Copy.material({date:'20260904',rows:[row,r],leader:null,breadth:null,market:null});
    assert.ok(m.unknown.some(it=>it.row.name==='리포트전자'));
    assert.doesNotMatch(Copy.naverBlog(m,[]).html,/목표가/);
});
test('blog intro and section titles vary by date (no identical daily template)',()=>{
    const titles=new Set(['20260901','20260902','20260903','20260904','20260907'].map(dt=>{
        const m=Copy.material({date:dt,rows:[row],leader:null,breadth:null,market:null});return Copy.naverBlog(m,[]).html.split('\n')[0];}));
    assert.ok(titles.size>=2);
});
test('operator blog alert names the post and the 발행실 link (HTML-escaped)',()=>{
    const {adminNote}=require('./marketing_publish');
    const note=adminNote({date:'20261001',naver_blog:{title:'10월 1일 급등주 <정리>'}},{channels:{threads:{status:'prepared'}}});
    assert.match(note,/10\/1 블로그 원고 준비 완료/);
    assert.match(note,/&lt;정리&gt;/);
    assert.match(note,/orgo\.kr\/marketing\.html#blog/);
    assert.match(note,/쓰레드: 계정 연결 전/);
});
test('listing-day leader missing from rows is shown as a new listing, not as a theme member',()=>{
    const rows=[{ticker:'000001',name:'가나',change_rate:30,rise_reason:'신규 수주 공급 계약',reason_source:'news_extract',reason_kind:'catalyst'}];
    const m=Copy.material({date:'20261001',rows,leader:{ticker:'468670',name:'브릴스',rate:59.5,listing_day:true},breadth:null,market:null});
    const t=Copy.threads(m).text;
    assert.doesNotMatch(t,/59\.5/);                 // 신규상장주 등락률은 공모가 기준이 아니어서 싣지 않는다
    assert.match(t,/가나 \+30\.0% — 신규 수주 공급 계약/);
    assert.match(t,/^📌 10월 1일\(목\) 마감 \| /);      // 텔레그램 마감 메시지와 같은 머리·날짜 표기
    assert.match(Copy.blogTitle(m),/^10월 1일 /);          // 블로그 제목은 날짜가 맨 앞
    assert.ok(Array.from(t).length<=500);
    const b=Copy.naverBlog(m,[]);
    assert.match(b.html,/신규상장: 브릴스/);
    assert.match(b.title,/가나 상한가 이유/);
    assert.match(b.text.split('\n\n')[0],/가나는 '신규 수주 공급 계약' 기사와 함께 상한가를 기록했습니다/);   // 제목의 약속에 첫 문단에서 답한다
});
test('weak "관련 보도" reasons are not used as reasons in external copy',()=>{
    const rows=[{ticker:'000002',name:'다라',change_rate:20,rise_reason:'관련 보도: 대표 인터뷰',reason_source:'news_extract',reason_kind:'related'}];
    const m=Copy.material({date:'20261001',rows,leader:null,breadth:null,market:null});
    assert.equal(m.solo.length,0);
    assert.equal(m.unknown.length,1);
    assert.doesNotMatch(Copy.naverBlog(m,[]).text,/관련 보도/);
});
test('블로그 본문 — 꼭지는 이모지(■·점 목록 없음), 문장마다 줄바꿈, 링크는 본 화면 주소가 텍스트에도 남는다',()=>{
    const news=(r)=>({rise_reason:r,reason_source:'news_extract',reason_kind:'catalyst'});
    const rows=[
        {ticker:'000011',name:'가가',change_rate:29.9,close_price:13000,trading_value:9e10,theme_tag:'로봇',...news('휴머노이드 공급 계약')},
        {ticker:'000012',name:'나나',change_rate:18,trading_value:5e10,theme_tag:'로봇'},
        {ticker:'000013',name:'다다',change_rate:16,trading_value:4e10,theme_tag:'로봇'},
        {ticker:'000014',name:'라라',change_rate:22,trading_value:3e10,...news('자사주 소각 결정')},
    ];
    const b=Copy.naverBlog(Copy.material({date:'20261002',rows}),[]);
    for(const t of [b.html,b.text]) {
        assert.doesNotMatch(t,/■|•|<ul|<li/);                       // 붙여넣기 어려운 기호·목록 서식 없음
        assert.doesNotMatch(t,/orgo\.kr\/day\//);                  // 날짜별 정적 페이지로 보내지 않는다
    }
    assert.match(b.html,/<p><b>💡 개별 재료로 오른 종목<\/b><\/p>/);
    assert.match(b.html,/🔺 <b>라라<\/b> \+22\.0% — 자사주 소각 결정/);
    assert.match(b.html,/<p><b>📊 숫자로 본 오늘<\/b><\/p>/);
    assert.match(b.text,/\nhttps:\/\/orgo\.kr\/rise\.html\?date=20261002&utm_source=naver_blog/);   // 텍스트로 붙여도 주소가 남는다
    assert.match(b.text,/\nhttps:\/\/t\.me\/whyorgo/);
    // 한 줄에 문장 하나 — '다.' 뒤에 같은 줄로 이어지는 문장이 없다
    for(const line of b.text.split('\n')) assert.doesNotMatch(line,/다\.\s+\S/, line);
});
test('블로그 이미지 — 텔레그램처럼 대장 카드·테마 버블이 첫 문단 뒤, 트리맵은 오늘의 숫자, 캘린더는 끝',()=>{
    const stock={ticker:'005930',name:'삼성전자',rate:20};
    const d=buildDigest(day,{date:day.date,items:[row]},new Date(),{days:{[day.date]:{stock}}});
    const h=d.naver_blog.html, at=f=>h.indexOf('/'+f);
    for(const f of ['leader.jpg','theme-bubble.jpg','market-tree.jpg','calendar.jpg']) assert.ok(at(f)>0,f);
    assert.ok(at('leader.jpg')<at('theme-bubble.jpg'));
    assert.ok(at('theme-bubble.jpg')<h.indexOf('📊 숫자로 본 오늘'));
    assert.ok(h.indexOf('📊 숫자로 본 오늘')<at('market-tree.jpg')&&at('market-tree.jpg')<at('calendar.jpg'));
    assert.match(h,/📸 9월 4일 오늘의 대장 — 대장주·대장 섹터·대장 테마/);
    assert.match(h,/📸 9월 대장주 캘린더 \(9월 4일까지\)/);
    assert.doesNotMatch(h,/market-bubble/);   // 같은 내용의 시장 버블은 트리맵 하나로
});
