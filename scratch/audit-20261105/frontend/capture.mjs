import { chromium } from '/home/shijian/projects/sonic/player/node_modules/@playwright/test/index.mjs'
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']})
for (const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]) {
 const page=await browser.newPage({viewport, reducedMotion:'reduce'})
 await page.addInitScript(()=>localStorage.setItem('global',JSON.stringify({lang:'en'})))
 await page.goto('http://127.0.0.1:4175/#/search?q=sonic',{waitUntil:'networkidle'})
 await page.screenshot({path:`/home/shijian/projects/sonic/scratch/audit-20261105/frontend/${name}-search.png`,fullPage:true})
 console.log(name, await page.title(), await page.evaluate(()=>({w:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,body:document.body.innerText.slice(0,120)})))
 await page.close()
}
await browser.close()
