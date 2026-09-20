import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pruneInactiveConfiguration,preserveLegacyFooterExclusion} from '../lib/config-cleanup.mjs';
import {writeJson,readJson,sha256} from '../lib/system.mjs';

test('cleanup archives unused owned defaults and preserves custom or unowned files',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-config-cleanup-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const agentDir=path.join(root,'main'),background=path.join(root,'profiles/background');
  const unused=path.join(background,'subagents.json'),custom=path.join(background,'advisor.json');
  const auth=path.join(agentDir,'auth.json'),active=path.join(agentDir,'subagents.json');
  const retiredAsset=path.join(root,'assets/configs/routing.json');
  for(const file of [unused,custom,auth,active,retiredAsset])writeJson(file,{fixture:'original'});
  const state={files:Object.fromEntries([unused,custom,active,retiredAsset].map(file=>[file,sha256(fs.readFileSync(file))]))};
  writeJson(custom,{fixture:'user edit'});
  const input={root,agentDir,state,desiredFiles:[{path:active}],log:()=>{}};
  const result=pruneInactiveConfiguration(input);
  assert.deepEqual(new Set(result.archived),new Set([unused,retiredAsset]));
  assert.deepEqual(result.preserved,[custom]);
  assert.equal(readJson(custom).fixture,'user edit');assert.ok(fs.existsSync(auth)&&fs.existsSync(active));
  assert.ok(!fs.existsSync(unused)&&!fs.existsSync(retiredAsset));
  assert.equal(pruneInactiveConfiguration(input).archived.length,0);
});
test('removing obsolete exclusion never reactivates a user-owned footer',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-footer-cleanup-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const footer=path.join(root,'extensions/statusline.ts'),settings=path.join(root,'settings.json');
  fs.mkdirSync(path.dirname(footer),{recursive:true});fs.writeFileSync(footer,'user-owned footer');
  writeJson(settings,{extensions:[`-${footer}`]});
  const desired={path:settings,content:JSON.stringify({extensions:['palette.ts']}),mode:0o600};
  assert.deepEqual(JSON.parse(preserveLegacyFooterExclusion(desired,()=>{}).content).extensions,[`-${footer}`,'palette.ts']);
  assert.equal(fs.readFileSync(footer,'utf8'),'user-owned footer');
  fs.unlinkSync(footer);
  assert.deepEqual(JSON.parse(preserveLegacyFooterExclusion(desired,()=>{}).content).extensions,['palette.ts']);
});
