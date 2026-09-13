import {slug,monthKey} from './dateutil.js';
const pair=(before,after)=>({before,after,tag:`${before.key}_vs_${after.key}`});
export function previousMonth(key) { const [y,m]=key.split('-').map(Number); return monthKey(new Date(Date.UTC(y,m-2,1))); }
export function resolvePairs(months,mode,params={}) {
 const sorted=[...months].sort((a,b)=>a.key.localeCompare(b.key));
 if(sorted.length<2)return [];
 if(mode==='current_vs_previous') {
  const key=monthKey(params.now||new Date());
  const after=sorted.find(m=>m.key===key),before=sorted.find(m=>m.key===previousMonth(key));
  return before&&after?[pair(before,after)]:[];
 }
 if(mode==='since_beginning')return [pair(sorted[0],sorted.at(-1))];
 if(mode==='custom') {
  const before=sorted.find(m=>m.key===params.beforeKey),after=sorted.find(m=>m.key===params.afterKey);
  return before&&after&&before.key<after.key?[pair(before,after)]:[];
 }
 if(mode==='all_consecutive')return sorted.slice(1).flatMap((m,i)=>previousMonth(m.key)===sorted[i].key?[pair(sorted[i],m)]:[]);
 return [];
}
export function pairLabel(p) {return `${p.before.monthLabel} → ${p.after.monthLabel}`;}
export {slug};
