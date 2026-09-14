import fs from 'node:fs';
import path from 'node:path';
import {slug} from './dateutil.js';
import {getHeatmap,getReport} from './mapranking-api.js';
export const DASHBOARD_BASE='https://dashboard.mapranking.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const emit=(fn,level,message)=>fn?.({level,message,at:new Date().toISOString()});
export function validateReport(report,target,scan){
 if(report?._id!==scan.reportId||report.heatmap!==target.id||report.business!==target.business.id||report.keyword!==target.keyword)throw Error('Report identity does not match the selected client, scan, and keyword.');
 const results=report.data?.data?.results;
 if(!Array.isArray(results)||!results.length)throw Error('The completed report contains no grid points.');
 return results;
}
function pinLabels(report){
 return report.data.data.results
  .map(p=>{
   const rank=Number(p.rank);
   return p.found===false||!Number.isFinite(rank)||rank<1||rank>20?'20+':String(rank);
  })
  .sort();
}
function containsLabels(source,rendered){
 const counts=new Map(source.map(label=>[label,0]));
 for(const label of source)counts.set(label,counts.get(label)+1);
 for(const label of rendered){
  const next=(counts.get(label)||0)-1;
  if(next<0)return false;
  counts.set(label,next);
 }
 return true;
}
export async function runExport({session,targets,outDir,onProgress}){
 const files=[],errors=[],records=[];
 if(process.env.VERCEL==='1'&&!process.env.PLAYWRIGHT_BROWSERS_PATH)process.env.PLAYWRIGHT_BROWSERS_PATH='0';
 const {chromium}=await import('playwright');
 const browser=await chromium.launch(process.env.VERCEL==='1'?{headless:true,args:['--no-sandbox','--disable-setuid-sandbox']}:{headless:true});
 try{
  for(const target of targets){
   for(const pair of target.pairs){
    const relative=`${slug(target.business.name)}__${target.business.id}/${slug(target.keyword)}__${target.id}__${pair.tag}.png`;
    let captured=false;
    for(let attempt=1;attempt<=2&&!captured;attempt++){
     let context;
     try{
      emit(onProgress,'info',`${files.length+1}/${targets.reduce((n,t)=>n+t.pairs.length,0)} · ${target.keyword} · ${pair.tag}${attempt>1?' (retry)':''}`);
      const [config,beforeReport,afterReport]=await Promise.all([getHeatmap(session.token,target.id),getReport(session.token,pair.before.reportId),getReport(session.token,pair.after.reportId)]);
      if(config._id!==target.id||(config.business?._id || (typeof config.business_id==='object'?config.business_id?._id:config.business_id))!==target.business.id)throw Error('Scan configuration belongs to a different profile.');
      validateReport(beforeReport,target,pair.before);validateReport(afterReport,target,pair.after);
      emit(onProgress,'info','Both source reports validated. Opening capture browser.');
      context=await browser.newContext({viewport:{width:2400,height:1500},deviceScaleFactor:1,timezoneId:'UTC'});
      // This is the dashboard's observed React Router location state and auth storage.
      await context.addInitScript(({session,target,pair})=>{
       if(location.origin!=='https://dashboard.mapranking.com')return;
       localStorage.setItem('token_user',session.token);
       if(session.workspaceId)localStorage.setItem('activeWorkspaceId',session.workspaceId);
       if(location.pathname==='/map')history.replaceState({usr:{id:target.id,report_id:pair.after.reportId,business_id:target.placeId,iscompare:false},key:'heatmap-export',idx:0},'');
      },{session:{token:session.token,workspaceId:session.workspaceId},target:{id:target.id,placeId:target.placeId},pair});
      const cache=new Map([[pair.before.reportId,beforeReport],[pair.after.reportId,afterReport]]);
      // Serve already-fetched, unmodified API reports to the native dashboard.
      // This avoids downloading the same large report multiple times per image.
      await context.route('https://dashboardapi.mapranking.com/api/heatmap/report',async route=>{
       try{const id=route.request().postDataJSON().id;if(!cache.has(id))cache.set(id,await getReport(session.token,id));await route.fulfill({json:{success:true,data:cache.get(id)}});}catch{await route.abort();}
      });
      // Restrict the native timeline to the requested completed pair, so its defaults
      // already select the exact two reports. Rank data and scan metadata stay unchanged.
      const captureConfig={...config,history:config.history.filter(s=>s.status==='completed'&&[pair.before.reportId,pair.after.reportId].includes(s.report_id))};
      if(captureConfig.history.length!==2)throw Error('Requested reports are missing from this scan history.');
      await context.route('https://dashboardapi.mapranking.com/api/heatmap/get-heatmap',async route=>{const id=route.request().postDataJSON()?.heatmapId;if(id===target.id)await route.fulfill({json:{success:true,data:captureConfig}});else await route.continue();});
      emit(onProgress,'info','Browser context ready.');
      const page=await context.newPage();page.setDefaultTimeout(90000);
      await page.goto(DASHBOARD_BASE+'/map',{waitUntil:'domcontentloaded'});
      emit(onProgress,'info','Dashboard loaded; waiting for scan history.');
      await page.locator('button.enable').filter({hasText:'Compare Dates'}).waitFor();
      // The dashboard's fixed date header overlaps this button; use its own click handler.
      await page.getByRole('button',{name:'Compare Dates',exact:true}).dispatchEvent('click');
      const modal=page.locator('.MuiModal-root').filter({has:page.locator('.modal-compare-map')});
      await modal.waitFor();
      emit(onProgress,'info','Comparison opened; selecting exact report IDs.');
      for(const [index,scan] of [pair.before,pair.after].entries()){
       const control=modal.locator('[role=combobox]').nth(index);
       await control.locator('..').locator('input').waitFor({state:'attached'});
       await page.waitForFunction(el=>el.getAttribute('aria-disabled')!=='true',await control.elementHandle(),{timeout:90000});
       const input=control.locator('..').locator('input');
       if(await input.inputValue()!==scan.reportId){
        await control.dispatchEvent('mousedown',{button:0});
        const option=page.locator(`[role=option][data-value="${scan.reportId}"]`);
        await option.waitFor();await option.dispatchEvent('click');
       }
       await page.waitForFunction(({index,id})=>document.querySelectorAll('.modal-compare-map .MuiSelect-nativeInput')[index]?.value===id,{index,id:scan.reportId});
      }
      await page.addStyleTag({content:'.MuiModal-root:has(.modal-compare-map) > .MuiBox-root{width:2300px!important;max-width:96vw!important;max-height:96vh!important;} .modal-compare-map .map-container{height:1100px!important;} .modal-compare-map .get-pdf-container{visibility:hidden;}'});
      emit(onProgress,'info','Dates selected; verifying both rendered grids.');
      const maps=modal.locator('.compare-map-section > .map-container');
      await page.waitForFunction(()=>document.querySelectorAll('.modal-compare-map .compare-map-section > .map-container').length===2);
      // Verify rendered labels against source reports and the dashboard's visible pin counts.
      const expected=[pinLabels(beforeReport),pinLabels(afterReport)];
      const verification=await page.waitForFunction(expected=>{
       const maps=[...document.querySelectorAll('.modal-compare-map .compare-map-section > .map-container')];
       const overlays=[...document.querySelectorAll('.modal-compare-map .overlay-compare')];
       if(maps.length!==2||overlays.length!==2)return false;
       const actual=maps.map(m=>[...m.querySelectorAll('div[aria-hidden="true"]')].filter(e=>e.style.fontWeight==='bold'&&/^\d+\+?$/.test(e.textContent)).map(e=>e.textContent).sort());
       const counts=overlays.map(o=>Number((o.textContent.match(/(\d+)\s+pins/i)||[])[1]));
       const valid=actual.every((labels,i)=>{
        const pool=new Map(expected[i].map(label=>[label,0]));
        for(const label of expected[i])pool.set(label,pool.get(label)+1);
        return Number.isFinite(counts[i])&&labels.length===counts[i]&&labels.every(label=>{
         const next=(pool.get(label)||0)-1;
         if(next<0)return false;
         pool.set(label,next);
         return true;
        });
       });
       return valid?{actual,counts}:false;
      },expected,{timeout:45000}).then(handle=>handle.jsonValue()).catch(async e=>{
        const actual=await maps.evaluateAll(ms=>ms.map(m=>[...m.querySelectorAll('div[aria-hidden="true"]')].filter(e=>e.style.fontWeight==='bold'&&/^\d+\+?$/.test(e.textContent)).map(e=>e.textContent).sort()));
        const counts=await modal.locator('.overlay-compare').evaluateAll(os=>os.map(o=>Number((o.textContent.match(/(\d+)\s+pins/i)||[])[1])).filter(Number.isFinite)).catch(()=>[]);
        const debug=path.join(outDir,'_debug');fs.mkdirSync(debug,{recursive:true});
        fs.writeFileSync(path.join(debug,'pin-diagnostic.json'),JSON.stringify({expectedCounts:expected.map(x=>x.length),visibleCounts:counts,actualCounts:actual.map(x=>x.length),actual,disabled:[beforeReport.disabledPins,afterReport.disabledPins],sample:beforeReport.data.data.results.slice(0,2).map(({rank,found,index,lat,lng})=>({rank,found,index,lat,lng}))},null,2));
        fs.writeFileSync(path.join(debug,'comparison.html'),await modal.innerHTML());
        await page.screenshot({path:path.join(debug,'pin-diagnostic.png'),timeout:10000}).catch(()=>{});
        throw Error(`Rendered pin verification failed: expected visible ${counts}, found ${actual.map(x=>x.length)}.`);
      });
      if(!verification.actual.every((labels,i)=>containsLabels(expected[i],labels)))throw Error('Rendered rank labels are not present in the selected source reports.');
      emit(onProgress,'info','Both grids match the source report pin values.');
      for(const map of await maps.all()){
       const box=await map.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-400);
      }
      await sleep(1500);
      await page.waitForFunction(()=>[...document.querySelectorAll('.modal-compare-map .map-container')].every(m=>{
       const imgs=[...m.querySelectorAll('img')].filter(i=>i.width>=128&&i.height>=128);
       return imgs.length>0&&imgs.every(i=>i.complete&&i.naturalWidth>0);
      }),null,{timeout:60000});
      const selections=await modal.locator('.MuiSelect-nativeInput').evaluateAll(es=>es.map(e=>e.value));
      if(selections[0]!==pair.before.reportId||selections[1]!==pair.after.reportId)throw Error('Selected report IDs changed before capture.');
      const title=await modal.locator('.map-info').innerText();
      if(title.trim()!==`Keyword: ${target.keyword}`)throw Error('The visible keyword does not match the export target.');
      const file=path.join(outDir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
      await modal.locator(':scope > .MuiBox-root').screenshot({path:file,timeout:60000,animations:'disabled'});
      files.push(relative);records.push({file:relative,profileId:target.business.id,profile:target.business.name,keyword:target.keyword,scanId:target.id,before:pair.before,after:pair.after,verifiedReportIds:selections,verifiedPinCounts:verification.counts});captured=true;
      emit(onProgress,'success',`Saved ${target.keyword} — ${pair.before.monthLabel} → ${pair.after.monthLabel}`);
     }catch(e){
      emit(onProgress,attempt===1?'warn':'error',`${target.keyword}: ${e.message.split('\n')[0]}`);
      if(attempt===2){errors.push({profileId:target.business.id,keyword:target.keyword,scanId:target.id,tag:pair.tag,error:e.message.split('\n')[0]});
       const page=context?.pages()[0];if(page){const debug=path.join(outDir,'_debug');fs.mkdirSync(debug,{recursive:true});await page.screenshot({path:path.join(debug,target.id+'.png'),timeout:5000}).catch(()=>{});}
      }
     }finally{await context?.close().catch(()=>{});}
    }
   }
  }
 }finally{await browser.close();}
 return {files,errors,records};
}


