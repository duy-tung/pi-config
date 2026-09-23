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
test('relative paths, local package references and patterns preserve configured resources',t=>{
  const f=fixture(t),entry=owned(f,'assets/extra/index.ts'),helper=owned(f,'assets/extra/helper.ts');
  const localPackage=owned(f,'assets/package/index.ts');
  const prompt=owned(f,'agent/prompts/custom.md'),theme=owned(f,'agent/themes/custom.json');
  const settings=owned(f,'agent/settings.json',{
    extensions:['../assets/extra/index.ts'],
    packages:[{source:'../assets/package'}],
    prompts:['prompts/*.md'],themes:['themes/*.json'],
  });f.wanted.add(settings);
  const result=reconcileResources(f);
  assert.equal(result.archived.length,0);
  for(const file of [entry,helper,localPackage,prompt,theme])assert.ok(fs.existsSync(file));
});
test('registry entries outside managed directories cannot be removed',t=>{
  const f=fixture(t),outside=owned(f,'personal-note.json');
  reconcileResources(f);assert.ok(fs.existsSync(outside));
});
test('resources remain recoverable when install directories use different volumes',t=>{
  const f=fixture(t),file=owned(f,'agent/optional.json');
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{
    if(from===file)throw Object.assign(new Error('Different volumes'),{code:'EXDEV'});
    return rename(from,to);
  };
  try {
    const result=reconcileResources(f);
    assert.deepEqual(result.archived,[file]);assert.equal(fs.existsSync(file),false);
    const saved=fs.readdirSync(result.archive,{recursive:true}).filter(name=>path.basename(name)==='optional.json');
    assert.equal(saved.length,1);assert.equal(readJson(path.join(result.archive,saved[0])).fixture,'original');
  } finally {fs.renameSync=rename;}
});
test('updating settings preserves extension exclusions and deny rules, migrating pi-permission-system denials',t=>{
  const f=fixture(t),settings=owned(f,'agent/settings.json',{extensions:['-/user/optional.ts'],permissions:{deny:['Path(/user/extra.key)']}});
  owned(f,'agent/extensions/pi-permission-system/config.json',{permission:{'*':'ask',mcpScript:'deny',path:{'*':'allow','/private/token.json':'deny','~/.ssh/*':'deny'},bash:{'*':'ask','git push*':'deny'}}});
  const file=preserveLocalControls({path:settings,content:JSON.stringify({extensions:['palette.ts'],permissions:{deny:['Bash(sudo *)']}}),mode:0o600});
  const next=JSON.parse(file.content);
  assert.deepEqual(next.extensions,['-/user/optional.ts','palette.ts']);
  assert.deepEqual(next.permissions.deny,['Bash(sudo *)','Path(/user/extra.key)','Path(/private/token.json)','Path(~/.ssh/*)','Bash(git push*)','mcpScript']);
  const other=preserveLocalControls({path:path.join(f.root,'agent','models.json'),content:'{}',mode:0o600});
  assert.equal(other.content,'{}');
});
