'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const tg=require('./tg_common');
const ROOT=path.resolve(__dirname,'..');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function snapshotBundle(date,d,day,map) {
    if(d.date!==date||day.date!==date||day.is_final!==true) throw Error('Final matching chart data required');
    if(d.assets.some(a=>a.id.startsWith('market-'))&&(!map||map.date!==date||!map.items?.length))throw Error('Matching market snapshot required');
    const inputHash=crypto.createHash('sha256').update(JSON.stringify({day,marketmap:d.coverage.snapshot_merged?map:null})).digest('hex');
    if(inputHash!==d.input_hash)throw Error('Chart input changed after digest generation');
    const days=Object.fromEntries(Object.entries(d.calendar_days||{}).filter(([key])=>key<=date).map(([key,value])=>[key,{...value,stock:value.stock?{...value.stock,reason:''}:null}]));
    if(d.assets.some(a=>a.id==='calendar')&&!days[date])throw Error('Calendar day missing');
    return {day,map,calendar:{days,holidays:tg.krHolidayLabels()}};   // 캘린더 이미지에도 휴장일(대체공휴일 포함) 표시
}
function titleCardHtml(c) {
    const e=v=>String(v==null?'':v).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    const main=String(c.main||''),big=Array.from(main).length<=12?120:Array.from(main).length<=18?100:84;
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8">`+
        `<link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">`+
        `<style>*{box-sizing:border-box;margin:0}body{background:#101218}`+
        `#card{width:1080px;height:1080px;padding:110px 88px 96px;display:flex;flex-direction:column;justify-content:space-between;`+
        `background:radial-gradient(circle at 85% 12%,rgba(255,86,102,.22),transparent 46%),#101218;color:#fff;`+
        `font-family:'Pretendard Variable',Pretendard,'Noto Sans KR','Noto Sans CJK KR',sans-serif;letter-spacing:-.02em}`+
        `.logo{font-size:44px;font-weight:900;letter-spacing:-.01em}.logo span{font-size:28px;font-weight:600;color:#8b93a7;margin-left:14px}`+
        `.kicker{display:inline-block;font-size:38px;font-weight:700;color:#ff5666;border:3px solid rgba(255,86,102,.6);border-radius:999px;padding:10px 30px;margin-bottom:40px}`+
        `.main{font-size:${big}px;font-weight:900;line-height:1.16;word-break:keep-all}`+
        `.sub{margin-top:30px;font-size:54px;font-weight:700;color:#c9ced8;word-break:keep-all;line-height:1.25}`+
        `.chips{display:flex;flex-wrap:wrap;gap:18px}.chip{font-size:36px;font-weight:700;background:#1d212b;border:2px solid #2c3240;border-radius:20px;padding:14px 26px;color:#e8ebf1}`+
        `.foot{font-size:30px;color:#8b93a7;margin-top:28px}</style></head><body><div id="card">`+
        `<div><div class="kicker">${e(c.kicker)}</div><div class="main">${e(main)}</div>${c.sub?`<div class="sub">${e(c.sub)}</div>`:''}</div>`+
        `<div><div class="chips">${(c.chips||[]).map(x=>`<span class="chip">${e(x)}</span>`).join('')}</div><div class="foot">오늘 오른 종목과 이유 · orgo.kr</div></div>`+
        `</div></body></html>`;
}
async function jpeg(page,png,out) {
    const data=fs.readFileSync(png).toString('base64');
    const result=await page.evaluate(async data=>{
        const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();
        // Native chart export, scaled to 1440 px; pad only when outside Meta's ratio range.
        const w=1440,rawH=Math.round(img.height*w/img.width),h=Math.max(Math.ceil(w/1.9),Math.min(rawH,1800));
        const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle='#101218';ctx.fillRect(0,0,w,h);
        const scale=Math.min(w/img.width,h/img.height),iw=img.width*scale,ih=img.height*scale;
        ctx.drawImage(img,(w-iw)/2,(h-ih)/2,iw,ih);
        return {url:c.toDataURL('image/jpeg',0.94),width:w,height:h};
    },data);
    fs.writeFileSync(out,Buffer.from(result.url.split(',')[1],'base64'));
    return {width:result.width,height:result.height,sha256:crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')};
}
async function render(date) {
    if(!/^\d{8}$/.test(date||''))throw Error('Expected YYYYMMDD');
    const dir=path.join(ROOT,'public/marketing',date),d=read(path.join(dir,'digest.json'));
    const day=read(path.join(ROOT,'public/data/rise-history',date+'.json'));
    const mp=path.join(ROOT,'public/data/marketmap',date+'.json');
    const bundle=snapshotBundle(date,d,day,fs.existsSync(mp)?read(mp):null);
    const manifestPath=path.join(dir,'assets.json');
    if(fs.existsSync(manifestPath)) {
        const previous=read(manifestPath);
        const valid=previous.content_hash===d.content_hash&&previous.render_version===2&&d.assets.every(a=>{
            const meta=previous.assets[a.file];if(!meta?.file)return false;
            return [a.file,meta.file].every(file=>fs.existsSync(path.join(dir,file))&&crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,file))).digest('hex')===meta.sha256);
        });
        if(valid){console.log('Reusing verified dated visual exports');return;}
    }
    const server=await tg.servePublic(path.join(ROOT,'public'));
    let browser;
    try {
        browser=await require('playwright').chromium.launch({headless:true});
        const context=await browser.newContext({viewport:{width:1100,height:900},deviceScaleFactor:1,acceptDownloads:true,timezoneId:'Asia/Seoul'});
        await context.addInitScript(()=>localStorage.setItem('theme','dark'));
        // Export is isolated from all live, future and remote market data. Only the dated
        // final local snapshot may feed the unchanged ORGO visualization renderers.
        await context.route('**/*',async route=>{
            const u=new URL(route.request().url());
            const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
            if(u.pathname==='/js/api.js') return route.fulfill({contentType:'application/javascript',body:`window.WhyAPI={getDates:async()=>${JSON.stringify([date])},getRankings:async()=>(${JSON.stringify(day)}),getLiveMarketmap:async()=>({map:{},date:'${date}',market_status:'CLOSE'})};`});
            if(u.pathname==='/data/leaders-calendar.json') return json(bundle.calendar);
            if(u.pathname==='/data/marketmap/index.json')return json([date]);
            if(u.pathname==='/api/marketmap'||u.pathname==='/data/marketmap.json'||u.pathname===`/data/marketmap/${date}.json`)return json({...bundle.map,market_status:'CLOSE'});
            if(u.pathname.endsWith('.json')||u.pathname.startsWith('/api/'))return route.fulfill({status:404,body:'Snapshot export: request unavailable'});
            return route.continue();
        });
        const page=await context.newPage();
        page.on('pageerror',e=>console.error('Page error: '+e.message));
        // Next-day midnight keeps exported headers dated, without an invented capture time.
        await page.clock.setFixedTime(new Date(Date.UTC(+date.slice(0,4),+date.slice(4,6)-1,+date.slice(6),15)));
        const manifest={date,render_version:2,content_hash:d.content_hash,assets:{}};
        for(const asset of d.assets) {
            const png=path.join(dir,asset.id+'.png');
            if(asset.id==='title') {
                // 블로그 썸네일 — 제목을 큰 글씨로(검색 결과 대표 이미지)
                await tg.captureHtml(browser,titleCardHtml(d.naver_blog.card||{}),{outPath:png,width:1080,height:1080});
            } else if(asset.id==='leader') {
                const stock=d.leader.stock;
                const html=tg.leaderCardHtml({dateRange:`${date.slice(0,4)}.${date.slice(4,6)}.${date.slice(6)}`,leader:stock?{...stock,tag:stock.theme,reason:''}:null,sector:d.leader.sector,theme:d.leader.theme});
                await tg.captureHtml(browser,html,{outPath:png});
            } else {
                await page.goto(`http://127.0.0.1:${server.address().port}${asset.source}`,{waitUntil:'networkidle',timeout:45000});
                await page.evaluate(()=>document.fonts.ready);
                if(asset.id==='calendar') {
                    await page.waitForFunction(()=>document.querySelectorAll('#calGrid > *').length>20 && document.querySelector('#calLoading').style.display==='none');
                    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#calSave').click()]);
                    await download.saveAs(png);
                } else {
                    await page.waitForFunction(date=>window.WhyRiseTmapBridge?.getCurrentDate()===date,date);
                    if(asset.id==='theme-bubble')await page.evaluate(()=>{WhyRiseTmapBridge.setMode('theme');WhyRiseTmapBridge.setView('bubble');});
                    await page.addStyleTag({content:'#tmapStage{height:650px!important;min-height:650px!important;max-height:650px!important}'});
                    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
                    await page.waitForFunction(()=>{const svg=document.querySelector('#tmapSvg'),vb=svg.viewBox.baseVal;return Math.abs(vb.width-svg.clientWidth)<2&&Math.abs(vb.height-svg.clientHeight)<2;});
                    await tg.saveViaBridge(page,png,{settle:1700});
                    if(await page.evaluate(()=>WhyRiseTmapBridge.getCurrentDate())!==date)throw Error('Chart date changed during export');
                }
            }
            manifest.assets[asset.file]=await jpeg(page,png,path.join(dir,asset.file));
            const meta=manifest.assets[asset.file];meta.file=asset.id+'.'+meta.sha256.slice(0,12)+'.jpg';
            fs.copyFileSync(path.join(dir,asset.file),path.join(dir,meta.file));
            fs.unlinkSync(png);
            console.log(`Rendered ${asset.id}`);
        }
        // Compatibility image for previously shared links, now the native visualization.
        fs.copyFileSync(path.join(dir,d.assets.find(a=>a.id===d.stories.find(s=>s.id===d.default_story).assets[0]).file),path.join(dir,'card.jpg'));
        fs.writeFileSync(path.join(dir,'assets.json'),JSON.stringify(manifest,null,2)+'\n');
        if(fs.existsSync(path.join(dir,'card.html')))fs.unlinkSync(path.join(dir,'card.html'));
    } finally {if(browser)await browser.close();server.close();}
}
if(require.main===module)render(process.argv[2]).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={render,snapshotBundle,titleCardHtml};
