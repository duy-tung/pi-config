import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const profiles=read(path.join(root,'profiles.json'));
const state=read(path.join(root,'install-state.json'));
const errors=[];
for(const [label,relative] of Object.entries({current:'runtimes/current',compat:'runtimes/compat',firecrawl:'tools/firecrawl'})){
  const dir=path.join(root,relative),manifest=read(path.join(dir,'package.json'));
  for(const [pkg,version] of Object.entries(manifest.dependencies)){
    const actual=read(path.join(dir,'node_modules',pkg,'package.json')).version;
    const expected=manifest.piPlatform?.localPackages?.[pkg]?.version ?? version;
    if(actual!==expected)errors.push(`${label}/${pkg}: sai phiên bản ${actual}`);
  }
  console.log(`${label}: ${Object.keys(manifest.dependencies).length} dependency ghim phiên bản`);
}
for(const patch of read(path.join(root,'patches/manifest.json'))){
  const file=path.join(root,'runtimes',patch.runtime,'node_modules',patch.package,patch.file);
  const hash=crypto.createHash('sha256').update(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n')).digest('hex');
  if(hash!==patch.patchedSha256)errors.push(`Bản vá đã đổi: ${patch.package}/${patch.file}`);
}
for(const [name,p] of Object.entries(profiles)){
  const s=read(path.join(p.agentDir,'settings.json'));
  console.log(`${name}: ${s.defaultProvider}/${s.defaultModel}; thinking ${s.defaultThinkingLevel}`);
  for(const pkg of s.packages)if(typeof pkg==='string'&&!fs.existsSync(pkg))errors.push(`Thiếu package: ${name}`);
  for(const entry of s.extensions??[])if(typeof entry==='string'&&!entry.startsWith('-')&&path.isAbsolute(entry)&&!fs.existsSync(entry))errors.push(`Thiếu extension: ${name}: ${entry}`);
  if(['main','goal'].includes(name)){
    for(const role of ['researcher','worker','debugger','reviewer']){
      if(!fs.existsSync(path.join(p.agentDir,'agents',role+'.md')))errors.push(`${name}: thiếu role ${role}`);
    }
    console.log(`${name}: Agent: researcher GLM/max, worker/debugger/reviewer Sol/high`);
  }
  if(s.modelThinkingLevels?.['opencode-go/glm-5.3-flash']!=='max')errors.push(`${name}: GLM effort phải max`);
}
for(const source of Object.keys(state.sources))if(!fs.existsSync(path.join(root,'sources',source)))errors.push(`Thiếu skills source: ${source}`);
console.log('Auth dùng chung theo launcher; đăng nhập bằng pi-login. Không kiểm tra token bằng mạng.');
if(process.platform==='win32' && state.shellPath&&!fs.existsSync(state.shellPath))errors.push('Không tìm thấy Git Bash đã cấu hình');
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Pi-config: OK (kiểm tra cục bộ, không gọi API tính phí).');
