import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=JSON.parse(fs.readFileSync(path.join(root,'install-state.json'),'utf8'));
const profiles=JSON.parse(fs.readFileSync(path.join(root,'profiles.json'),'utf8'));
const [action='main',...args]=process.argv.slice(2);
if(action==='doctor'){
  process.env.PI_CONFIG_ROOT=root;await import('./doctor.mjs');
}else if(action==='test'){
  const {spawnSync}=await import('node:child_process');
  for(const script of ['profile-integration.mjs','agent-integration.mjs']){
    const result=spawnSync(state.nodePath,[path.join(root,'tests',script),root,'main'],{stdio:'inherit',env:process.env});
    if(result.status!==0){process.exitCode=result.status??1;break;}
  }
}else if(action==='models'){
  const {runModels}=await import('./models.mjs');
  process.exitCode=await runModels({root,profiles,args});
}else{
  const name=action==='login'?'main':action;
  const profile=profiles[name];
  // mcp-adapter: CLI của pi-mcp-adapter (vd `pi-mcp-adapter key set systemone` lưu key Jev vào keyring).
  if(action!=='firecrawl'&&action!=='mcp-adapter'&&!profile)throw new Error('Profile không hợp lệ');
  const runtime=profile?.runtime ?? 'current';
  const modules=path.join(root,'runtimes',runtime,'node_modules');
  const env={...process.env,
    PI_CODING_AGENT_DIR:profile?.agentDir ?? state.agentDir,
    PI_WORKSPACE_DIR:process.cwd(),
    PI_LENS_CONFIG_PATH:path.join(root,'config/pi-lens.json'),
    PI_LENS_DISABLE_LSP_INSTALL:'1', PI_LENS_DISABLE_TOOL_INSTALL:'1',
    PI_BG_DISABLE_UPDATE_CHECK:'1',
    FIRECRAWL_NO_SEARCH_FEEDBACK:'1', FIRECRAWL_NO_ENDPOINT_FEEDBACK:'1',
  };
  const parts=[path.dirname(state.nodePath),path.join(modules,'.bin'),path.join(root,'runtimes/current/node_modules/.bin')];
  if(state.shellPath){parts.push(path.dirname(state.shellPath),path.resolve(path.dirname(state.shellPath),'../cmd'));}
  const oldPath=env.PATH ?? env.Path ?? '';
  if(process.platform==='win32')for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  env.PATH=[...new Set(parts),oldPath].join(path.delimiter);
  const entry=action==='firecrawl'?path.join(root,'tools/firecrawl/node_modules/firecrawl-cli/dist/index.js'):
    action==='mcp-adapter'?path.join(modules,'pi-mcp-adapter/cli.js'):
    path.join(modules,'@earendil-works/pi-coding-agent/dist/cli.js');
  const child=spawn(state.nodePath,[entry,...args],{env,stdio:'inherit',windowsHide:false});
  child.on('error',()=>{console.error('Không chạy được runtime; thử pi-doctor.');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{try{child.kill(signal);}catch{}});
  child.on('exit',(code)=>{process.exitCode=code ?? 1;});
}
