'use strict';
const fs=require('fs');
const path=require('path');
const tg=require('./tg_common');
const ROOT=path.resolve(__dirname,'..');
async function request(url,token,method='GET',data) {
    let response;
    try {
        response=await fetch(url,{method,signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:data?new URLSearchParams(data):undefined});
        const result=await response.json();
        if(!response.ok||result.error) throw new Error('API HTTP '+response.status+' code='+(result.error?.code||''));
        return result;
    } catch(e) { throw new Error(response?'API request failed (HTTP '+response.status+')':'API response uncertain'); }
}
// A durable intent is written before every external mutation. Ambiguous writes are
// held for reconciliation, never automatically resent on a later workflow run.
const {Ledger}=require('./delivery_ledger');

async function checkAssets(d,channel) {
    try {
        const r=await fetch(`https://orgo.kr/marketing/${d.date}/assets.json`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
        if(!r.ok)return null;
        const manifest=await r.json();
        if(manifest.date!==d.date||manifest.content_hash!==d.content_hash)return null;
        const urls=[];
        for(const image of d.posts[channel].images||[]) {
            const name=image.split('/').pop(),asset=manifest.assets[name];
            if(!asset||!/^[a-z-]+\.[a-f0-9]{12}\.jpg$/.test(asset.file||''))return null;
            const url=`https://orgo.kr/marketing/${d.date}/${asset.file}`;
            const img=await fetch(url,{signal:AbortSignal.timeout(10000)});
            if(!img.ok||!String(img.headers.get('content-type')).includes('image/jpeg'))return null;
            const bytes=Buffer.from(await img.arrayBuffer());
            if(require('crypto').createHash('sha256').update(bytes).digest('hex')!==asset.sha256)return null;
            urls.push(url);
        }
        return urls.length>=1&&urls.length<=2?urls:null;
    }catch(e){return null;}
}
async function publishChannel(d,channel,env,ledger,api=request,assetsReady=checkAssets) {
    if(!['threads','instagram'].includes(channel))throw Error('Unsupported automatic channel');
    const token=channel==='threads'?env.THREADS_ACCESS_TOKEN:env.INSTAGRAM_ACCESS_TOKEN;
    const user=channel==='threads'?env.THREADS_USER_ID:env.INSTAGRAM_USER_ID;
    if(!token||!user) return {status:'needs_connection'};
    if(!/^\d+$/.test(user)) throw new Error('Invalid platform user ID');
    const rec=await ledger.load(d.date,channel);
    if(rec.state.status==='published') return rec.state;
    if(['creating','publishing','uncertain'].includes(rec.state.status)) return {...rec.state,requires_action:true};
    const version=env.INSTAGRAM_API_VERSION;
    if(channel==='instagram'&&!/^v\d+\.\d+$/.test(version||'')) return {status:'needs_api_version'};
    const base=channel==='threads'?'https://graph.threads.net/v1.0':`https://graph.instagram.com/${version}`;
    let state={...rec.state,date:d.date,channel,content_hash:d.content_hash};
    if(rec.state.content_hash&&d.content_hash!==rec.state.content_hash&&(rec.state.container_id||rec.state.children?.length))throw Error('Digest changed after media creation; reconcile first');
    if(!state.images){const images=await assetsReady(d,channel);if(!images)return {status:'awaiting_image'};state.images=images;}
    const endpoint=`${base}/${user}/${channel==='threads'?'threads':'media'}`;
    const statusField=channel==='threads'?'status':'status_code';
    async function ready(id) {
        const result=await api(`${base}/${id}?fields=${statusField}`,token);
        if(['ERROR','EXPIRED','PUBLISHED'].includes(result[statusField]))throw Error('Media container '+result[statusField]);
        return result[statusField]==='FINISHED';
    }
    async function create(fields) {
        state.status='creating';await ledger.save(rec,state);
        const result=await api(endpoint,token,'POST',fields);
        if(!result.id)throw Error('Missing container ID');
        return result.id;
    }
    try {
        if(!state.container_id) {
            const caption=channel==='threads'?{text:d.posts[channel].text}:{caption:d.posts[channel].text};
            if(state.images.length>1) {
                state.children=state.children||[];
                for(let i=state.children.length;i<state.images.length;i++) {
                    const id=await create({...(channel==='threads'?{media_type:'IMAGE'}:{}),image_url:state.images[i],is_carousel_item:'true'});
                    state.children.push(id);state.status='created';await ledger.save(rec,state);
                }
                for(const id of state.children)if(!await ready(id))return {...state,status:'created'};
                state.container_id=await create({media_type:'CAROUSEL',children:state.children.join(','),...caption});
            }else state.container_id=await create({...(channel==='threads'?{media_type:'IMAGE'}:{}),image_url:state.images[0],...caption});
            state.status='created';await ledger.save(rec,state);
        }
        if(!await ready(state.container_id))return {...state,status:'created'};
        state.status='publishing';await ledger.save(rec,state);
        const result=await api(`${base}/${user}/${channel==='threads'?'threads_publish':'media_publish'}`,token,'POST',{creation_id:state.container_id});
        if(!result.id) throw new Error('Missing published ID');
        state={...state,status:'published',post_id:result.id,published_at:new Date().toISOString()};await ledger.save(rec,state);
        return state;
    } catch(e) {
        // GET status failures are safe to retry. An unresolved external write is not.
        const failed={...state,status:['creating','publishing'].includes(state.status)?'uncertain':state.status,error:e.message};
        if(failed.status==='uncertain'||e.message.startsWith('Media container'))failed.requires_action=true;
        await ledger.save(rec,failed);
        return failed;
    }
}
// 쓰레드 본문 링크는 도달을 떨어뜨리므로 링크는 '첫 댓글'로 단다. 본문 게시가 확정된 뒤에만.
// 결과가 불명확하면(uncertain) 재전송하지 않는다 — 본문과 같은 중복 방지 원칙.
async function publishThreadsReply(d, env, ledger, api=request) {
    const reply = d.posts?.threads?.reply;
    if (!reply) return {status:'no_reply'};
    const main = await ledger.load(d.date, 'threads');
    if (main.state.status !== 'published' || !main.state.post_id) return {status:'awaiting_post'};
    const rec = await ledger.load(d.date, 'threads-reply');
    if (rec.state.status === 'published') return rec.state;
    if (['creating', 'publishing', 'uncertain'].includes(rec.state.status)) return {...rec.state, requires_action:true};
    const base = 'https://graph.threads.net/v1.0', user = env.THREADS_USER_ID, token = env.THREADS_ACCESS_TOKEN;
    let state = {...rec.state, date:d.date, channel:'threads-reply', reply_to:main.state.post_id};
    try {
        if (!state.container_id) {
            state.status = 'creating'; await ledger.save(rec, state);
            const c = await api(`${base}/${user}/threads`, token, 'POST', {media_type:'TEXT', text:reply, reply_to_id:main.state.post_id});
            if (!c.id) throw Error('Missing container ID');
            state = {...state, container_id:c.id, status:'created'}; await ledger.save(rec, state);
        }
        state.status = 'publishing'; await ledger.save(rec, state);
        const r = await api(`${base}/${user}/threads_publish`, token, 'POST', {creation_id:state.container_id});
        if (!r.id) throw Error('Missing published ID');
        state = {...state, status:'published', post_id:r.id, published_at:new Date().toISOString()}; await ledger.save(rec, state);
        return state;
    } catch (e) {
        const failed = {...state, status:['creating','publishing'].includes(state.status)?'uncertain':state.status, error:e.message};
        if (failed.status === 'uncertain') failed.requires_action = true;
        await ledger.save(rec, failed);
        return failed;
    }
}
function adminNote(d,status) {
    const e=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const blog=d.naver_blog||{};
    const th=status.channels.threads||{};
    const thLabel=th.status==='published'?'게시 완료':th.status==='prepared'?'계정 연결 전':th.status||'-';
    return [`📝 <b>${+d.date.slice(4,6)}/${+d.date.slice(6)} 블로그 원고 준비 완료</b>`,
        blog.title?e(blog.title):'',
        '발행실에서 제목·본문·태그 복사 → 네이버 블로그 글쓰기에 붙여넣기',
        'https://orgo.kr/marketing.html#blog',
        `쓰레드: ${e(thLabel)}`,
        // 휴장일 달력 갱신 알림 — 한국·해외 달력이 30일 안에 끝나면 운영자에게 미리 알린다
        ...tg.holidayCalendarWarnings(d.date).map(w=>'⚠️ '+e(w))].filter(Boolean).join('\n');
}

async function main(env=process.env) {
    const date=process.argv[2]||tg.ymdKst();
    if(!/^\d{8}$/.test(date)) throw new Error('Expected YYYYMMDD');
    const d=JSON.parse(fs.readFileSync(path.join(ROOT,'public/marketing',date,'digest.json'),'utf8'));
    if(date!==tg.ymdKst()||d.date!==date||d.is_final!==true||tg.krPublishBlock(date,false)) throw new Error('Live publication requires today\'s final trading data on a confirmed trading day');
    const enabled=new Set((env.MARKETING_ENABLED_CHANNELS||'').split(',').map(s=>s.trim()));
    const status={date,checked_at:new Date().toISOString(),channels:{}};
    for(const channel of ['threads','instagram','kakao','toss']) {
        if(channel==='kakao'||channel==='toss') {status.channels[channel]={status:'manual_ready'};continue;}
        if(!enabled.has(channel)) {status.channels[channel]={status:'prepared'};continue;}
        if(!env.GH_TOKEN) throw new Error('Durable publication requires GH_TOKEN');
        const ledger=new Ledger(env.GITHUB_REPOSITORY,env.GH_TOKEN);

        for(let attempt=0;attempt<18;attempt++){
            const result=await publishChannel(d,channel,env,ledger);status.channels[channel]=result;
            if(result.requires_action||!['awaiting_image','created'].includes(result.status))break;
            if(attempt<17)await new Promise(r=>setTimeout(r,10000));
        }
        if(channel==='threads'&&status.channels.threads?.status==='published') {
            // Meta 권장: 컨테이너 생성 후 게시 전 잠깐 대기
            await new Promise(r=>setTimeout(r,5000));
            status.channels['threads-reply']=await publishThreadsReply(d,env,ledger);
        }
    }
    // 네이버 블로그는 쓰기 API가 없어(2020 종료) 발행실 원고를 붙여넣는 방식 — 준비 완료를 운영자에게 알린다
    status.channels.naver_blog={status:'manual_ready'};
    if(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_ADMIN_CHAT_ID) {
        try {
            await tg.sendMessage(env.TELEGRAM_BOT_TOKEN,env.TELEGRAM_ADMIN_CHAT_ID,adminNote(d,status),{parse_mode:'HTML'});
            status.channels.naver_blog.notified=true;
        } catch(e) {console.log('운영자 알림 실패(무시): '+e.message);}
    }
    fs.writeFileSync(path.join(ROOT,'public/marketing/status.json'),JSON.stringify(status,null,2)+'\n');
    console.log(JSON.stringify(status));
    if(Object.values(status.channels).some(s=>s.requires_action||s.status.startsWith('needs_')||['awaiting_image','created'].includes(s.status))) process.exitCode=1;
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={publishChannel,publishThreadsReply,Ledger,checkAssets,adminNote};
