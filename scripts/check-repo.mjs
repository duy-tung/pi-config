import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const failures=[];let count=0;
const personal=['/Users/','tung/'].join('');
const patterns=[/fc-[a-f0-9]{24,}/i,/apikey_[a-f0-9]{24,}_[a-f0-9]{32,}/i,/(?:ghp_|github_pat_)[A-Za-z0-9_]{24,}/,/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(['.git','node_modules','.test-tmp','test-results'].includes(e.name))continue;
  const file=path.join(dir,e.name),relative=path.relative(root,file);
  if(e.isSymbolicLink()){failures.push(`Không publish symlink: ${relative}`);continue;}
  if(e.isDirectory()){walk(file);continue;}
  if(/^(auth|credentials)\.json$|\.env$|\.log$/.test(e.name))failures.push(`File riêng tư: ${relative}`);
  if(e.name.endsWith('.tgz'))continue;
  const text=fs.readFileSync(file,'utf8');count++;
  if(text.includes(personal)||patterns.some(p=>p.test(text)))failures.push(`Có thể chứa secret/path cá nhân: ${relative}`);
}}
walk(root);
for(const name of ['current','compat','firecrawl']){
  const p=JSON.parse(fs.readFileSync(path.join(root,'manifests',name,'package.json')));
  for(const [dep,version] of Object.entries(p.dependencies))if(!/^\d+\.\d+\.\d+$|^file:\.\.\/\.\.\/vendor\//.test(version))failures.push(`Dependency chưa ghim ${name}/${dep}`);
  for(const entry of Object.values(p.piPlatform?.localPackages ?? {})){
    const file=path.join(root,'vendor',path.basename(entry.source));
    if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==entry.sha256)failures.push('Vendor hash mismatch');
  }
}
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
console.log(`PASS: ${count} file văn bản; không phát hiện secret/path máy nguồn; dependency và vendor được ghim.`);
