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
// ── X(트위터) — OAuth 1.0a 사용자 컨텍스트(만료 없는 액세스 토큰)로 이미지 1장 + 문구 게시 ──
// 요금: 2026-02 이후 종량제(일반 게시 ≈$0.015, 링크 포함 ≈$0.20). 하루 1회 링크 게시 ≈ 월 $4~5.
function pct(s) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function oauth1Header(method, url, env, nonce=require('crypto').randomBytes(16).toString('hex'), ts=Math.floor(Date.now()/1000)) {
    const o = {oauth_consumer_key:env.X_API_KEY,oauth_nonce:nonce,oauth_signature_method:'HMAC-SHA1',oauth_timestamp:String(ts),oauth_token:env.X_ACCESS_TOKEN,oauth_version:'1.0'};
    const u = new URL(url);
    const params = [...Object.entries(o), ...u.searchParams.entries()].map(([k,v]) => [pct(k), pct(v)]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1);
    const base = [method.toUpperCase(), pct(u.origin + u.pathname), pct(params.map(([k,v]) => k + '=' + v).join('&'))].join('&');
    const key = pct(env.X_API_SECRET) + '&' + pct(env.X_ACCESS_TOKEN_SECRET);
    o.oauth_signature = require('crypto').createHmac('sha1', key).update(base).digest('base64');
    return 'OAuth ' + Object.entries(o).map(([k,v]) => pct(k) + '="' + pct(v) + '"').join(', ');
}
async function xRequest(url, env, body) {
    let response;
    try {
        response = await fetch(url, {method:'POST', signal:AbortSignal.timeout(30000),
            headers:{Authorization:oauth1Header('POST', url, env), 'Content-Type':'application/json'}, body:JSON.stringify(body)});
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.errors) throw new Error('X HTTP ' + response.status + ' ' + (result.title || result.detail || ''));
        return result;
    } catch (e) { throw new Error(response ? 'X request failed (HTTP ' + response.status + ')' : 'X response uncertain'); }
}
async function publishX(d, env, ledger, api=xRequest, assetsReady=checkAssets, fetchImage=async url => Buffer.from(await (await fetch(url, {signal:AbortSignal.timeout(20000)})).arrayBuffer())) {
    if (!env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_TOKEN_SECRET) return {status:'needs_connection'};
    const post = d.posts.x;
    if (!post?.text) return {status:'no_x_text'};
    const rec = await ledger.load(d.date, 'x');
    if (rec.state.status === 'published') return rec.state;
    if (['uploading','publishing','uncertain'].includes(rec.state.status)) return {...rec.state, requires_action:true};
    let state = {...rec.state, date:d.date, channel:'x', content_hash:d.content_hash};
    try {
        if (!state.media_id) {
            const images = await assetsReady(d, 'x');
            if (!images) return {status:'awaiting_image'};
            const bytes = await fetchImage(images[0]);
            state.status = 'uploading'; await ledger.save(rec, state);
            // 업로드는 게시 전 단계 — 실패해도 공개 게시물은 생기지 않는다.
            const up = await api('https://api.x.com/2/media/upload', env, {media:bytes.toString('base64'), media_category:'tweet_image'});
            if (!up?.data?.id) throw new Error('Missing media id');
            state = {...state, media_id:up.data.id, status:'uploaded'}; await ledger.save(rec, state);
        }
        state.status = 'publishing'; await ledger.save(rec, state);
        const res = await api('https://api.x.com/2/tweets', env, {text:post.text, media:{media_ids:[state.media_id]}});
        if (!res?.data?.id) throw new Error('Missing post id');
        state = {...state, status:'published', post_id:res.data.id, published_at:new Date().toISOString()}; await ledger.save(rec, state);
        return state;
    } catch (e) {
        // 게시 호출 결과가 불명확하면 재전송하지 않는다(중복 게시 방지). 업로드 단계 실패는 다음 실행에서 재시도.
        const failed = {...state, status: state.status === 'publishing' ? 'uncertain' : state.status === 'uploading' ? 'retryable' : state.status, error:e.message};
        if (failed.status === 'uncertain') failed.requires_action = true;
        if (failed.status === 'retryable') delete failed.media_id;
        await ledger.save(rec, failed);
        return failed;
    }
}
async function main(env=process.env) {
    const date=process.argv[2]||tg.ymdKst();
    if(!/^\d{8}$/.test(date)) throw new Error('Expected YYYYMMDD');
    const d=JSON.parse(fs.readFileSync(path.join(ROOT,'public/marketing',date,'digest.json'),'utf8'));
    if(date!==tg.ymdKst()||d.date!==date||d.is_final!==true||!tg.isKrTradingDay(date)) throw new Error('Live publication requires today\'s final trading data');
    const enabled=new Set((env.MARKETING_ENABLED_CHANNELS||'').split(',').map(s=>s.trim()));
    const status={date,checked_at:new Date().toISOString(),channels:{}};
    for(const channel of ['threads','instagram','x','kakao','toss']) {
        if(channel==='kakao'||channel==='toss') {status.channels[channel]={status:'manual_ready'};continue;}
        if(!enabled.has(channel)) {status.channels[channel]={status:'prepared'};continue;}
        if(!env.GH_TOKEN) throw new Error('Durable publication requires GH_TOKEN');
        const ledger=new Ledger(env.GITHUB_REPOSITORY,env.GH_TOKEN);
        if(channel==='x') {
            for(let attempt=0;attempt<18;attempt++){
                const result=await publishX(d,env,ledger);status.channels.x=result;
                if(result.status!=='awaiting_image')break;
                if(attempt<17)await new Promise(r=>setTimeout(r,10000));
            }
            continue;
        }
        for(let attempt=0;attempt<18;attempt++){
            const result=await publishChannel(d,channel,env,ledger);status.channels[channel]=result;
            if(result.requires_action||!['awaiting_image','created'].includes(result.status))break;
            if(attempt<17)await new Promise(r=>setTimeout(r,10000));
        }
    }
    fs.writeFileSync(path.join(ROOT,'public/marketing/status.json'),JSON.stringify(status,null,2)+'\n');
    console.log(JSON.stringify(status));
    if(Object.values(status.channels).some(s=>s.requires_action||s.status.startsWith('needs_')||['awaiting_image','created','retryable'].includes(s.status))) process.exitCode=1;
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={publishChannel,publishX,oauth1Header,Ledger,checkAssets};
