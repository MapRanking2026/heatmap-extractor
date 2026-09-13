import { monthKey, monthLabel, scanLabel } from './dateutil.js';
export const DEFAULT_API_BASE = 'https://dashboardapi.mapranking.com';
export async function request(path, token, body) {
  for (let attempt=0; attempt<3; attempt++) {
    const response = await fetch(DEFAULT_API_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {accept:'application/json', ...(body === undefined ? {} : {'content-type':'application/json'}), ...(token ? {authorization:`Bearer ${token}`} : {})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise(r=>setTimeout(r,1000*(attempt+1))); continue; }
    const payload = await response.json();
    if (!response.ok || payload.success === false) { const e = new Error(`MapRanking ${path} failed (${response.status}): ${payload.message || 'Request rejected'}`); e.status=response.ok?502:response.status; throw e; }
    return payload;
  }
}
export async function login(email, password) {
  const payload = await request('/api/auth/login', null, {type:'email',email,password});
  if (!payload.data?.token) throw new Error('Login returned no token.');
  return {token:payload.data.token, workspaceId:payload.data.activeWorkspaceId || null};
}
export async function getBusinesses(token) {
  const payload=await request('/api/business/get-business',token);
  if(!Array.isArray(payload.data)) throw new Error('Unexpected business response.');
  return payload.data.map(r=>({id:String(r._id),name:String(r.business_name||''),address:String(r.address||r.formatted_address||'')})).filter(b=>b.id&&b.name).sort((a,b)=>a.name.localeCompare(b.name));
}
export async function getHeatmap(token,heatmapId) {
  return (await request('/api/heatmap/get-heatmap',token,{heatmapId})).data;
}
export async function getReport(token,id) {
  return (await request('/api/heatmap/report',token,{id})).data;
}
export function normalizeConfig(c) {
  const seen=new Set();
  const scans=(c.history||[]).filter(s=>s.status==='completed'&&s.report_id&&Number.isFinite(Date.parse(s.timestamp))).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)).filter(s=>{if(seen.has(s.report_id))return false;seen.add(s.report_id);return true;});
  const byMonth=new Map();
  for(const s of scans) byMonth.set(monthKey(s.timestamp),{key:monthKey(s.timestamp),monthLabel:monthLabel(s.timestamp),scanLabel:scanLabel(s.timestamp),timestamp:s.timestamp,reportId:s.report_id,heatmapId:c._id,avgRank:s.score?.avg ?? null});
  return {id:c._id,heatmapId:c._id,placeId:c.place_id,keyword:c.keyword,status:c.paused===true?'paused':c.paused===false?'active':'unknown',frequency:c.refresh_frequency,gridSize:c.grid_multiplier,radius:c.radius,scanCount:scans.length,monthCount:byMonth.size,latestScan:scans.at(-1)?.timestamp||null,months:[...byMonth.values()]};
}
export async function getClientKeywords(token,businessId) {
  const configs=[]; const ids=new Set();
  for(let page=1;;page++) {
    const payload=await request('/api/heatmap/history-paginated',token,{page,limit:20,business_ids:[businessId]});
    if(!Array.isArray(payload.data)||!payload.pagination) throw new Error('Unexpected scan pagination response; export stopped to avoid omissions.');
    for(const c of payload.data) {
      if(c.business_id!==businessId) throw new Error('Dashboard returned a scan for another client.');
      if(ids.has(c._id)) throw new Error('Repeated scan across pages; export stopped to avoid omissions.');
      ids.add(c._id); configs.push(c);
    }
    if(page>=Number(payload.pagination.totalPages)) {
      if(configs.length!==Number(payload.pagination.totalItems)) throw new Error('Scan count changed during loading. Reload the client.');
      break;
    }
    if(!payload.data.length || page>10000) throw new Error('Scan pagination did not complete.');
  }
  // List rows can contain only a tail of history. Fetch every configuration's full history.
  const complete=new Array(configs.length);let next=0;
  await Promise.all(Array.from({length:Math.min(3,configs.length)},async()=>{
    while(next<configs.length){const index=next++;const c=await getHeatmap(token,configs[index]._id);
      const owner=c.business?._id || (typeof c.business_id==='object'?c.business_id?._id:c.business_id);
      if(c._id!==configs[index]._id||owner!==businessId)throw new Error('Full scan history belongs to another client.');
      complete[index]=normalizeConfig(c);
    }
  }));
  return complete.sort((a,b)=>a.keyword.localeCompare(b.keyword)||a.id.localeCompare(b.id));
}

