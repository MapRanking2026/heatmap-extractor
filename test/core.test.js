import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePairs,previousMonth} from '../src/compare.js';
import {normalizeConfig,getClientKeywords} from '../src/mapranking-api.js';
import {validateReport} from '../src/exporter.js';
const months=(...keys)=>keys.map(key=>({key,reportId:key}));
test('current comparison requires current calendar month and immediately previous month',()=>{
 assert.equal(resolvePairs(months('2026-07','2026-08'),'current_vs_previous',{now:'2026-09-12'}).length,0);
 assert.equal(resolvePairs(months('2026-07','2026-09'),'current_vs_previous',{now:'2026-09-12'}).length,0);
 assert.equal(resolvePairs(months('2026-08','2026-09'),'current_vs_previous',{now:'2026-09-12'})[0].before.key,'2026-08');
});
test('year rollover',()=>assert.equal(previousMonth('2026-01'),'2025-12'));
test('custom selection never substitutes nearby dates or reverses dates',()=>{
 assert.deepEqual(resolvePairs(months('2026-01','2026-03'),'custom',{beforeKey:'2026-02',afterKey:'2026-03'}),[]);
 assert.deepEqual(resolvePairs(months('2026-01','2026-03'),'custom',{beforeKey:'2026-03',afterKey:'2026-01'}),[]);
});
test('consecutive pairs do not bridge missing months',()=>assert.deepEqual(resolvePairs(months('2026-01','2026-03','2026-04'),'all_consecutive').map(p=>p.tag),['2026-03_vs_2026-04']));
test('actual paused status, latest completed scan, zero-history preservation',()=>{
 const c=normalizeConfig({_id:'scan',paused:false,history:[{report_id:'new',status:'completed',timestamp:'2026-08-20T12:00:00Z'},{report_id:'old',status:'completed',timestamp:'2026-08-01T12:00:00Z'},{report_id:'pending',status:'pending',timestamp:'2026-09-01T12:00:00Z'}]});
 assert.equal(c.status,'active');assert.equal(c.months[0].reportId,'new');assert.equal(c.scanCount,2);
 assert.equal(normalizeConfig({_id:'zero',paused:false}).status,'active');assert.equal(normalizeConfig({_id:'paused',paused:true}).status,'paused');assert.equal(normalizeConfig({_id:'unknown'}).status,'unknown');
});
test('pagination reads all pages and full histories; same-keyword configurations remain distinct',async()=>{
 const original=global.fetch,pages=[],histories=[];
 global.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);
  if(url.endsWith('/get-heatmap')){
   histories.push(body.heatmapId);
   return {ok:true,status:200,json:async()=>({data:{_id:body.heatmapId,business:{_id:'b'},keyword:'same keyword',paused:false,history:[{report_id:body.heatmapId+'-report',status:'completed',timestamp:'2025-01-01T12:00:00Z'}]}})};
  }
  pages.push(body.page);
  return {ok:true,status:200,json:async()=>({data:[{_id:'config'+body.page,business_id:'b',keyword:'same keyword',paused:false,history:[]}],pagination:{totalPages:2,totalItems:2}})};
 };
 try{const result=await getClientKeywords('test','b');assert.equal(result.length,2);assert.deepEqual(pages,[1,2]);assert.equal(histories.length,2);assert.equal(result[0].months[0].key,'2025-01');}finally{global.fetch=original;}
});
test('pagination rejects cross-client data',async()=>{
 const original=global.fetch;global.fetch=async()=>({ok:true,status:200,json:async()=>({data:[{_id:'x',business_id:'other'}],pagination:{totalPages:1,totalItems:1}})});
 try{await assert.rejects(getClientKeywords('test','b'),/another client/);}finally{global.fetch=original;}
});
test('report verification rejects wrong keyword, profile, report and empty grids',()=>{
 const target={id:'scan',business:{id:'client'},keyword:'masonry'},scan={reportId:'report'};
 const report={_id:'report',heatmap:'scan',business:'client',keyword:'masonry',data:{data:{results:[{rank:1}]}}};
 assert.equal(validateReport(report,target,scan).length,1);
 for(const patch of [{_id:'wrong'},{business:'wrong'},{heatmap:'wrong'},{keyword:'wrong'},{data:{data:{results:[]}}}])assert.throws(()=>validateReport({...report,...patch},target,scan));
});
