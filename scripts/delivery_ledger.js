'use strict';
class Ledger {
    constructor(repo,token,branch='master') { this.repo=repo;this.token=token;this.branch=branch; }
    async load(date,channel) {
        const p=`.marketing-state/${date}-${channel}.json`;
        const url=`https://api.github.com/repos/${this.repo}/contents/${p}`;
        const r=await fetch(url+'?ref='+encodeURIComponent(this.branch),{headers:{Authorization:'Bearer '+this.token,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
        if(r.status===404) return {url,state:{},sha:null};
        if(!r.ok) throw new Error('Cannot read delivery ledger: '+r.status);
        const j=await r.json();return {url,sha:j.sha,state:JSON.parse(Buffer.from(j.content,'base64').toString('utf8'))};
    }
    async save(record,state) {
        const payload={message:'chore: marketing delivery state',branch:this.branch,content:Buffer.from(JSON.stringify(state)+'\n').toString('base64'),...(record.sha?{sha:record.sha}:{})};
        const r=await fetch(record.url,{method:'PUT',headers:{Authorization:'Bearer '+this.token,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
        if(!r.ok) throw new Error('Cannot persist delivery ledger: '+r.status);
        const j=await r.json();record.sha=j.content.sha;record.state=state;
    }
}
module.exports={Ledger};
