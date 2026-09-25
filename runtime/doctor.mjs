import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SUBAGENT_ROLES,modelRolesReport} from './model-roles.mjs';
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
// Key Jev cho auto mode: kho của pi-mcp-adapter (biến môi trường rồi keyring); chỉ báo nguồn, không in key.
let jevKey='không kiểm được kho key';
try{
  const store=await import(pathToFileURL(path.join(root,'runtimes/current/node_modules/pi-mcp-adapter/dist/jev-key-store.js')).href);
  const endpoint=store.resolveJevEndpoint();
  if(endpoint.status==='unavailable')jevKey=`SYSTEMONE_ENDPOINT không hợp lệ: ${endpoint.message}`;
  else{
    const credential=store.resolveJevCredential(process.env,endpoint.endpoint);
    const variable=Object.hasOwn(process.env,'SYSTEMONE_API_KEY')?'SYSTEMONE_API_KEY':'TYPESAFE_API_KEY';
    jevKey=credential.status==='present'?`key từ ${credential.source==='keyring'?'keyring':variable}`
      :credential.status==='missing'?'chưa có key: đặt TYPESAFE_API_KEY hoặc pi-mcp-adapter key set systemone':`không đọc được key: ${credential.message}`;
  }
}catch{}
for(const [name,p] of Object.entries(profiles)){
  const s=read(path.join(p.agentDir,'settings.json'));
  // Model/thinking của mọi vai theo model-roles.json, giá trị đang có hiệu lực khi khác, và kiểm catalog của Pi.
  const models=await modelRolesReport({root,agentDir:p.agentDir,modules:path.join(root,'runtimes',p.runtime,'node_modules')});
  console.log(`${name}: ${models.lines.join('\n') || 'không đọc được cấu hình model'}`);
  errors.push(...models.errors.map(item=>`${name}: ${item}`));warnings.push(...models.warnings.map(item=>`${name}: ${item}`));
  for(const pkg of s.packages)if(!fs.existsSync(typeof pkg==='string'?pkg:pkg.source))errors.push(`Thiếu package: ${name}`);
  for(const entry of s.extensions??[])if(typeof entry==='string'&&!entry.startsWith('-')&&path.isAbsolute(entry)&&!fs.existsSync(entry))errors.push(`Thiếu extension: ${name}: ${entry}`);
  // Lần gộp đầu của bản cài chưa lưu mặc định giữ mục cũ trong file đã sửa; search Claude nay là provider anthropic của pi-web-access.
  if((s.extensions??[]).some(entry=>typeof entry==='string'&&/[\\/]native-web-search[\\/]?$/u.test(entry)))
    warnings.push(`${name}: settings.json còn extension native-web-search đã bỏ; xoá dòng này`);
  const webSearch=path.join(p.agentDir,'web-search.json');
  if(p.packages.includes('pi-web-access')&&fs.existsSync(webSearch)){
    const config=read(webSearch),providers=config.searchRouting?.providers,allowed=config.webSearch?.allowedProviders;
    if(Array.isArray(providers)&&!providers.includes('anthropic'))
      warnings.push(`${name}: web-search.json thiếu "anthropic" trong searchRouting.providers và webSearch.allowedProviders; phiên Claude sẽ tìm bằng provider kế tiếp`);
    // pi-web-access không nạp (mất mọi web tool) khi searchRouting.providers có provider ngoài webSearch.allowedProviders.
    const outside=Array.isArray(providers)&&Array.isArray(allowed)?providers.filter(item=>!allowed.includes(item)):[];
    if(outside.length)errors.push(`${name}: web-search.json: ${outside.join(', ')} có trong searchRouting.providers nhưng không có trong webSearch.allowedProviders; pi-web-access sẽ không nạp web tools. Thêm vào cả hai danh sách hoặc bỏ khỏi cả hai`);
  }
  if(p.packages.includes('@tintinweb/pi-subagents')){
    // Role ngoài enabledModels vẫn chạy nhưng pi-subagents (scopeModels) sẽ cảnh báo.
    const enabled=new Set(s.enabledModels??[]),edited=[];
    for(const role of SUBAGENT_ROLES){
      const file=path.join(p.agentDir,'agents',role+'.md');
      if(!fs.existsSync(file)){errors.push(`${name}: thiếu role ${role}`);continue;}
      const bytes=fs.readFileSync(file),text=bytes.toString('utf8');
      const model=text.match(/^model:\s*(\S+)\s*$/m)?.[1],thinking=text.match(/^thinking:\s*(\S+)\s*$/m)?.[1];
      if(state.files[file]&&sha256(bytes)!==state.files[file])edited.push(role);
      if(!model||!thinking)errors.push(`${name}: role ${role} thiếu model hoặc thinking`);
      else if(enabled.size&&!enabled.has(model))warnings.push(`${name}: role ${role} dùng ${model} ngoài enabledModels`);
    }
    if(edited.length)console.log(`  file role đã sửa so với bản cài: ${edited.join(', ')}`);
  }
  const advisorFile=path.join(p.agentDir,'advisor.json');
  if(p.packages.includes('pi-advisor-flow')&&fs.existsSync(advisorFile)){
    const advisor=read(advisorFile),main=`${s.defaultProvider}/${s.defaultModel}`;
    console.log(`  advisor ${advisor.alwaysOn===true?`luôn bật, tối đa ${advisor.advisorMaxCallsPerSession??'∞'} lần/phiên`:'tắt'}`);
    // alwaysOn đặt model của phiên thành executor mỗi lần mở phiên.
    if(advisor.alwaysOn===true&&advisor.executor&&advisor.executor!==main)
      warnings.push(`${name}: advisor.json bật alwaysOn với executor ${advisor.executor}; mỗi phiên sẽ chuyển từ ${main} sang model này`);
  }
  const goalFile=path.join(p.agentDir,'pi-goal-x-settings.json');
  if(p.packages.includes('pi-goal-x')&&fs.existsSync(goalFile)){
    const goal=read(goalFile);
    console.log(`  goal auditor ${goal.disabled===true?'tắt':'bật'}; Oracle ${goal.oracle?.enabled===true?'bật':'tắt'}`);
  }
  const auto=s.autoMode??{},jev=auto.jev===false||auto.jev?.enabled===false?undefined:auto.jev??{};
  console.log(`  auto mode: bước 1 ${jev?`Jev ${jev.model??'jev-1.13.0'} (${jevKey})`:'LLM của vai autoMode (Jev tắt)'}; bước 2 LLM của vai autoMode`);
}
for(const source of Object.keys(state.sources))if(!fs.existsSync(path.join(root,'sources',source)))errors.push(`Thiếu skills source: ${source}`);
console.log('Một cấu hình Pi; đăng nhập bằng /login hoặc pi-login. Không kiểm tra token bằng mạng.');
if(process.platform==='win32' && state.shellPath&&!fs.existsSync(state.shellPath))errors.push('Không tìm thấy Git Bash đã cấu hình');
if(warnings.length)console.warn(warnings.join('\n'));
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Pi-config: OK (kiểm tra cục bộ, không gọi API tính phí).');
