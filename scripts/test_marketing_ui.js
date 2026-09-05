'use strict';
const assert=require('node:assert/strict');
const path=require('path');
const fs=require('fs');
const tg=require('./tg_common');
async function main(){
    const server=await tg.servePublic(path.resolve(__dirname,'../public'));
    const browser=await require('playwright').chromium.launch({headless:true});
    const out=process.argv[2];if(out)fs.mkdirSync(out,{recursive:true});
    try{
        const page=await browser.newPage({viewport:{width:1380,height:1000}});
        const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/marketing.html`);
        await page.locator('#studio[aria-busy="false"]').waitFor();
        for(const story of await page.locator('.story').all()){
            await story.click();
            const downloads=await page.locator('#downloads a').all();assert.ok(downloads.length>=1&&downloads.length<=2);
            for(const a of downloads){const response=await page.request.get(new URL(await a.getAttribute('href'),page.url()).href);assert.ok(response.ok());assert.equal((await response.body()).subarray(0,2).toString('hex'),'ffd8');}
            for(const channel of await page.locator('.channel').all()){
                await channel.click();assert.equal(await page.locator('#caption').textContent(),await page.locator('#copyText').inputValue());
                assert.ok((await page.locator('#caption').textContent()).length<180);
            }
            if(await page.locator('[aria-label="다음 이미지"]').count()){
                await page.locator('[aria-label="다음 이미지"]').click();assert.match(await page.locator('#imageCount').textContent(),/^2/);
            }
        }
        await page.locator('.story').first().click();await page.locator('[data-channel="threads"]').click();
        await page.locator('#copyText').fill('가'.repeat(501));assert.ok(await page.locator('#copy').isDisabled());
        await page.locator('#reset').click();assert.ok(await page.locator('#copy').isEnabled());
        await page.waitForFunction(()=>Array.from(document.querySelectorAll('#images img')).every(img=>img.complete&&img.naturalWidth>0));
        if(out)await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
        if(await page.locator('[data-story="calendar"]').count())await page.locator('[data-story="calendar"]').click();
        await page.waitForFunction(()=>document.querySelector('#images img').complete&&document.querySelector('#images img').naturalWidth>0);
        if(out)await page.screenshot({path:path.join(out,'mobile-calendar.png'),fullPage:true});
        if(await page.locator('[data-story="market"]').count())await page.locator('[data-story="market"]').click();
        await page.waitForFunction(()=>document.querySelector('#images img').complete&&document.querySelector('#images img').naturalWidth>0);
        if(out)await page.screenshot({path:path.join(out,'mobile-market.png'),fullPage:true});
        assert.deepEqual(errors,[]);console.log('Marketing UI: topics, 5 channels, downloads, editing, image navigation and mobile overflow passed');
    }finally{await browser.close();server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
