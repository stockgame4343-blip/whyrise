'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tg = require('./tg_common');
const ROOT = path.resolve(__dirname, '..');
const MAX_NEWS_AGE = 3;
const LIMITS = { threads: 500, instagram: 2200, kakao: 1000, toss: 4000, telegram: 4096 };
const UNKNOWN = '직접 상승 촉매 확인 중';
function ymd(value) { return String(value || '').replace(/\D/g, '').slice(0, 8); }
function utcDay(value) {
    const d = ymd(value);
    if (!/^\d{8}$/.test(d)) return NaN;
    return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
}
function evidence(row, date) {
    const seen = new Set();
    return (row.news || []).filter(n => {
        const age = (utcDay(date) - utcDay(n.date)) / 86400000;
        const title = String(n.title || '').trim();
        if (!title || !row.name || !title.includes(row.name) || seen.has(title) || !(age >= 0 && age <= MAX_NEWS_AGE)) return false;
        if (!/^https:\/\//.test(n.link || '')) return false;
        seen.add(title); return true;
    }).slice(0, 3);
}
function supportedReason(row, date) {
    const news = evidence(row, date);
    const reason = tg.specificReason(row.rise_reason);
    const editorial = row.reason_source === 'admin' || row.reason_status === 'edited';
    // Raw keyword matches are not a verified explanation of the day's price move.
    const refined = row.reason_source === 'llm' && row.reason_confidence !== 'low' && (row.reason_evidence || []).length;
    const supported = reason && (editorial || (refined && news.length));
    return { text: supported ? reason : news.length ? '관련 보도: ' + tg.clip(news[0].title, 65) : UNKNOWN, news,
        status: supported ? (editorial ? 'edited' : 'supported') : news.length ? 'related_news' : 'unverified' };
}
function link(channel, date, ticker) {
    const url = new URL(ticker ? '/stock/' + ticker : '/report.html', 'https://orgo.kr');
    url.searchParams.set('date', date);
    url.searchParams.set('utm_source', channel);
    url.searchParams.set('utm_medium', 'social');
    url.searchParams.set('utm_campaign', 'daily_close');
    return url.toString();
}
function buildDigest(day, marketmap, now = new Date()) {
    const date = ymd(day.date);
    if (!/^\d{8}$/.test(date) || !Array.isArray(day.rankings) || day.is_final !== true) throw new Error('Final dated rankings required');
    if (!tg.isKrTradingDay(date)) throw new Error('Not a trading day');
    const rows = new Map();
    for (const r of day.rankings) {
        if (/^[0-9A-Z]{6}$/.test(r.ticker || '') && r.name && Number.isFinite(r.change_rate) && r.change_rate >= 10) rows.set(r.ticker, {...r});
    }
    const sameSnapshot = marketmap && ymd(marketmap.date) === date && Array.isArray(marketmap.items);
    if (sameSnapshot) for (const r of marketmap.items) {
        if (!/^[0-9A-Z]{6}$/.test(r.ticker || '') || !r.name || !Number.isFinite(r.change_rate) || r.change_rate < 10) continue;
        if (!rows.has(r.ticker)) rows.set(r.ticker, {...r, news: [], rise_reason: '', reason_source: 'missing'});
    }
    const all = [...rows.values()].sort((a,b) => b.change_rate - a.change_rate || a.ticker.localeCompare(b.ticker));
    if (!all.length) throw new Error('No usable movers; do not publish an empty market report');
    const movers = all.map(r => ({ticker:r.ticker, name:r.name, rate:r.change_rate, sector:r.sector || '', ...supportedReason(r,date)}));
    const top = movers.slice(0, 3);
    const covered = movers.filter(r => r.status === 'supported' || r.status === 'edited').length;
    const reported = movers.filter(r => r.status === 'related_news').length;
    const overview = `ORGO 수집 종목 중 +15% 이상 ${all.filter(r=>r.change_rate>=15).length}개 · +10% 이상 ${all.length}개`;
    const head = `${date.slice(4,6)}/${date.slice(6,8)} 장 마감 | ORGO`;
    const lines = top.map(r=>`${r.name} ${tg.pct(r.rate)}\n${r.text}`);
    const base = [head, overview, '', ...lines, '', '공개자료 기반 시장 기록 · 투자 권유 아님'];
    const threads = [head, overview, '', ...top.slice(0,2).map(r=>`${r.name} ${tg.pct(r.rate)} · ${tg.clip(r.text,40)}`), '', '종목별 뉴스와 흐름은 ORGO에서 확인할 수 있어요.', link('threads',date)].join('\n');
    const lead = top.find(r=>r.news.length) || top[0];
    const toss = [`${lead.name} ${date.slice(4,6)}/${date.slice(6,8)} 마감 기록`, '', `등락률: ${tg.pct(lead.rate)}`, `상승 촉매: ${lead.text}`, '',
        '관련 공개자료 (동시 발생이 인과관계를 확정하지는 않습니다)', ...lead.news.map(n=>`${n.date} ${n.source || ''}\n${n.title}\n${n.link}`), '',
        '추가 확인할 점: 공시 원문, 기사 발표 시점과 가격 반응, 업종 동반 움직임.', 'ORGO 운영자가 공개자료를 정리했습니다. 종목 추천이나 매매 제안이 아닙니다.'].join('\n');
    const texts = {threads, instagram:base.concat(['', '원문과 전체 종목은 프로필의 orgo.kr', '#ORGO #국내주식 #오늘의시황']).join('\n'),
        kakao:base.concat(['',link('kakao',date)]).join('\n'), toss,
        telegram:base.concat(['',`이유 확인 ${covered}/${all.length}종목 · 미확인 ${all.length-covered}종목`,link('telegram',date)]).join('\n')};
    for (const [channel, text] of Object.entries(texts)) if (Array.from(text).length > LIMITS[channel]) throw new Error(`${channel} text exceeds limit`);
    const digest = {version:1, date, generated_at:now.toISOString(), is_final:true, scope:'ORGO 수집 종목 기준 (전체 시장 전수 통계 아님)',
        coverage:{total:all.length, supported:covered, related_news:reported, unresolved:all.length-covered-reported, snapshot_merged:!!sameSnapshot, supplemented:all.filter(r=>r.reason_source==='missing').length},
        overview, movers, posts:Object.fromEntries(Object.entries(texts).map(([channel,text])=>[channel,{text, status:'prepared', ...(channel==='toss'?{ticker:lead.ticker}:{})}]))};
    digest.content_hash=crypto.createHash('sha256').update(JSON.stringify({date, movers,texts})).digest('hex');
    return digest;
}
function cardHtml(digest) {
    const e=tg.escHtml;
    return `<!doctype html><html lang="ko"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#10151b;color:#f2f5f7;font-family:'Malgun Gothic','Noto Sans CJK KR',sans-serif}#card{width:1080px;height:1350px;padding:72px;display:flex;flex-direction:column}header{color:#9aefcd;font-weight:800;font-size:36px;letter-spacing:4px}h1{font-size:66px;line-height:1.2;margin:54px 0 22px}.date{color:#a6b4c0;font-size:28px}.overview{font-size:29px;line-height:1.6;margin:34px 0}.row{padding:30px 0;border-top:1px solid #34404a}.name{display:flex;justify-content:space-between;gap:20px;font-size:38px;font-weight:700}.rate{color:#ff9294;white-space:nowrap}.reason{font-size:27px;color:#a6b4c0;margin-top:16px;line-height:1.5}footer{margin-top:auto;font-size:23px;color:#a6b4c0;line-height:1.6}</style><div id="card"><header>ORGO / MARKET DAILY</header><h1>오늘 오른 종목,<br>무슨 일이 있었을까?</h1><div class="date">${e(digest.date)} · 장 마감 기준</div><div class="overview">${e(digest.overview)}</div>${digest.movers.slice(0,3).map(r=>`<div class="row"><div class="name"><span>${e(r.name)}</span><span class="rate">${e(tg.pct(r.rate))}</span></div><div class="reason">${e(r.text)}</div></div>`).join('')}<footer>공개자료 기반 시장 기록 · 투자 권유 아님<br>종목별 뉴스와 시장 흐름 → orgo.kr</footer></div></html>`;
}
function generate(date) {
    if (!/^\d{8}$/.test(date)) throw new Error('Expected YYYYMMDD');
    const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
    const day=read(path.join(ROOT,'public/data/rise-history',date+'.json'));
    let snapshot=null;
    try { snapshot=read(path.join(ROOT,'public/data/marketmap',date+'.json')); } catch(e) { /* coverage labels disclose missing snapshot */ }
    const digest=buildDigest(day,snapshot);
    const dir=path.join(ROOT,'public/marketing',date); fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'digest.json'),JSON.stringify(digest,null,2)+'\n');
    fs.writeFileSync(path.join(dir,'card.html'),cardHtml(digest));
    for(const [channel,post] of Object.entries(digest.posts)) fs.writeFileSync(path.join(dir,channel+'.txt'),post.text+'\n');
    const latestPath=path.join(ROOT,'public/marketing/latest.json');
    let latest=null;try{latest=read(latestPath);}catch(e){}
    if(latest && latest.date > date) return digest;
    fs.writeFileSync(latestPath,JSON.stringify({date,path:`/marketing/${date}/digest.json`})+'\n');
    const statusPath=path.join(ROOT,'public/marketing/status.json');
    let status=null;try{status=read(statusPath);}catch(e){}
    if(!status||status.date!==date) fs.writeFileSync(statusPath,JSON.stringify({date,channels:{threads:{status:'prepared'},instagram:{status:'prepared'},kakao:{status:'manual_ready'},toss:{status:'manual_ready'}}},null,2)+'\n');
    return digest;
}
if(require.main===module) { try {const d=generate(process.argv[2]||tg.ymdKst());console.log(JSON.stringify({date:d.date,coverage:d.coverage}));}catch(e){console.error(e.message);process.exitCode=1;} }
module.exports={buildDigest,cardHtml,generate,evidence,supportedReason};
