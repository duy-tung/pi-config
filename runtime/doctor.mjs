import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>{
  const text=fs.readFileSync(file,'utf8');
  try{return JSON.parse(text);}catch(error){throw new Error(`JSON hỏng: ${file}: ${error.message}`);}
};
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const profiles=read(path.join(root,'profiles.json'));
const state=read(path.join(root,'install-state.json'));
const errors=[],warnings=[];
for(const [label,relative] of Object.entries({current:'runtimes/current',firecrawl:'tools/firecrawl'})){
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
  for(const pkg of s.packages)if(!fs.existsSync(typeof pkg==='string'?pkg:pkg.source))errors.push(`Thiếu package: ${name}`);
  for(const entry of s.extensions??[])if(typeof entry==='string'&&!entry.startsWith('-')&&path.isAbsolute(entry)&&!fs.existsSync(entry))errors.push(`Thiếu extension: ${name}: ${entry}`);
  if(p.packages.includes('@tintinweb/pi-subagents')){
    // Model/thinking thật của từng role; role ngoài enabledModels vẫn chạy nhưng pi-subagents sẽ cảnh báo.
    const enabled=new Set(s.enabledModels??[]);
    for(const role of ['researcher','worker','debugger','reviewer']){
      const file=path.join(p.agentDir,'agents',role+'.md');
      if(!fs.existsSync(file)){errors.push(`${name}: thiếu role ${role}`);continue;}
      const bytes=fs.readFileSync(file),text=bytes.toString('utf8');
      const model=text.match(/^model:\s*(\S+)\s*$/m)?.[1],thinking=text.match(/^thinking:\s*(\S+)\s*$/m)?.[1];
      const edited=state.files[file]&&sha256(bytes)!==state.files[file]?' (đã sửa so với bản cài)':'';
      console.log(`  ${role}: ${model??'?'} (${thinking??'?'})${edited}`);
      if(!model||!thinking)errors.push(`${name}: role ${role} thiếu model hoặc thinking`);
      else if(enabled.size&&!enabled.has(model))warnings.push(`${name}: role ${role} dùng ${model} ngoài enabledModels`);
    }
  }
  if(s.modelThinkingLevels?.['opencode-go/glm-5.3-flash']!=='max')errors.push(`${name}: GLM effort phải max`);
}
for(const source of Object.keys(state.sources))if(!fs.existsSync(path.join(root,'sources',source)))errors.push(`Thiếu skills source: ${source}`);
console.log('Một cấu hình Pi; đăng nhập bằng /login hoặc pi-login. Không kiểm tra token bằng mạng.');
if(process.platform==='win32' && state.shellPath&&!fs.existsSync(state.shellPath))errors.push('Không tìm thấy Git Bash đã cấu hình');
if(warnings.length)console.warn(warnings.join('\n'));
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Pi-config: OK (kiểm tra cục bộ, không gọi API tính phí).');
