import fs from 'node:fs';
import path from 'node:path';
// Read only the two MapRanking keys; never copy MTOS's environment into this app.
export function loadMtosCredentials() {
 const values={};
 const root=process.env.MTOS_ROOT || 'E:/motsv7';
 for(const name of ['.env','.env.local']) {
  const file=path.join(root,'apps','seoos',name);
  if(!fs.existsSync(file))continue;
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
   const match=line.match(/^\s*(?:export\s+)?(MAPRANKING_LOGIN_EMAIL|MAPRANKING_LOGIN_PASSWORD)\s*=\s*(.*)$/);
   if(!match)continue;
   let value=match[2].trim();
   if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1).replace(/\\n/g,'\n').replace(/\\r/g,'\r');
   else if(value.startsWith("'")&&value.endsWith("'"))value=value.slice(1,-1);
   else value=value.replace(/\s+#.*$/,'').trim();
   values[match[1]]=value;
  }
 }
 const email=process.env.MAPRANKING_LOGIN_EMAIL || values.MAPRANKING_LOGIN_EMAIL;
 const password=process.env.MAPRANKING_LOGIN_PASSWORD || values.MAPRANKING_LOGIN_PASSWORD;
 return email&&password?{email,password,source:'MTOS 7'}:null;
}
