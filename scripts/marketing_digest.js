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
function hasTheme(rows) {
    const counts=new Map(),blocked=new Set(['003060','018700','007460']);
    for(const r of rows) {
        if(!r.ticker||blocked.has(r.ticker)||!(r.change_rate>0))continue;
        const tags=Array.isArray(r.theme_tags)&&r.theme_tags.length?r.theme_tags:r.theme_tag?[r.theme_tag]:[];
        for(const tag of tags)if(tag)counts.set(tag,(counts.get(tag)||0)+1);
    }
    return [...counts.values()].some(n=>n>=3);
}
function buildDigest(day, marketmap, now = new Date(), calendar = null) {
    const date = ymd(day.date);
    if (!/^\d{8}$/.test(date) || !Array.isArray(day.rankings) || day.is_final !== true) throw new Error('Final dated rankings required');
    if (!tg.isKrTradingDay(date)) throw new Error('Not a trading day');
    const rows = new Map();
    for (const r of day.rankings) {
        if (/^[0-9A-Z]{6}$/.test(r.ticker || '') && r.name && Number.isFinite(r.change_rate) && r.change_rate >= 10) rows.set(r.ticker, {...r});
    }
    const sameSnapshot = marketmap && ymd(marketmap.date) === date && Array.isArray(marketmap.items) && marketmap.items.some(r=>/^[0-9A-Z]{6}$/.test(r.ticker||'')&&r.name&&Number.isFinite(r.change_rate));
    if (sameSnapshot) for (const r of marketmap.items) {
        if (!/^[0-9A-Z]{6}$/.test(r.ticker || '') || !r.name || !Number.isFinite(r.change_rate) || r.change_rate < 10) continue;
        if (!rows.has(r.ticker)) rows.set(r.ticker, {...r, news: [], rise_reason: '', reason_source: 'missing'});
    }
    const all = [...rows.values()].sort((a,b) => b.change_rate - a.change_rate || a.ticker.localeCompare(b.ticker));
    const movers = all.map(r => ({ticker:r.ticker, name:r.name, rate:r.change_rate, sector:r.sector || '', ...supportedReason(r,date)}));
    const covered = movers.filter(r => r.status === 'supported' || r.status === 'edited').length;
    const reported = movers.filter(r => r.status === 'related_news').length;
    const calendarDays = Object.fromEntries(Object.entries(calendar?.days || {}).filter(([key]) => /^\d{8}$/.test(key) && key <= date && key.startsWith(date.slice(0,6))));
    const leader = calendarDays[date] || null;
    const monthDays = Object.entries(calendarDays).filter(([key]) => key.startsWith(date.slice(0,6)));
    const base = `/marketing/${date}/`;
    const themeAvailable=hasTheme(day.rankings);
    const assets = themeAvailable?[{id:'theme-bubble',label:'테마 버블맵',file:'theme-bubble.jpg',source:'/flowmap.html',alt:`${date} 급등주 테마별 버블맵`}]:[];
    if(sameSnapshot) assets.push(
        {id:'market-tree',label:'시장 트리맵',file:'market-tree.jpg',source:'/treemap.html',alt:`${date} ORGO 수집 종목 등락률 트리맵`},
        {id:'market-bubble',label:'시장 버블맵',file:'market-bubble.jpg',source:'/bubbles2.html',alt:`${date} ORGO 수집 종목 등락률 버블맵`});
    if(leader) assets.push({id:'calendar',label:'대장 캘린더',file:'calendar.jpg',source:'/sample2.html',alt:`${date.slice(0,6)} 대장주 캘린더 · ${date}까지`},
        {id:'leader',label:'오늘의 대장',file:'leader.jpg',source:'/sample2.html',alt:`${date} 대장주 · 대장 섹터 · 대장 테마`});
    const theme = leader?.theme;
    const themeCaption = theme?.name ? `오늘은 ${theme.name.replace(/\([^)]*\)/g,'').trim()} 쪽이 눈에 들어오네요.\n테마별로 모아봤어요.` : `오늘 급등주를 테마별로 모아봤어요.\n+15% 이상 오른 종목은 ${all.filter(r=>r.change_rate>=15).length}개네요.`;
    const stories = themeAvailable?[{id:'theme',label:'오늘의 테마',note:'어디로 모였을까',caption:themeCaption,assets:['theme-bubble',...(sameSnapshot?['market-tree']:[])],facts:[theme?.name ? `대장 테마: ${theme.name} · 조건 충족 ${theme.count}종목` : `ORGO 집계 +15% 이상 ${all.filter(r=>r.change_rate>=15).length}종목`]}]:[];
    let breadth = null;
    if(sameSnapshot) {
        const items = [...new Map(marketmap.items.filter(r=>/^[0-9A-Z]{6}$/.test(r.ticker||'')&&r.name&&Number.isFinite(r.change_rate)).map(r=>[r.ticker,r])).values()];
        breadth = {total:items.length,up:items.filter(r=>r.change_rate>0).length,down:items.filter(r=>r.change_rate<0).length,flat:items.filter(r=>r.change_rate===0).length};
        const mood = breadth.up>breadth.down ? '빨간 종목이 더 많네요.' : breadth.down>breadth.up ? '파란 종목이 더 많네요.' : '오른 종목과 내린 종목 수가 같네요.';
        stories.push({id:'market',label:'오늘의 온도',note:'시장을 한눈에',caption:`오늘은 ${mood}\nORGO 수집 ${breadth.total}종목 중 상승 ${breadth.up} · 하락 ${breadth.down}.`,assets:['market-bubble','market-tree'],facts:[`상승 ${breadth.up} · 하락 ${breadth.down} · 보합 ${breadth.flat}`,`전체 시장 전수 통계가 아닌 ORGO 수집 ${breadth.total}종목 기준`]});
    }
    if(leader) {
        const stock = leader.stock;
        const repeats = stock ? monthDays.filter(([,v])=>v.stock?.ticker===stock.ticker).length : 0;
        stories.push({id:'calendar',label:'대장 캘린더',note:'하루씩 쌓인 흐름',caption:stock ? (repeats>1 ? `이번 달 ${stock.name}, 벌써 ${repeats}번째 대장이네요.\n캘린더로 보니까 더 잘 보입니다.` : `오늘 대장은 ${stock.name}.\n이번 달 대장들을 달력에 모아봤어요.`) : '오늘은 대장 조건을 채운 종목이 없네요.\n이번 달 흐름은 캘린더에 남겨둡니다.',assets:['calendar'],facts:[`${date.slice(0,4)}년 ${+date.slice(4,6)}월 · ${monthDays.length}거래일 집계`,`${date} 이후 데이터 제외`,...(stock?[`${stock.name} 이번 달 대장 ${repeats}회`]:['해당 거래일 대장주 없음'])]},
            {id:'leader',label:'오늘의 대장',note:'주도주 · 섹터 · 테마',caption:stock ? `오늘 대장은 ${stock.name}이네요.\n섹터와 테마까지 한 장으로 남겨봅니다.` : '오늘은 대장 조건을 채운 종목이 없네요.\n이런 날도 기록해둡니다.',assets:['leader'],facts:[stock?`대장주 ${stock.name} ${tg.pct(stock.rate)}`:'거래대금·상승률 대장 조건 충족 종목 없음']});
    }
    // Friday / month-end: accumulated calendar; otherwise lead with the day's visual flow.
    const weekday = new Date(utcDay(date)).getUTCDay();
    if(!stories.length)throw Error('No exportable dated visuals');
    const defaultStory = leader && ((weekday===5 && monthDays.length>=8) || +date.slice(6)>=28) ? 'calendar' : themeAvailable?'theme':sameSnapshot?'market':'calendar';
    for(const story of stories) {
        story.posts = Object.fromEntries(Object.keys(LIMITS).map(channel=> {
            const text = story.caption + (channel==='instagram'?'\n\n#국내주식 #시황':channel==='kakao'||channel==='telegram'?'\n\norgo.kr':'');
            if(Array.from(text).length>LIMITS[channel]) throw Error(`${channel} text exceeds limit`);
            return [channel,{text,images:story.assets.map(id=>base+assets.find(a=>a.id===id).file),status:'prepared'}];
        }));
    }
    const selected=stories.find(s=>s.id===defaultStory);
    const digest={version:2,date,generated_at:now.toISOString(),is_final:true,scope:'ORGO 수집 종목 기준 (전체 시장 전수 통계 아님)',
        coverage:{total:all.length,supported:covered,related_news:reported,unresolved:all.length-covered-reported,snapshot_merged:!!sameSnapshot,supplemented:all.filter(r=>r.reason_source==='missing').length},
        overview:`+15% 이상 ${all.filter(r=>r.change_rate>=15).length}종목`,movers,breadth,leader,calendar_days:calendarDays,assets,stories,default_story:defaultStory,posts:selected.posts};
    digest.input_hash=crypto.createHash('sha256').update(JSON.stringify({day,marketmap:sameSnapshot?marketmap:null})).digest('hex');
    digest.content_hash=crypto.createHash('sha256').update(JSON.stringify({date,input_hash:digest.input_hash,movers,breadth,leader,calendarDays,stories})).digest('hex');
    return digest;
}
function generate(date) {
    if (!/^\d{8}$/.test(date)) throw new Error('Expected YYYYMMDD');
    const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
    const day=read(path.join(ROOT,'public/data/rise-history',date+'.json'));
    let snapshot=null,calendar=null;
    try { snapshot=read(path.join(ROOT,'public/data/marketmap',date+'.json')); } catch(e) {}
    try { calendar=read(path.join(ROOT,'public/data/leaders-calendar.json')); } catch(e) {}
    const digest=buildDigest(day,snapshot,new Date(),calendar);
    const dir=path.join(ROOT,'public/marketing',date); fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'digest.json'),JSON.stringify(digest,null,2)+'\n');
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
if(require.main===module) { try {const d=generate(process.argv[2]||tg.ymdKst());console.log(JSON.stringify({date:d.date,coverage:d.coverage,default_story:d.default_story}));}catch(e){console.error(e.message);process.exitCode=1;} }
module.exports={buildDigest,generate,evidence,supportedReason,hasTheme};
