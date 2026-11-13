import { chromium } from '/home/shijian/projects/sonic/player/node_modules/@playwright/test/index.mjs'
import fs from 'node:fs'
import http from 'node:http'
const dir='/home/shijian/projects/sonic/scratch/audit-20261105/frontend'
const base='http://127.0.0.1:4175'
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']})
const results={}
async function make(viewport={width:1440,height:900}) {
 const context=await browser.newContext({viewport,reducedMotion:'reduce'})
 await context.addInitScript(()=>localStorage.setItem('global',JSON.stringify({lang:'en'})))
 return {context,page:await context.newPage()}
}
const track=(title,id=9001)=>({platformId:String(id),title,artist:'Audit fixture',duration:20000,streamUrl:`/api/music/stream?id=${id}`})
{
 const {context,page}=await make()
 let releaseOld, signalOld
 const oldRequested=new Promise(r=>signalOld=r)
 const oldReleased=new Promise(r=>releaseOld=r)
 await page.route('**/api/sonic/recommend/trending?**',async route=>{
  const win=new URL(route.request().url()).searchParams.get('window')
  if(win==='7d'){signalOld();await oldReleased}
  await route.fulfill({json:{data:{tracks:[track(win==='7d'?'STALE SEVEN DAY RESULT':'CURRENT 24H RESULT')],total:1}}})
 })
 await page.goto(`${base}/#/charts`)
 await oldRequested
 const labels=await page.locator('button').allTextContents()
 await page.getByRole('button',{name:'24h',exact:true}).click()
 await page.getByText('CURRENT 24H RESULT',{exact:true}).waitFor()
 releaseOld()
 await page.getByText('STALE SEVEN DAY RESULT',{exact:true}).waitFor()
 results.desktopChartRace={labels,body:await page.locator('body').innerText()}
 await page.screenshot({path:`${dir}/bug-desktop-chart-race.png`})
 await context.close()
}
{
 const {context,page}=await make({width:390,height:844})
 const errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/api/sonic/recommend/trending?**',route=>route.fulfill({json:{data:{tracks:[track('OLD TRENDING RESULT')],total:1}}}))
 await page.route('**/api/top/song?**',route=>route.fulfill({status:503,json:{error:{code:'UPSTREAM_ERROR'}}}))
 await page.goto(`${base}/#/charts`)
 await page.getByText('OLD TRENDING RESULT',{exact:true}).waitFor()
 await page.getByRole('button',{name:'New Songs',exact:true}).click()
 await page.waitForTimeout(1000)
 results.mobileChartFailure={errors,body:await page.locator('body').innerText()}
 await page.screenshot({path:`${dir}/bug-mobile-chart-failure.png`})
 await context.close()
}
{
 const {context,page}=await make()
 await page.goto(`${base}/#/settings`,{waitUntil:'networkidle'})
 results.settingsUnnamedSwitches=await page.locator('button[role="switch"]').evaluateAll(els=>els.map(el=>({text:el.textContent.trim(),ariaLabel:el.getAttribute('aria-label'),labelledby:el.getAttribute('aria-labelledby'),html:el.outerHTML})))
 await page.screenshot({path:`${dir}/settings.png`,fullPage:true})
 await context.close()
}
{
 const attacker=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Audit cross-origin opener</title><script>window.received=[];addEventListener("message",e=>received.push({origin:e.origin,data:e.data}));</script><button id="open" onclick="window.victim=window.open(\'http://127.0.0.1:4175/#/search?q=sonic\',\'sonic\')">Open Sonic</button>')})
 await new Promise(r=>attacker.listen(4176,'127.0.0.1',r))
 const {context,page}=await make()
 await page.goto('http://127.0.0.1:4176')
 const popupPromise=page.waitForEvent('popup')
 await page.locator('#open').click()
 const victim=await popupPromise
 await victim.getByTestId('song-row-9001').click()
 await victim.waitForFunction(()=>document.querySelector('#audioPlayer')?.paused===false)
 await page.evaluate(()=>victim.postMessage({source:'shijianus-music-pocket',action:'PAUSE',timestamp:Date.now()},'http://127.0.0.1:4175'))
 await victim.waitForFunction(()=>document.querySelector('#audioPlayer')?.paused===true)
 results.crossOriginBridge={pausedByUntrustedOpener:true,messages:await page.evaluate(()=>received)}
 await victim.screenshot({path:`${dir}/bug-untrusted-opener-pauses.png`})
 await context.close()
 await new Promise(r=>attacker.close(r))
}
fs.writeFileSync(`${dir}/reproduction-results.json`,JSON.stringify(results,null,2))
await browser.close()
console.log(JSON.stringify(results,null,2))
