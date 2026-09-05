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

async function publishChannel(d,channel,env,ledger,api=request) {
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
    if(state.content_hash!==rec.state.content_hash&&rec.state.container_id) throw new Error('Digest changed after container creation; reconcile first');
    try {
        if(!state.container_id) {
            if(channel==='instagram') {
                // Public JPEG must exist before Meta attempts to fetch it.
                const img=`https://orgo.kr/marketing/${d.date}/card.jpg`;
                const r=await fetch(img,{method:'HEAD',signal:AbortSignal.timeout(10000)});
                if(!r.ok||!String(r.headers.get('content-type')).includes('image/jpeg')) return {status:'awaiting_image'};
            }
            state.status='creating';await ledger.save(rec,state);
            const fields=channel==='threads'?{media_type:'TEXT',text:d.posts.threads.text}:{image_url:`https://orgo.kr/marketing/${d.date}/card.jpg`,caption:d.posts.instagram.text};
            const created=await api(`${base}/${user}/${channel==='threads'?'threads':'media'}`,token,'POST',fields);
            if(!created.id) throw new Error('Missing container ID');
            state={...state,container_id:created.id,status:'created'};await ledger.save(rec,state);
        }
        let ready=channel==='threads';
        if(!ready) {
            const result=await api(`${base}/${state.container_id}?fields=status_code`,token);
            ready=result.status_code==='FINISHED';
            if(result.status_code==='ERROR'||result.status_code==='EXPIRED') throw new Error('Media container '+result.status_code);
            if(!ready) return {...state,status:'created'};
        }
        state.status='publishing';await ledger.save(rec,state);
        const result=await api(`${base}/${user}/${channel==='threads'?'threads_publish':'media_publish'}`,token,'POST',{creation_id:state.container_id});
        if(!result.id) throw new Error('Missing published ID');
        state={...state,status:'published',post_id:result.id,published_at:new Date().toISOString()};await ledger.save(rec,state);
        return state;
    } catch(e) {
        const failed={...state,status:'uncertain',requires_action:true,error:e.message};
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
        status.channels[channel]=await publishChannel(d,channel,env,new Ledger(env.GITHUB_REPOSITORY,env.GH_TOKEN));
    }
    fs.writeFileSync(path.join(ROOT,'public/marketing/status.json'),JSON.stringify(status,null,2)+'\n');
    console.log(JSON.stringify(status));
    if(Object.values(status.channels).some(s=>s.requires_action||s.status.startsWith('needs_'))) process.exitCode=1;
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={publishChannel,Ledger};
