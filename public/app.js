import {resolvePairs} from '/shared/compare.js';
const $=id=>document.getElementById(id);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed.');return data;}
function clearStoredJob(){localStorage.removeItem('heatmapJob');localStorage.removeItem('heatmapJobStartedAt');}
let clients=[],scans=[],loadedIds=[],busy=false,loading=false;const selectedProfiles=new Set(),selectedScans=new Set();
const value=name=>document.querySelector(`input[name=${name}]:checked`).value;
const params=()=>value('mode')==='custom'?{beforeKey:$('beforeMonth').value,afterKey:$('afterMonth').value}:{};
const visible=()=>scans.filter(k=>value('status')==='all'||k.status===value('status'));
function append(e){const el=document.createElement('div');el.className=e.level||'info';el.textContent=e.message;$('log').append(el);$('log').scrollTop=$('log').scrollHeight;}
async function boot(){
 try{const s=await api('/api/session');$('loginCard').classList.toggle('hidden',s.loggedIn);$('app').classList.toggle('hidden',!s.loggedIn);if(!s.loggedIn){$('sessionBox').textContent='Not connected';$('loginError').textContent=s.error||'';return;}
 $('sessionBox').innerHTML=`${escape(s.source)} · ${escape(s.email)} · <button id="logoutBtn" class="link">Sign out</button>`;$('logoutBtn').onclick=async()=>{await api('/api/session/logout',{});location.reload();};
 clients=(await api('/api/clients')).clients;renderProfiles();const job=localStorage.getItem('heatmapJob');if(job)poll(job,{restore:true});
 }catch(e){$('sessionBox').textContent=e.message;}
}
$('loginBtn').onclick=async()=>{try{await api('/api/session/login',{email:$('email').value.trim(),password:$('password').value});$('password').value='';await boot();}catch(e){$('loginError').textContent=e.message;}};
$('mtosBtn').onclick=async()=>{try{await api('/api/session/mtos',{});await boot();}catch(e){$('loginError').textContent=e.message;}};
function renderProfiles(){const q=$('clientSearch').value.toLowerCase();const list=clients.filter(c=>(c.name+' '+c.address).toLowerCase().includes(q));$('clientList').innerHTML=list.map(c=>`<label class="profile-row"><input type="checkbox" value="${escape(c.id)}" ${selectedProfiles.has(c.id)?'checked':''}><span><b>${escape(c.name)}</b><small>${escape(c.address)}</small></span></label>`).join('')||'<p>No matching profiles.</p>';$('clientMeta').textContent=`${selectedProfiles.size} selected · ${list.length} shown`;$('loadKeywordsBtn').disabled=busy||loading||!selectedProfiles.size;}
$('clientSearch').oninput=renderProfiles;
$('clientList').onchange=e=>{if(e.target.type!=='checkbox')return;e.target.checked?selectedProfiles.add(e.target.value):selectedProfiles.delete(e.target.value);scans=[];loadedIds=[];if(!busy)clearStoredJob();$('step2').classList.add('hidden');if(!busy)$('step3').classList.add('hidden');renderProfiles();summary();};
$('loadKeywordsBtn').onclick=async()=>{
 loading=true;scans=[];loadedIds=[];selectedScans.clear();renderProfiles();summary();$('clientMeta').textContent='Loading all tracked scans…';
 try{const ids=[...selectedProfiles];const result=[];for(const id of ids){const b=clients.find(c=>c.id===id);const ks=(await api(`/api/clients/${id}/keywords`)).keywords;result.push(...ks.map(k=>({...k,business:b})));}
 if(ids.join()!==[...selectedProfiles].join())return;
 loadedIds=ids;scans=result;scans.forEach(k=>selectedScans.add(k.id));buildMonths();renderScans();$('step2').classList.remove('hidden');$('step3').classList.remove('hidden');
 }catch(e){$('clientMeta').textContent=e.message;}
 finally{loading=false;$('loadKeywordsBtn').disabled=busy||!selectedProfiles.size;summary();}
};
function buildMonths(){const months=[...new Set(scans.flatMap(k=>k.months.map(m=>m.key)))].sort();for(const id of ['beforeMonth','afterMonth'])$(id).innerHTML=months.map(m=>`<option>${m}</option>`).join('');$('beforeMonth').value=months.at(-2)||'';$('afterMonth').value=months.at(-1)||'';}
function renderScans(){const list=visible();$('kwCount').textContent=`(${list.length})`;$('keywordList').innerHTML=list.map(k=>{const pairs=resolvePairs(k.months,value('mode'),params());return `<label class="kwrow"><input class="kw" type="checkbox" value="${escape(k.id)}" ${selectedScans.has(k.id)?'checked':''}><span class="name">${escape(k.keyword)}<small>${escape(k.business.name)} · ${escape(k.business.address)}<br>${k.gridSize}×${k.gridSize} · ${k.radius} mi · ${pairs.length?pairs.length+' comparison(s)':'Missing requested months — will be listed as skipped'}</small></span><span class="badge ${k.status}">${escape(k.status)}</span></label>`;}).join('')||'<p>No scans match this status.</p>';summary();}
$('keywordList').onchange=e=>{e.target.checked?selectedScans.add(e.target.value):selectedScans.delete(e.target.value);summary();};
$('selectAll').onclick=()=>{visible().forEach(k=>selectedScans.add(k.id));renderScans();};$('selectNone').onclick=()=>{visible().forEach(k=>selectedScans.delete(k.id));renderScans();};
for(const name of ['status','mode'])document.querySelectorAll(`input[name=${name}]`).forEach(el=>el.onchange=()=>{$('customRange').classList.toggle('hidden',value('mode')!=='custom');renderScans();});
$('beforeMonth').onchange=renderScans;$('afterMonth').onchange=renderScans;
function summary(){const list=visible().filter(k=>selectedScans.has(k.id)),count=list.reduce((n,k)=>n+resolvePairs(k.months,value('mode'),params()).length,0),skips=list.filter(k=>!resolvePairs(k.months,value('mode'),params()).length).length;$('exportSummary').textContent=`${count} comparison screenshot(s) across ${loadedIds.length} profile(s). ${skips} selected scan(s) missing the requested months.`;$('exportBtn').disabled=busy||loading||!loadedIds.length||!list.length||!count;}
$('exportBtn').onclick=async()=>{busy=true;summary();$('progressBox').classList.remove('hidden');$('downloadLink').classList.add('hidden');$('log').replaceChildren();try{const r=await api('/api/export',{clientIds:loadedIds,scanIds:visible().filter(k=>selectedScans.has(k.id)).map(k=>k.id),status:value('status'),mode:value('mode'),params:params()});localStorage.setItem('heatmapJob',r.jobId);localStorage.setItem('heatmapJobStartedAt',new Date().toISOString());poll(r.jobId);}catch(e){append({level:'error',message:e.message});busy=false;summary();}};
let pollId=null;
async function poll(id,{restore=false}={}){if(pollId===id)return;pollId=id;busy=true;renderProfiles();summary();$('step3').classList.remove('hidden');$('progressBox').classList.remove('hidden');let since=0;try{while(true){const s=await api(`/api/export/${id}?since=${since}`);since=s.total;s.entries.forEach(append);$('jobStatus').textContent=`${s.status.toUpperCase()} · ${s.fileCount}/${s.expected??'…'} screenshots`;if(s.done){if(s.downloadReady){$('downloadLink').href=`/api/export/${id}/download`;$('downloadLink').textContent=s.status==='partial'?'Download partial ZIP — review manifest':'Download ZIP';$('downloadLink').classList.remove('hidden');}else clearStoredJob();break;}await new Promise(r=>setTimeout(r,1500));}}catch(e){clearStoredJob();if(restore){$('progressBox').classList.add('hidden');$('log').replaceChildren();}else append({level:'warn',message:e.message.includes('not found')?'The previous export session expired on the server. Start a new export.':e.message});}finally{busy=false;pollId=null;renderProfiles();summary();}}
boot();
