import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import {fileURLToPath} from 'node:url';
import {login,getBusinesses,getClientKeywords} from './src/mapranking-api.js';
import {loadMtosCredentials} from './src/credentials.js';
import {resolvePairs,slug} from './src/compare.js';
import {runExport} from './src/exporter.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const isVercel=process.env.VERCEL==='1';
const outputDir=process.env.HEATMAP_OUTPUT_DIR || (isVercel?path.join('/tmp','heatmap-extractor-output'):path.join(root,'output'));
fs.mkdirSync(outputDir,{recursive:true});
const app=express();
app.use(express.json({limit:'1mb'}));
app.use((req,res,next)=>{
 if(!isVercel&&!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host||''))return res.status(403).json({error:'Use the local application address.'});
 const origin=req.headers.origin;
 const expectedOrigin=isVercel?`https://${req.headers.host}`:`http://${req.headers.host}`;
 if(origin && origin!==expectedOrigin)return res.status(403).json({error:'Only this application can make requests.'});
 res.setHeader('Cache-Control','no-store');next();
});
app.use(express.static(path.join(root,'public')));
app.get('/shared/compare.js',(req,res)=>res.sendFile(path.join(root,'src/compare.js')));
app.get('/shared/dateutil.js',(req,res)=>res.sendFile(path.join(root,'src/dateutil.js')));
let session=null,autoLoginDisabled=false,loginPromise=null;
function savedCredentials(){
 const mtos=loadMtosCredentials();if(mtos)return mtos;
 try{const c=JSON.parse(fs.readFileSync(path.join(root,'config/credentials.json'),'utf8'));return c.email&&c.password?{...c,source:'Saved local login'}:null;}catch{return null;}
}
async function ensureSession(force=false){
 if(session && !force && Date.now()-session.createdAt<30*60*1000)return session;
 if(loginPromise)return loginPromise;
 const creds=session?.credentials || (!autoLoginDisabled?savedCredentials():null);
 if(!creds)throw Object.assign(new Error('Sign in to MapRanking or configure MTOS_ROOT.'),{status:401});
 loginPromise=(async()=>{const auth=await login(creds.email,creds.password);session={...auth,credentials:creds,createdAt:Date.now()};return session;})();
 try{return await loginPromise;}finally{loginPromise=null;}
}
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
app.get('/api/session',route(async(req,res)=>{
 try{await ensureSession();}catch(e){return res.json({loggedIn:false,error:e.message,mtosAvailable:!!loadMtosCredentials()});}
 res.json({loggedIn:true,email:session.credentials.email,source:session.credentials.source||'Manual login'});
}));
app.post('/api/session/login',route(async(req,res)=>{
 const {email,password}=req.body||{};
 if(!email||!password)return res.status(400).json({error:'Email and password are required.'});
 const auth=await login(email,password);session={...auth,credentials:{email,password,source:'Manual login'},createdAt:Date.now()};autoLoginDisabled=false;
 res.json({ok:true,email,source:'Manual login'});
}));
app.post('/api/session/mtos',route(async(req,res)=>{session=null;autoLoginDisabled=false;await ensureSession();res.json({ok:true});}));
app.post('/api/session/logout',(req,res)=>{session=null;autoLoginDisabled=true;res.json({ok:true});});
app.get('/api/clients',route(async(req,res)=>{const s=await ensureSession();res.json({clients:await getBusinesses(s.token)});}));
app.get('/api/clients/:id/keywords',route(async(req,res)=>{const s=await ensureSession();res.json({keywords:await getClientKeywords(s.token,req.params.id)});}));
const jobs=new Map();let activeJob=null;
function update(job){fs.writeFileSync(path.join(outputDir,job.id,'job.json'),JSON.stringify(job,null,2));}
function log(job,level,message){job.log.push({level,message,at:new Date().toISOString()});update(job);}
async function zip(job,dir){
 const zipPath=path.join(outputDir,job.id+'.zip');
 await new Promise((resolve,reject)=>{
  const stream=fs.createWriteStream(zipPath),archive=archiver('zip',{zlib:{level:6}});
  stream.on('error',reject);stream.on('close',resolve);archive.on('error',reject);archive.on('warning',reject);archive.pipe(stream);
  for(const file of job.files)archive.file(path.join(dir,file),{name:file});
  archive.file(path.join(dir,'manifest.txt'),{name:'manifest.txt'});
  archive.file(path.join(dir,'manifest.json'),{name:'manifest.json'});
  archive.finalize().catch(reject);
 });
 job.zipPath=zipPath;
}
app.post('/api/export',route(async(req,res)=>{
 if(activeJob)return res.status(409).json({error:'An export is already running.',jobId:activeJob});
 const {clientIds,scanIds,status='active',mode='current_vs_previous',params={}}=req.body||{};
 if(!Array.isArray(clientIds)||!clientIds.length||clientIds.some(id=>typeof id!=='string')||new Set(clientIds).size!==clientIds.length)return res.status(400).json({error:'Select at least one unique client profile.'});
 if(!['active','paused','all'].includes(status)||!['current_vs_previous','since_beginning','all_consecutive','custom'].includes(mode))return res.status(400).json({error:'Invalid export options.'});
 if(scanIds!==undefined&&(!Array.isArray(scanIds)||!scanIds.length||scanIds.some(id=>typeof id!=='string')))return res.status(400).json({error:'Select at least one scan, or omit scanIds to export all matching scans.'});
 if(mode==='custom'&&(!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.beforeKey)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.afterKey)||params.beforeKey>=params.afterKey))return res.status(400).json({error:'Choose two months, with From earlier than To.'});
 const s=await ensureSession();
 // The asynchronous job keeps its own authenticated snapshot if the user signs out.
 if(activeJob)return res.status(409).json({error:'An export is already running.'});
 const job={id:crypto.randomBytes(8).toString('hex'),status:'running',done:false,log:[],files:[],errors:[],skipped:[],records:[],profiles:[],mode,params:mode==='custom'?{beforeKey:params.beforeKey,afterKey:params.afterKey}:{},startedAt:new Date().toISOString(),zipPath:null};
 const dir=path.join(outputDir,job.id);fs.mkdirSync(dir,{recursive:true});jobs.set(job.id,job);activeJob=job.id;update(job);
 res.json({jobId:job.id});
 (async()=>{
  try{
   const businesses=await getBusinesses(s.token);
   const requested=new Set(scanIds);const found=new Set();const targets=[];
   for(const id of clientIds){
    const business=businesses.find(b=>b.id===id);if(!business)throw Error('A selected client profile is no longer available.');
    job.profiles.push(business);log(job,'info',`Loading ${business.name} — ${business.address}`);
    const all=await getClientKeywords(s.token,id);
    const matching=all.filter(k=>status==='all'||k.status===status).filter(k=>scanIds===undefined||requested.has(k.id));
    for(const k of matching){
     found.add(k.id);
     const pairs=resolvePairs(k.months,mode,{...job.params,now:job.startedAt});
     if(!pairs.length){job.skipped.push({profile:business.name,profileId:id,keyword:k.keyword,scanId:k.id,reason:'No completed scans in both requested calendar months.'});continue;}
     targets.push({...k,business,pairs});
    }
    if(!matching.length)job.skipped.push({profile:business.name,profileId:id,reason:'No scans matched the selected status and selection.'});
   }
   if(scanIds!==undefined&&[...requested].some(id=>!found.has(id)))throw Error('Some selected scans changed or no longer match the filter. Reload the client profiles.');
   job.expected=targets.reduce((sum,t)=>sum+t.pairs.length,0);
   log(job,'info',`${job.expected} comparisons queued across ${clientIds.length} profile(s). ${job.skipped.length} skipped.`);
   if(targets.length){
    const result=await runExport({session:s,targets,outDir:dir,onProgress:e=>log(job,e.level,e.message)});
    job.files=result.files;job.errors=result.errors;job.records=result.records;
   }
   job.status=job.files.length===0?'error':job.errors.length||job.skipped.length?'partial':'done';
   const manifest={generatedAt:new Date().toISOString(),status:job.status,mode,calendarTimezone:'UTC',profiles:job.profiles,expected:job.expected,captured:job.files.length,comparisons:job.records,skipped:job.skipped,errors:job.errors};
   fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
   const lines=['MapRanking — Monthly heatmap comparisons',`Generated: ${manifest.generatedAt}`,`Status: ${job.status.toUpperCase()} — ${job.files.length}/${job.expected} captured`,`Calendar months: UTC; latest completed scan within each requested month.`, '',...job.profiles.flatMap(b=>[b.name,b.address,'']),...job.records.map(r=>`${r.file}\n  ${r.keyword} | ${r.before.timestamp} → ${r.after.timestamp}`),'',...job.skipped.map(s=>`SKIPPED: ${s.profile} / ${s.keyword||''}: ${s.reason}`),...job.errors.map(e=>`FAILED: ${e.keyword||''}: ${e.error}`)];
   fs.writeFileSync(path.join(dir,'manifest.txt'),lines.join('\n'));
   if(job.files.length){await zip(job,dir);log(job,job.status==='done'?'success':'warn',`${job.status==='done'?'Complete':'Partial export'}: ${job.files.length}/${job.expected} screenshots packaged.`);}
   else log(job,'error','No verified comparisons were captured. See the skipped/failed details.');
  }catch(e){job.status='error';job.errors.push({error:e.message});log(job,'error',e.message);}
  finally{job.done=true;activeJob=null;update(job);}
 })();
}));
app.get('/api/export/:id',(req,res)=>{
 let job=jobs.get(req.params.id);
 if(!job&&/^[a-f0-9]{16}$/.test(req.params.id)){try{job=JSON.parse(fs.readFileSync(path.join(outputDir,req.params.id,'job.json'),'utf8'));if(!job.done){job.done=true;job.status='error';job.log.push({level:'error',message:'The server restarted before this export finished. Start a new export.'});}jobs.set(job.id,job);}catch{}}
 if(!job)return res.status(404).json({error:'Export not found.'});
 const since=Math.max(0,Number(req.query.since)||0);
 res.json({status:job.status,done:job.done,entries:job.log.slice(since),total:job.log.length,fileCount:job.files.length,expected:job.expected,errors:job.errors,skipped:job.skipped,downloadReady:!!job.zipPath});
});
app.get('/api/export/:id/download',(req,res)=>{
 const job=jobs.get(req.params.id);if(!job?.zipPath)return res.status(404).send('Export not ready.');
 const name=job.profiles.length===1?slug(job.profiles[0].name):'client-profiles';
 res.download(job.zipPath,`heatmaps-${name}-${job.startedAt.slice(0,7)}${job.status==='partial'?'-partial':''}.zip`);
});
app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message||'Request failed.'}));
const port=Number(process.env.PORT)||3000;
if(!isVercel)app.listen(port,'127.0.0.1',()=>console.log(`Heatmap Extractor: http://127.0.0.1:${port}`));
export default app;
