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
async function main(env=process.env) {
    const date=process.argv[2]||tg.ymdKst();
    if(!/^\d{8}$/.test(date)) throw new Error('Expected YYYYMMDD');
    const d=JSON.parse(fs.readFileSync(path.join(ROOT,'public/marketing',date,'digest.json'),'utf8'));
    if(date!==tg.ymdKst()||d.date!==date||d.is_final!==true||!tg.isKrTradingDay(date)) throw new Error('Live publication requires today\'s final trading data');
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
    }
    fs.writeFileSync(path.join(ROOT,'public/marketing/status.json'),JSON.stringify(status,null,2)+'\n');
    console.log(JSON.stringify(status));
    if(Object.values(status.channels).some(s=>s.requires_action||s.status.startsWith('needs_')||['awaiting_image','created'].includes(s.status))) process.exitCode=1;
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={publishChannel,Ledger,checkAssets};
