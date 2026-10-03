#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildConfiguration} from './lib/config.mjs';
import {applyPatches} from './lib/patches.mjs';
import {pruneBackups} from './lib/backups.mjs';
import {prunePlatformPackages} from './lib/platform-prune.mjs';
import {backupFile,describeMerge,reconcileConfigFile,writeAtomic} from './runtime/merge.mjs';
import {acquireInstallLock} from './runtime/install-lock.mjs';
import {mergesConfig,reconcileResources} from './lib/resources.mjs';
import {checkCatalog,loadPresets,readModelRoles,resolveModelRoles,writeModelRoles} from './runtime/model-roles.mjs';
import {run,download,npmCli,npmTimeout,readJson,writeJson,sha256,shellQuote,assertSafePath} from './lib/system.mjs';

const repoDir=path.dirname(fileURLToPath(import.meta.url));
const argv=process.argv.slice(2);
const known=new Set(['--root','--agent-dir','--bin-dir','--no-path','--help']);
for(let i=0;i<argv.length;i++){
  if(!known.has(argv[i]))throw new Error(`Tham số không hợp lệ: ${argv[i]}`);
  if(['--root','--agent-dir','--bin-dir'].includes(argv[i])){if(!argv[++i] || argv[i].startsWith('--'))throw new Error('Thiếu đường dẫn cho tham số');}
}
if(argv.includes('--help')){
  console.log('Cài Pi: node install.mjs [--root PATH] [--agent-dir PATH] [--bin-dir PATH] [--no-path]');process.exit(0);
}
const option=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1];};
const home=os.homedir();
const root=assertSafePath(option('--root',path.join(home,'.local/share/pi-platform')));
const agentDir=assertSafePath(option('--agent-dir',path.join(home,'.pi/agent')));
const binDir=assertSafePath(option('--bin-dir',path.join(home,'.local/bin')));
const nodePath=process.execPath;
const shellPath=process.env.PI_CONFIG_GIT_BASH;
if(Number(process.versions.node.split('.')[0])<24)throw new Error('Cần Node 24 trở lên; bootstrap sẽ tự cài bản đã ghim.');
if(!['darwin','linux','win32'].includes(process.platform))throw new Error('Chỉ hỗ trợ macOS, Linux, Windows.');
const statePath=path.join(root,'install-state.json');
const previous=fs.existsSync(statePath)?readJson(statePath):undefined;
if(previous && (previous.agentDir!==agentDir || previous.binDir!==binDir))throw new Error('Root này đã dùng agent-dir/bin-dir khác. Dùng đúng các đường dẫn cũ.');
if(!previous && fs.existsSync(root) && fs.readdirSync(root).length)throw new Error('Root đã có dữ liệu không thuộc pi-config. Dùng --root khác; cấu hình hiện tại không bị ghi đè.');
if(!previous && fs.existsSync(path.join(agentDir,'settings.json')))throw new Error('Pi đã có settings ở agent-dir. Dùng --agent-dir khác để nghiệm thu trước khi chuyển.');
fs.mkdirSync(root,{recursive:true,mode:0o700});fs.mkdirSync(binDir,{recursive:true});
const releaseLock=acquireInstallLock(root);
const state={version:1,root,agentDir,binDir,nodePath,platform:process.platform,arch:process.arch,
  shellPath:shellPath ?? previous?.shellPath,files:previous?.files ?? {},runtimes:previous?.runtimes ?? {},sources:previous?.sources ?? {}};
const preserved=[],merged=[],wanted=new Set();
const backup=file=>backupFile(root,file);
function managed(file,content,mode=0o600){
  wanted.add(file);
  const bytes=Buffer.isBuffer(content)?content:Buffer.from(content);
  const hash=sha256(bytes);
  if(fs.existsSync(file)){
    if(fs.lstatSync(file).isSymbolicLink())throw new Error(`Không ghi đè symlink: ${file}`);
    const actual=sha256(fs.readFileSync(file));
    if(actual===hash){state.files[file]=hash;return;}
    if(!previous?.files[file] || actual!==previous.files[file]){preserved.push(file);return;}
    backup(file);
  }
  writeAtomic(file,bytes,mode);
  state.files[file]=hash;
  // Ghi state ngay sau mỗi file: cài bị ngắt giữa chừng thì lần sau vẫn nhận ra file này là của installer.
  writeJson(statePath,state);
}
// Cấu hình JSON của agent dir và file role: gộp mặc định mới với phần người dùng và Pi đã sửa, báo mục đã gộp và xung đột.
function managedJson(file,content){
  wanted.add(file);
  const result=reconcileConfigFile({root,file,content,recorded:previous?.files[file],backup});
  if(result.preserved){preserved.push(result.preserved==='invalid'?`${file} (không đọc được ${path.extname(file)==='.md'?'frontmatter':'JSON'} nên chưa gộp mặc định mới)`:file);return;}
  if(result.changes.length||result.conflicts.length)merged.push({file,...result});
  if(state.files[file]!==result.recorded){state.files[file]=result.recorded;writeJson(statePath,state);}
}
/** Model/thinking của mọi vai từ <agent-dir>/model-roles.json (chưa có thì preset mặc định). Lỗi thì dừng trước khi ghi. */
function modelRolesPlan(){
  const presets=loadPresets(path.join(repoDir,'assets','configs','model-presets.json'));
  const current=readModelRoles(agentDir);
  if(current.error)throw new Error(`${current.error}\nSửa file, hoặc xoá để dùng preset mặc định.`);
  const resolved=resolveModelRoles(presets,current.config);
  if(resolved.errors.length)throw new Error(`${current.file} không hợp lệ:\n- ${resolved.errors.join('\n- ')}`);
  return {file:current.file,exists:current.exists,config:current.config,roles:resolved.roles};
}
function copyTree(from,to){
  for(const entry of fs.readdirSync(from,{withFileTypes:true})){
    const src=path.join(from,entry.name),dest=path.join(to,entry.name);
    if(entry.isSymbolicLink())throw new Error('Không chép asset symlink');
    if(entry.isDirectory())copyTree(src,dest);else managed(dest,fs.readFileSync(src));
  }
}
async function installRuntime(name,relative){
  const source=path.join(repoDir,'manifests',name),dest=path.join(root,relative);
  // Bản vá chỉ áp lên file gốc: đổi kết quả bản vá (patchedSha256) thì cài lại runtime như khi đổi lockfile.
  const patched=readJson(path.join(repoDir,'assets','patches.json')).patches.filter(spec=>Object.hasOwn(spec.versions,name))
    .map(spec=>`${spec.package}/${spec.file}@${spec.patchedSha256}`).sort();
  const lockfile=fs.readFileSync(path.join(source,'package-lock.json'));
  const manifestHash=sha256(patched.length?Buffer.concat([lockfile,Buffer.from(`\n${patched.join('\n')}`)]):lockfile);
  // Binary optional của nền tảng khác: xoá cả ở runtime giữ lại, để bản cài trước bản sửa này cũng nhẹ đi.
  const prunePlatforms=dir=>{const removed=prunePlatformPackages(dir);if(removed.length)console.log(`${name}: bỏ ${removed.length} package optional của nền tảng khác`);};
  if(previous?.runtimes[name]===manifestHash && fs.existsSync(path.join(dest,'node_modules'))){console.log(`${name}: giữ runtime đã cài`);prunePlatforms(dest);return;}
  const stage=path.join(path.dirname(dest),`.${path.basename(dest)}-stage-${process.pid}`);
  fs.mkdirSync(stage,{recursive:true});
  for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,file),path.join(stage,file));
  console.log(`${name}: cài dependency từ lockfile`);
  try{
    await run(nodePath,[npmCli(),'ci','--ignore-scripts','--omit=dev','--no-fund'],{
      cwd:stage,timeout:npmTimeout(),
      timeoutHint:'Tải package từ registry npm quá chậm. Chạy lại installer (gói đã tải nằm trong cache của npm), hoặc tăng giới hạn bằng PI_CONFIG_NPM_TIMEOUT_MINUTES (mặc định 30).',
    });
    prunePlatforms(stage);
    if(fs.existsSync(dest))moveToBackups(dest,`runtime-${name}`);
    fs.renameSync(stage,dest);state.runtimes[name]=manifestHash;writeJson(statePath,state);
  }catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error;}
}
// Chuyển thư mục runtime/nguồn cũ vào backups/<label>-<thời điểm>; pruneBackups xoá khi cài xong.
function moveToBackups(dest,label){
  const backup=path.join(root,'backups',`${label}-${Date.now()}`);
  fs.mkdirSync(path.dirname(backup),{recursive:true});fs.renameSync(dest,backup);
  return backup;
}
async function installSource(source){
  const dest=path.join(root,'sources',source.name);
  if(previous?.sources[source.name]===source.sha256 && fs.existsSync(dest))return;
  // Nguồn cũ chỉ được thay khi do installer cài (có trong state); thư mục lạ thì dừng.
  if(fs.existsSync(dest) && !previous?.sources[source.name])throw new Error(`Nguồn skills đã tồn tại nhưng không do pi-config cài: ${source.name}`);
  const archive=path.join(root,'.downloads',source.name+'.tar.gz');
  await download(source.url,archive,source.sha256);
  const stage=dest+'.stage';fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
  try{await run(process.platform==='win32'?'tar.exe':'tar',['-xzf',archive,'--strip-components=1','-C',stage]);}
  catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error;}
  if(fs.existsSync(dest))moveToBackups(dest,`source-${source.name}`);
  fs.renameSync(stage,dest);state.sources[source.name]=source.sha256;writeJson(statePath,state);
  fs.unlinkSync(archive);
}
// Nguồn đã cài nhưng không còn trong sources.lock.json: chuyển thư mục vào backups và bỏ khỏi state, để doctor
// và lần cài sau không còn coi là nguồn đang dùng.
function retireSources(names){
  for(const name of Object.keys(state.sources)){
    if(names.has(name))continue;
    const dest=path.join(root,'sources',name);
    if(fs.existsSync(dest))console.log(`Nguồn ${name} không còn dùng: đã chuyển vào ${moveToBackups(dest,`source-${name}`)}`);
    delete state.sources[name];writeJson(statePath,state);
  }
}
// Launcher ghim đúng Node lúc cài (có thể là Node 24.15.0 sẵn có, vd của nvm): Node đó bị gỡ thì báo cách sửa.
const missingNode=`pi-config: không thấy Node tại ${nodePath}. Chạy lại installer (install.sh hoặc install.ps1) để dùng Node đã ghim.`;
function launcher(name,action){
  const target=path.join(root,'bin/launch.mjs');
  if(process.platform==='win32'){
    // cmd đọc file theo code page OEM: thông báo ASCII, không đặt trong khối ( ) vì đường dẫn có thể chứa ngoặc.
    managed(path.join(binDir,name+'.cmd'),`@echo off\r\nsetlocal DisableDelayedExpansion\r\nif exist "${nodePath}" goto run\r\n`+
      `echo pi-config: Node not found at "${nodePath}". Run install.ps1 again to use the pinned Node. 1>&2\r\nexit /b 9009\r\n`+
      `:run\r\n"${nodePath}" "${target}" "${action}" %*\r\n`,0o755);
  }else managed(path.join(binDir,name),`#!/bin/sh\nif [ ! -x ${shellQuote(nodePath)} ]; then echo ${shellQuote(missingNode)} >&2; exit 127; fi\nexec ${shellQuote(nodePath)} ${shellQuote(target)} ${shellQuote(action)} "$@"\n`,0o755);
}
async function addPath(){
  if(argv.includes('--no-path'))return;
  if(process.platform==='win32'){
    const script=path.join(root,'bin/add-path.ps1');
    managed(script,fs.readFileSync(path.join(repoDir,'lib','add-path.ps1')));
    await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,binDir]);
  }else{
    const line=`export PATH=${shellQuote(binDir)}:"$PATH"`;
    for(const filename of ['.profile','.zshrc','.bashrc']){
      const file=path.join(home,filename);const content=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
      if(!content.includes(line))fs.appendFileSync(file,`\n# pi-config\n${line}\n`,{mode:0o600});
    }
  }
}
try{
  const models=modelRolesPlan();
  writeJson(statePath,state);
  copyTree(path.join(repoDir,'assets'),path.join(root,'assets'));
  copyTree(path.join(repoDir,'vendor'),path.join(root,'vendor'));
  await installRuntime('current','runtimes/current');
  await installRuntime('firecrawl','tools/firecrawl');
  await applyPatches({root});
  const sources=readJson(path.join(repoDir,'sources.lock.json'));
  for(const source of sources)await installSource(source);
  retireSources(new Set(sources.map(source=>source.name)));
  for(const filename of fs.readdirSync(path.join(repoDir,'runtime'))){
    const source=path.join(repoDir,'runtime',filename);if(fs.statSync(source).isFile())managed(path.join(root,'bin',filename),fs.readFileSync(source));
  }
  for(const filename of ['config-integration.mjs','agent-integration.mjs','scripted-provider.ts','agent-provider.ts','search-fixtures.mjs'])
    managed(path.join(root,'tests',filename),fs.readFileSync(path.join(repoDir,'tests',filename)));
  // Model sai tên thì pi-subagents lặng lẽ dùng model của parent: kiểm trong catalog của runtime trước khi ghi cấu hình.
  const catalog=await checkCatalog({modules:path.join(root,'runtimes','current','node_modules'),agentDir,roles:models.roles});
  if(catalog.errors.length)throw new Error(`Model trong ${models.file} không dùng được:\n- ${catalog.errors.join('\n- ')}`);
  const files=buildConfiguration({root,agentDir,nodePath,platform:process.platform,home,repoDir,shellPath:state.shellPath,modelRoles:models.roles});
  for(const file of files)(mergesConfig(file.path,{agentDir})?managedJson:managed)(file.path,file.content);
  // model-roles.json thuộc về người dùng: chỉ tạo khi chưa có, không nằm trong danh sách file installer quản lý.
  if(!models.exists)writeModelRoles(models.file,models.config);
  for(const [name,action] of Object.entries({'pi':'main','pi-doctor':'doctor','pi-test':'test','firecrawl':'firecrawl'}))launcher(name,action);
  const auth=path.join(agentDir,'auth.json');
  if(!fs.existsSync(auth)){fs.mkdirSync(agentDir,{recursive:true,mode:0o700});fs.writeFileSync(auth,'{}\n',{mode:0o600});}
  await addPath();
  reconcileResources({root,agentDir,binDir,state,wanted});
  state.installedAt=new Date().toISOString();writeJson(statePath,state);
  const pruned=pruneBackups(root);
  if(pruned.length)console.log(`Đã xoá ${pruned.length} bản runtime/nguồn/tài nguyên cũ trong ${path.join(root,'backups')}.`);
  console.log(`\nĐã cài Pi vào ${root}. Mở terminal mới rồi chạy pi.`);
  const jevKey=process.platform==='win32'?'setx TYPESAFE_API_KEY "<key>"':'export TYPESAFE_API_KEY="<key>" trong ~/.zshrc hoặc ~/.bashrc';
  console.log(`Đăng nhập: pi → /login. Firecrawl: firecrawl login --browser. Jev cho auto mode: ${jevKey}.`);
  if(preserved.length)console.log('Giữ nguyên các file đã được bạn tùy chỉnh:\n'+preserved.join('\n'));
  for(const entry of merged)console.log(describeMerge(entry).join('\n'));
  if(catalog.notes.length)console.log(`Mức thinking model không hỗ trợ (Pi dùng mức gần nhất):\n  - ${catalog.notes.join('\n  - ')}`);
  await run(nodePath,[path.join(root,'bin/launch.mjs'),'doctor']);
}finally{releaseLock();}
