import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {defaultsFile,localDefaults,mergesConfig,reconcileConfigFile,reconcileResources} from '../lib/resources.mjs';
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
test('settings defaults gain pi-permission-system denials and drop retired rules',t=>{
  // Bash(rm -rf *) của bản cài cũ (và của pi-permission-system) được bỏ: pi-auto-mode hỏi trước khi xoá đệ quy.
  const f=fixture(t),settings=path.join(f.root,'agent','settings.json');
  owned(f,'agent/extensions/pi-permission-system/config.json',{permission:{'*':'ask',mcpScript:'deny',path:{'*':'allow','/private/token.json':'deny','~/.ssh/*':'deny'},bash:{'*':'ask','git push*':'deny','rm -rf *':'deny'}}});
  const file=localDefaults({path:settings,content:JSON.stringify({extensions:['palette.ts'],permissions:{deny:['Bash(sudo *)','Bash(rm -rf *)']}}),mode:0o600});
  assert.deepEqual(JSON.parse(file.content).permissions.deny,['Bash(sudo *)','Path(/private/token.json)','Path(~/.ssh/*)','Bash(git push*)','mcpScript']);
  const other={path:path.join(f.root,'agent','models.json'),content:'{}',mode:0o600};
  assert.equal(localDefaults(other),other);
});
test('reinstalling settings without a stored default keeps exclusions, user denials and migrated rules',t=>{
  const f=fixture(t),settings=owned(f,'agent/settings.json',{extensions:['-/user/optional.ts','palette.ts'],permissions:{deny:['Path(/user/extra.key)','Bash(rm -rf *)']}});
  owned(f,'agent/extensions/pi-permission-system/config.json',{permission:{mcpScript:'deny',bash:{'git push*':'deny'}}});
  const content=localDefaults({path:settings,content:JSON.stringify({extensions:['palette.ts'],permissions:{deny:['Bash(sudo *)']}}),mode:0o600}).content;
  const before=fs.readFileSync(settings);
  // Chưa sửa từ lần cài trước (checksum khớp): mặc định mới, giữ loại trừ và luật deny như trước khi có base.
  const unedited=reconcileConfigFile({root:f.root,file:settings,content,recorded:f.state.files[settings]});
  assert.deepEqual(readJson(settings),{extensions:['-/user/optional.ts','palette.ts'],permissions:{deny:['Bash(sudo *)','Bash(git push*)','mcpScript','Path(/user/extra.key)']}});
  assert.deepEqual([unedited.written,unedited.changes,unedited.conflicts],[true,[],[]]);
  // Người dùng đã sửa và chưa có base: gộp cộng dồn, giữ thứ tự của người dùng.
  fs.writeFileSync(settings,before);fs.rmSync(defaultsFile(f.root,settings));
  const edited=reconcileConfigFile({root:f.root,file:settings,content,recorded:'edited'});
  assert.deepEqual(readJson(settings).permissions.deny,['Path(/user/extra.key)','Bash(sudo *)','Bash(git push*)','mcpScript']);
  assert.deepEqual(readJson(settings).extensions,['-/user/optional.ts','palette.ts']);
  assert.equal(edited.additive,true);
});
test('managed JSON keeps a private default copy, merges edits and is idempotent',t=>{
  const f=fixture(t),file=path.join(f.agentDir,'web-search.json'),backups=[];
  const backup=target=>backups.push(fs.readFileSync(target,'utf8'));
  const version=providers=>JSON.stringify({searchRouting:{providers},fetch:true},null,2)+'\n';
  const first=reconcileConfigFile({root:f.root,file,content:version(['openai','exa']),backup});
  const base=defaultsFile(f.root,file);
  assert.equal(path.dirname(base),path.join(f.root,'state','defaults'));
  assert.match(path.basename(base),/^[a-f0-9]{24}\.json$/u);
  assert.equal(fs.readFileSync(base,'utf8'),version(['openai','exa']));
  if(process.platform!=='win32')for(const target of [file,base])assert.equal(fs.statSync(target).mode&0o777,0o600);
  assert.deepEqual([first.written,first.recorded],[true,sha256(fs.readFileSync(file))]);
  // Pi/người dùng đổi một giá trị; bản mới đổi giá trị khác: gộp, backup bản cũ, cập nhật base.
  writeJson(file,{searchRouting:{providers:['openai','exa']},fetch:false});
  const merged=reconcileConfigFile({root:f.root,file,content:version(['openai','anthropic','exa']),backup});
  assert.deepEqual(readJson(file),{searchRouting:{providers:['openai','anthropic','exa']},fetch:false});
  assert.equal(backups.length,1);assert.deepEqual(merged.conflicts,[]);
  // Checksum ghi nhận là của mặc định mới: file còn phần người dùng sửa không khớp, vẫn là "đã sửa".
  assert.equal(merged.recorded,sha256(version(['openai','anthropic','exa'])));
  assert.notEqual(merged.recorded,sha256(fs.readFileSync(file)));
  assert.equal(fs.readFileSync(base,'utf8'),version(['openai','anthropic','exa']));
  // Người dùng đổi giá trị bản mới cũng đổi: giữ của người dùng, báo xung đột.
  writeJson(file,{searchRouting:{providers:['exa']},fetch:false});
  const conflict=reconcileConfigFile({root:f.root,file,content:version(['anthropic']),backup});
  assert.deepEqual([conflict.written,readJson(file).searchRouting.providers],[false,['exa']]);
  assert.deepEqual(conflict.conflicts,[{path:['searchRouting','providers'],current:['exa'],next:['anthropic']}]);
  // Chạy lại khi không có gì đổi: không ghi file, không ghi base, không báo.
  const stamp=target=>[fs.readFileSync(target,'utf8'),fs.statSync(target).mtimeMs];
  const snapshot=[stamp(file),stamp(base)];
  const again=reconcileConfigFile({root:f.root,file,content:version(['anthropic']),backup});
  assert.deepEqual([again.written,again.changes,again.conflicts,backups.length],[false,[],[],1]);
  assert.deepEqual([stamp(file),stamp(base)],snapshot);
});
test('a merged file that still has user edits stays "edited" when its default copy is lost or the installer stops managing it',t=>{
  const f=fixture(t),file=path.join(f.agentDir,'web-search.json');
  const version=providers=>JSON.stringify({searchRouting:{providers},fetch:true},null,2)+'\n';
  f.state.files[file]=reconcileConfigFile({root:f.root,file,content:version(['openai'])}).recorded;
  writeJson(file,{searchRouting:{providers:['openai']},fetch:false});
  f.state.files[file]=reconcileConfigFile({root:f.root,file,content:version(['openai','exa']),recorded:f.state.files[file]}).recorded;
  assert.deepEqual(readJson(file),{searchRouting:{providers:['openai','exa']},fetch:false});
  // Mất base (xóa <root>/state/defaults): checksum ghi nhận không khớp file, nên gộp cộng dồn thay vì ghi đè bằng mặc định.
  fs.rmSync(defaultsFile(f.root,file));
  const again=reconcileConfigFile({root:f.root,file,content:version(['openai','exa']),recorded:f.state.files[file]});
  assert.equal(again.additive,true);
  assert.equal(readJson(file).fetch,false);
  // Bản sau không còn quản lý file này: file có phần người dùng sửa được giữ, không bị lưu trữ.
  const result=reconcileResources(f);
  assert.deepEqual([result.archived,result.preserved],[[],[file]]);
  assert.equal(readJson(file).fetch,false);
});
test('managed JSON that is invalid or was never written by the installer is kept untouched; symlinks are refused',t=>{
  const f=fixture(t),file=path.join(f.agentDir,'mcp.json');
  fs.mkdirSync(f.agentDir,{recursive:true});fs.writeFileSync(file,'{"mcpServers": ');
  const result=reconcileConfigFile({root:f.root,file,content:'{}\n',recorded:'installed earlier'});
  assert.equal(result.preserved,'invalid');assert.equal(fs.readFileSync(file,'utf8'),'{"mcpServers": ');
  assert.equal(fs.existsSync(defaultsFile(f.root,file)),false);
  // File có sẵn trước khi cài (installer chưa từng ghi): giữ nguyên như file người dùng tự tạo.
  writeJson(file,{mcpServers:{mine:{command:'x'}}});
  assert.equal(reconcileConfigFile({root:f.root,file,content:'{"settings":{}}\n'}).preserved,'foreign');
  assert.deepEqual(readJson(file),{mcpServers:{mine:{command:'x'}}});
  assert.equal(fs.existsSync(defaultsFile(f.root,file)),false);
  if(process.platform!=='win32'){
    const link=path.join(f.agentDir,'models.json');fs.symlinkSync(file,link);
    assert.throws(()=>reconcileConfigFile({root:f.root,file:link,content:'{}\n'}),/symlink/u);
  }
});
test('only JSON files in the agent directory and <root>/config, and role files, are merged',t=>{
  const f=fixture(t),options={root:f.root,agentDir:f.agentDir};
  assert.equal(mergesConfig(path.join(f.agentDir,'settings.json'),options),true);
  assert.equal(mergesConfig(path.join(f.root,'config','pi-lens.json'),options),true);
  assert.equal(mergesConfig(path.join(f.agentDir,'agents','worker.md'),options),true);
  assert.equal(mergesConfig(path.join(f.agentDir,'agents','nested','worker.md'),options),false);
  assert.equal(mergesConfig(path.join(f.agentDir,'AGENTS.md'),options),false);
  assert.equal(mergesConfig(path.join(f.root,'profiles.json'),options),false);
  assert.equal(mergesConfig(path.join(f.root,'assets','configs','goal.json'),options),false);
});
test('role files keep their own default copy; a model edit no longer freezes the prompt',t=>{
  const f=fixture(t),file=path.join(f.agentDir,'agents','worker.md');
  const role=(model,prompt)=>`---\nname: worker\ndescription: Viết code.\nmodel: ${model}\nthinking: max\n---\n\n${prompt}\n`;
  const first=reconcileConfigFile({root:f.root,file,content:role('openai-codex/gpt-6-sol','Prompt v1.')});
  assert.equal(first.written,true);
  assert.equal(path.extname(defaultsFile(f.root,file)),'.md');
  assert.equal(fs.readFileSync(defaultsFile(f.root,file),'utf8'),role('openai-codex/gpt-6-sol','Prompt v1.'));
  // Người dùng đổi model trong file role; bản mới đổi prompt: prompt mới vào, model của người dùng được giữ.
  fs.writeFileSync(file,role('anthropic/claude-opus-5-5','Prompt v1.'));
  const merged=reconcileConfigFile({root:f.root,file,content:role('openai-codex/gpt-6-sol','Prompt v2.'),recorded:first.recorded});
  assert.equal(fs.readFileSync(file,'utf8'),role('anthropic/claude-opus-5-5','Prompt v2.'));
  assert.deepEqual([merged.written,merged.conflicts],[true,[]]);
  // Frontmatter không đọc được: giữ nguyên file như trước.
  fs.writeFileSync(file,'Không còn frontmatter\n');
  assert.equal(reconcileConfigFile({root:f.root,file,content:role('openai-codex/gpt-6-sol','Prompt v3.'),recorded:merged.recorded}).preserved,'invalid');
  assert.equal(fs.readFileSync(file,'utf8'),'Không còn frontmatter\n');
});
