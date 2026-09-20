import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {retireDispatcher} from '../lib/retire-dispatcher.mjs';
import {writeJson, readJson, sha256} from '../lib/system.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-retire-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const agentDir=path.join(root,'agent'), entry=path.join(root,'assets/extensions/pi-dispatch-router/index.ts');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'old dispatcher');
  const settings=path.join(agentDir,'settings.json');
  const original={theme:'rose-pine-moon',extensions:[entry,'user-extension.ts']};
  writeJson(settings,original);
  const state={files:{[entry]:sha256(fs.readFileSync(entry)),[settings]:sha256(fs.readFileSync(settings))}};
  return {root,agentDir,entry,settings,state,log:()=>{}};
}
test('retirement preserves a customized theme and leaves it classified as user-edited',t=>{
  const f=fixture(t),priorHash=f.state.files[f.settings];
  writeJson(f.settings,{...readJson(f.settings),theme:'custom-theme'});
  retireDispatcher(f);
  assert.deepEqual(readJson(f.settings),{theme:'custom-theme',extensions:['user-extension.ts']});
  assert.equal(f.state.files[f.settings],priorHash);
  assert.equal(fs.existsSync(f.entry),false);
  const archives=fs.readdirSync(path.join(f.root,'backups'));
  assert.equal(archives.length,1);
  assert.equal(readJson(path.join(f.root,'backups',archives[0],'profiles/main/settings.json')).theme,'custom-theme');
  retireDispatcher(f);
  assert.deepEqual(fs.readdirSync(path.join(f.root,'backups')),archives);
});
test('unresolved writer locks prevent all migration mutations',t=>{
  const f=fixture(t),before=fs.readFileSync(f.settings);
  const locks=path.join(f.root,'state/routing-writers');fs.mkdirSync(locks,{recursive:true});
  fs.writeFileSync(path.join(locks,'active.lock'),'fixture lock');
  assert.throws(()=>retireDispatcher(f),/writer lock/);
  assert.deepEqual(fs.readFileSync(f.settings),before);
  assert.equal(fs.existsSync(f.entry),true);assert.equal(fs.existsSync(path.join(f.root,'backups')),false);
});
test('installer does not retire an unowned dispatcher directory',t=>{
  const f=fixture(t),before=fs.readFileSync(f.settings);f.state.files={};
  retireDispatcher(f);
  assert.deepEqual(fs.readFileSync(f.settings),before);assert.equal(fs.existsSync(f.entry),true);
});
