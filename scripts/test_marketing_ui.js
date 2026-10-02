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
                // 쓰레드는 '왜 올랐나' 3줄 요약(≤500), 나머지 채널은 이미지 중심 짧은 캡션
                const ch=await channel.getAttribute('data-channel');
                assert.ok((await page.locator('#caption').textContent()).length<(ch==='threads'?500:180));
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
        // 네이버 블로그 원고 블록: 제목·태그·미리보기·서식 복사 버튼
        await page.setViewportSize({width:1380,height:1000});
        await page.locator('#blog[aria-busy="false"]').waitFor();
        assert.match(await page.locator('#blogTitle').textContent(),/급등주|상한가/);
        assert.ok((await page.locator('#blogTags').textContent()).includes('#급등주'));
        assert.ok(await page.locator('#blogCopyHtml').isEnabled());
        assert.equal(await page.locator('#blogFrame').getAttribute('src'),'/marketing/'+JSON.parse(fs.readFileSync(path.resolve(__dirname,'../public/marketing/latest.json'),'utf8')).date+'/naver-blog.html');
        // 날짜 이동: 목록 = dates.json, 기본 = 최신, 이전 날짜로 이동하면 그 날짜 원고를 연다
        const idx=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../public/marketing/dates.json'),'utf8')).dates;
        assert.equal(await page.locator('#dateSelect option').count(),idx.length);
        assert.equal(await page.locator('#dateSelect').inputValue(),idx[0]);
        assert.ok(await page.locator('#dateNext').isDisabled());
        if(idx.length>1){
            await page.locator('#datePrev').click();
            await page.waitForURL(new RegExp('date='+idx[1]));
            await page.locator('#studio[aria-busy="false"], #error:not([hidden])').first().waitFor();
            assert.equal(await page.locator('#dateSelect').inputValue(),idx[1]);
            assert.ok(await page.locator('#dateNext').isEnabled());
        }
        assert.deepEqual(errors,[]);console.log('Marketing UI: topics, channels, downloads, editing, image navigation, mobile overflow, blog draft and date navigation passed');
    }finally{await browser.close();server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
