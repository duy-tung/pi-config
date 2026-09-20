import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {preserveLocalControls,reconcileResources} from '../lib/resources.mjs';
import {writeJson,readJson,sha256} from '../lib/system.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-resources-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,agentDir:path.join(root,'agent'),binDir:path.join(root,'commands'),state:{files:{}},wanted:new Set(),log:()=>{}};
}
function owned(f,relative,value={fixture:'original'}) {
  const file=path.join(f.root,relative);writeJson(file,value);
  f.state.files[file]=sha256(fs.readFileSync(file));return file;
}
test('reconciliation archives unreferenced owned resources and preserves user data',t=>{
  const f=fixture(t);
  const unused=owned(f,'assets/unused.json'),custom=owned(f,'agent/optional.json');
  const active=owned(f,'agent/settings.json',{theme:'rose-pine'});
  const auth=owned(f,'agent/auth.json');
  writeJson(custom,{fixture:'user edit'});f.wanted.add(active);
  const result=reconcileResources(f);
  assert.deepEqual(result.archived,[unused]);assert.deepEqual(result.preserved,[custom]);
  assert.equal(readJson(custom).fixture,'user edit');assert.ok(fs.existsSync(auth)&&fs.existsSync(active));
  assert.equal(reconcileResources(f).archived.length,0);
});
test('an explicitly referenced extension retains its companion resources',t=>{
  const f=fixture(t),entry=owned(f,'assets/extra/index.ts'),helper=owned(f,'assets/extra/helper.ts');
  const settings=owned(f,'agent/settings.json',{extensions:[entry]});f.wanted.add(settings);
  const result=reconcileResources(f);
  assert.equal(result.archived.length,0);assert.ok(fs.existsSync(entry)&&fs.existsSync(helper));
  f.wanted.add(entry);fs.writeFileSync(entry,'user customized extension');
  assert.equal(reconcileResources(f).archived.length,0);assert.ok(fs.existsSync(helper));
});
test('registry entries outside managed directories cannot be removed',t=>{
  const f=fixture(t),outside=owned(f,'personal-note.json');
  reconcileResources(f);assert.ok(fs.existsSync(outside));
});
test('updating settings preserves extension exclusions and path denials',t=>{
  const f=fixture(t),settings=owned(f,'agent/settings.json',{extensions:['-/user/optional.ts']});
  let file=preserveLocalControls({path:settings,content:JSON.stringify({extensions:['palette.ts']}),mode:0o600});
  assert.deepEqual(JSON.parse(file.content).extensions,['-/user/optional.ts','palette.ts']);
  const policy=owned(f,'agent/extensions/pi-permission-system/config.json',{permission:{path:{'*':'allow','/private/token.json':'deny'}}});
  file=preserveLocalControls({path:policy,content:JSON.stringify({permission:{path:{'*':'allow'}}}),mode:0o600});
  assert.equal(JSON.parse(file.content).permission.path['/private/token.json'],'deny');
});
