#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildConfiguration} from './lib/config.mjs';
import {applyPatches} from './lib/patches.mjs';
import {preserveLocalControls,reconcileResources} from './lib/resources.mjs';
import {run,download,npmCli,readJson,writeJson,sha256,shellQuote,assertSafePath} from './lib/system.mjs';

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
const lock=path.join(root,'.install.lock');
const lockFd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(lockFd,String(process.pid));fs.closeSync(lockFd);
const state={version:1,root,agentDir,binDir,nodePath,platform:process.platform,arch:process.arch,
  shellPath:shellPath ?? previous?.shellPath,files:previous?.files ?? {},runtimes:previous?.runtimes ?? {},sources:previous?.sources ?? {}};
const preserved=[],wanted=new Set();
function managed(file,content,mode=0o600){
  wanted.add(file);
  const bytes=Buffer.isBuffer(content)?content:Buffer.from(content);
  const hash=sha256(bytes);
  if(fs.existsSync(file)){
    if(fs.lstatSync(file).isSymbolicLink())throw new Error(`Không ghi đè symlink: ${file}`);
    const actual=sha256(fs.readFileSync(file));
    if(actual===hash){state.files[file]=hash;return;}
    if(!previous?.files[file] || actual!==previous.files[file]){preserved.push(file);return;}
    const backup=path.join(root,'backups',new Date().toISOString().replaceAll(':','-'),path.relative(root,file).replaceAll('..','parent'));
    fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(file,backup);
  }
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+`.${process.pid}.install-tmp`;fs.writeFileSync(temporary,bytes,{mode});fs.renameSync(temporary,file);
  if(process.platform!=='win32')fs.chmodSync(file,mode);
  state.files[file]=hash;
  writeJson(statePath,state);
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
  const manifestHash=sha256(fs.readFileSync(path.join(source,'package-lock.json')));
  if(previous?.runtimes[name]===manifestHash && fs.existsSync(path.join(dest,'node_modules'))){console.log(`${name}: giữ runtime đã cài`);return;}
  const stage=path.join(path.dirname(dest),`.${path.basename(dest)}-stage-${process.pid}`);
  fs.mkdirSync(stage,{recursive:true});
  for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,file),path.join(stage,file));
  console.log(`${name}: cài dependency từ lockfile`);
  try{
    await run(nodePath,[npmCli(),'ci','--ignore-scripts','--omit=dev','--no-fund'],{cwd:stage});
    if(fs.existsSync(dest)){
      const backup=path.join(root,'backups',`runtime-${name}-${Date.now()}`);fs.mkdirSync(path.dirname(backup),{recursive:true});fs.renameSync(dest,backup);
    }
    fs.renameSync(stage,dest);state.runtimes[name]=manifestHash;writeJson(statePath,state);
  }catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error;}
}
async function installSource(source){
  const dest=path.join(root,'sources',source.name);
  if(previous?.sources[source.name]===source.sha256 && fs.existsSync(dest))return;
  if(fs.existsSync(dest))throw new Error(`Nguồn skills đã tồn tại với revision khác: ${source.name}`);
  const archive=path.join(root,'.downloads',source.name+'.tar.gz');
  await download(source.url,archive,source.sha256);
  const stage=dest+'.stage';fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
  try{await run(process.platform==='win32'?'tar.exe':'tar',['-xzf',archive,'--strip-components=1','-C',stage]);}
  catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error;}
  fs.renameSync(stage,dest);state.sources[source.name]=source.sha256;writeJson(statePath,state);
  fs.unlinkSync(archive);
}
function launcher(name,action){
  const target=path.join(root,'bin/launch.mjs');
  if(process.platform==='win32'){
    managed(path.join(binDir,name+'.cmd'),`@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${nodePath}" "${target}" "${action}" %*\r\n`,0o755);
  }else managed(path.join(binDir,name),`#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(target)} ${shellQuote(action)} "$@"\n`,0o755);
}
async function addPath(){
  if(argv.includes('--no-path'))return;
  if(process.platform==='win32'){
    const script=path.join(root,'bin/add-path.ps1');
    managed(script,'param([string]$Directory)\n$p=[Environment]::GetEnvironmentVariable("Path","User")\nif (($p -split ";") -notcontains $Directory) {[Environment]::SetEnvironmentVariable("Path",($Directory+";"+$p),"User")}\n');
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
  writeJson(statePath,state);
  copyTree(path.join(repoDir,'assets'),path.join(root,'assets'));
  copyTree(path.join(repoDir,'vendor'),path.join(root,'vendor'));
  await installRuntime('current','runtimes/current');
  await installRuntime('compat','runtimes/compat');
  await installRuntime('firecrawl','tools/firecrawl');
  await applyPatches({root});
  for(const source of readJson(path.join(repoDir,'sources.lock.json')))await installSource(source);
  for(const filename of fs.readdirSync(path.join(repoDir,'runtime'))){
    const source=path.join(repoDir,'runtime',filename);if(fs.statSync(source).isFile())managed(path.join(root,'bin',filename),fs.readFileSync(source));
  }
  const files=buildConfiguration({root,agentDir,binDir,nodePath,platform:process.platform,home,repoDir,shellPath:state.shellPath});
  for(const specification of files){const file=preserveLocalControls(specification);managed(file.path,file.content,file.mode);}
  for(const [name,action] of Object.entries({'pi':'main','pi-goal':'goal','pi-background':'background','pi-advisor':'advisor','pi-login':'login','pi-doctor':'doctor','pi-config':'doctor','firecrawl':'firecrawl','pi-models':'models'}))launcher(name,action);
  const auth=path.join(agentDir,'auth.json');
  if(!fs.existsSync(auth)){fs.mkdirSync(agentDir,{recursive:true,mode:0o700});fs.writeFileSync(auth,'{}\n',{mode:0o600});}
  await addPath();
  reconcileResources({root,agentDir,binDir,state,wanted});
  state.installedAt=new Date().toISOString();writeJson(statePath,state);
  console.log(`\nĐã cài Pi vào ${root}. Mở terminal mới rồi chạy pi.`);
  console.log('Đăng nhập: pi-login → /login. Firecrawl: firecrawl login --browser.');
  if(preserved.length)console.log('Giữ nguyên các file đã được bạn tùy chỉnh:\n'+preserved.join('\n'));
  await run(nodePath,[path.join(root,'bin/launch.mjs'),'doctor']);
}finally{fs.unlinkSync(lock);}
