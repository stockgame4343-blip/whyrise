'use strict';
const path=require('path');
const {pathToFileURL}=require('url');
async function main(){
    const date=process.argv[2];if(!/^\d{8}$/.test(date||''))throw Error('Expected YYYYMMDD');
    const dir=path.resolve(__dirname,'../public/marketing',date);
    const browser=await require('playwright').chromium.launch({headless:true});
    try{const page=await browser.newPage({viewport:{width:1080,height:1350},deviceScaleFactor:1});
        await page.goto(pathToFileURL(path.join(dir,'card.html')).href);
        await page.evaluate(()=>document.fonts.ready);
        const overflow=await page.locator('#card').evaluate(el=>el.scrollHeight>el.clientHeight);
        if(overflow)throw Error('Card content overflows');
        await page.locator('#card').screenshot({path:path.join(dir,'card.jpg'),type:'jpeg',quality:92});
    }finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
