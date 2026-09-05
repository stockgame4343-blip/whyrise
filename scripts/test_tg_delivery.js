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
