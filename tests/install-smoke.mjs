import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {run,readJson,writeJson,sha256} from '../lib/system.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'pi-config-smoke-'));
const root=path.join(temporary,'platform with spaces'),agentDir=path.join(temporary,'agent'),binDir=path.join(temporary,'bin');
const args=[path.join(repo,'install.mjs'),'--root',root,'--agent-dir',agentDir,'--bin-dir',binDir,'--no-path'];
await run(process.execPath,args,{timeout:1800000});
await run(process.execPath,[path.join(root,'bin/launch.mjs'),'main','--version']);
await run(process.execPath,[path.join(root,'bin/launch.mjs'),'models']);
// pi-doctor báo lỗi khi searchRouting.providers có provider ngoài webSearch.allowedProviders (pi-web-access sẽ không nạp).
const webSearchPath=path.join(agentDir,'web-search.json'),webSearchBytes=fs.readFileSync(webSearchPath);
const mismatched=readJson(webSearchPath);mismatched.searchRouting.providers.push('parallel-mcp');writeJson(webSearchPath,mismatched);
const doctor=spawnSync(process.execPath,[path.join(root,'bin/launch.mjs'),'doctor'],{encoding:'utf8'});
fs.writeFileSync(webSearchPath,webSearchBytes);
assert.equal(doctor.status,1,doctor.stdout+doctor.stderr);
assert.match(doctor.stderr,/parallel-mcp có trong searchRouting\.providers nhưng không có trong webSearch\.allowedProviders/u);
await run(process.execPath,['--test',...['patches','models','glm-wire','native-search-wire','claude-effort-wire','rewind-session','subagent-markdown'].map(name=>path.join(repo,`tests/${name}.test.mjs`))],{env:{...process.env,PI_CONFIG_TEST_ROOT:root}});
for(const profile of ['main'])await run(process.execPath,[path.join(repo,'tests/profile-integration.mjs'),root,profile]);
for(const profile of ['main'])await run(process.execPath,[path.join(repo,'tests/agent-integration.mjs'),root,profile]);
// Cài lại gộp ba chiều file JSON cấu hình: base là mặc định lần cài trước, lưu riêng trong <root>/state/defaults.
const defaultsOf=file=>path.join(root,'state','defaults',`${sha256(file).slice(0,24)}.json`);
const settingsPath=path.join(agentDir,'settings.json'),settingsBase=defaultsOf(settingsPath);
assert.deepEqual(readJson(settingsBase),readJson(settingsPath));
const settings=readJson(settingsPath),base=readJson(settingsBase);
// Pi ghi lại settings.json khi người dùng đổi theme/model (không có newline cuối); người dùng thêm một luật deny.
Object.assign(settings,{theme:'rose-pine-dawn',defaultProvider:'openai-codex',defaultModel:'gpt-6-sol'});
settings.permissions.deny.push('Path(~/notes/private/**)');
// Mặc định của bản cũ hơn: chưa có luật deny ~/.gnupg/**, keepRecentTokens 10000 và một khóa nay đã bỏ; người dùng
// chưa đổi các mục này. defaultModel cũ khác cả giá trị người dùng lẫn mặc định mới: xung đột, giữ của người dùng.
const gnupg='Path(~/.gnupg/**)';
for(const value of [settings,base]){
  value.permissions.deny=value.permissions.deny.filter(rule=>rule!==gnupg);
  value.compaction.keepRecentTokens=10000;value.retiredSetting=true;
}
base.defaultModel='claude-opus-5';
fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2));writeJson(settingsBase,base);
// Bản cài trước khi có base: open-tui.json người dùng đã sửa được gộp cộng dồn.
const openTuiPath=path.join(agentDir,'open-tui.json');fs.rmSync(defaultsOf(openTuiPath));
const openTui=readJson(openTuiPath);openTui.fullscreen.wheelScrollLines=8;delete openTui.thinkingPeek;writeJson(openTuiPath,openTui);
const statePath=path.join(root,'install-state.json'),prior=readJson(statePath);
const unused=path.join(root,'assets/unused-resource.json');
writeJson(unused,{fixture:'managed resource'});prior.files[unused]=sha256(fs.readFileSync(unused));
const custom=path.join(root,'profiles/background/optional.json');
writeJson(custom,{fixture:'default'});prior.files[custom]=sha256(fs.readFileSync(custom));
writeJson(custom,{fixture:'user edit'});writeJson(statePath,prior);
const secret=path.join(root,'secrets/provider.env');
fs.mkdirSync(path.dirname(secret),{recursive:true});fs.writeFileSync(secret,'PROVIDER_API_KEY=synthetic-preservation-fixture\n',{mode:0o600});
const secretBefore=fs.readFileSync(secret);
const auth=path.join(agentDir,'auth.json');const authBefore=fs.readFileSync(auth);
function install(){
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:1800000});
  process.stdout.write(result.stdout ?? '');process.stderr.write(result.stderr ?? '');
  assert.equal(result.status,0,'Cài lại thất bại');
  return result.stdout;
}
const reinstall=install();
const merged=readJson(settingsPath);
assert.deepEqual([merged.theme,merged.defaultProvider,merged.defaultModel],['rose-pine-dawn','openai-codex','gpt-6-sol']);
assert.ok(merged.permissions.deny.includes('Path(~/notes/private/**)'));
assert.ok(merged.permissions.deny.includes(gnupg),'luật deny mới của mặc định vào được file người dùng đã sửa');
assert.equal(merged.compaction.keepRecentTokens,20000);
assert.equal(merged.retiredSetting,undefined);
assert.ok(merged.extensions.at(-1).endsWith('pi-auto-mode'));
const settingsDefault=readJson(settingsBase);
assert.deepEqual([settingsDefault.defaultModel,settingsDefault.compaction.keepRecentTokens,settingsDefault.permissions.deny.includes(gnupg)],['claude-opus-5-5',20000,true]);
assert.ok(reinstall.includes(`Đã gộp mặc định mới vào ${settingsPath}, giữ phần bạn đã sửa:`),reinstall);
assert.ok(reinstall.includes(`  - thêm vào permissions.deny: ${gnupg}`),reinstall);
assert.ok(reinstall.includes('  - xung đột: giữ giá trị của bạn cho defaultModel; mặc định mới là "claude-opus-5-5"'),reinstall);
const tui=readJson(openTuiPath);
assert.deepEqual([tui.fullscreen.wheelScrollLines,tui.thinkingPeek],[8,{lines:0}]);
assert.ok(reinstall.includes('  - xung đột: giữ giá trị hiện có cho fullscreen.wheelScrollLines; mặc định mới là 4'),reinstall);
assert.ok(fs.existsSync(defaultsOf(openTuiPath)));
assert.equal(fs.existsSync(unused),false);
assert.equal(readJson(custom).fixture,'user edit');
assert.deepEqual(fs.readFileSync(secret),secretBefore);
await run(process.execPath,[path.join(repo,'tests/agent-integration.mjs'),root,'main']);
assert.deepEqual(fs.readFileSync(auth),authBefore);
// Lần cài thứ ba không có gì mới: không ghi file cấu hình, base hay backup, không báo gộp.
function snapshot(){
  const files={};
  const walk=dir=>{if(fs.existsSync(dir))for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())walk(file);else files[file]=[sha256(fs.readFileSync(file)),fs.statSync(file).mtimeMs];
  }};
  for(const dir of [agentDir,path.join(root,'config'),path.join(root,'state','defaults'),path.join(root,'backups')])walk(dir);
  return files;
}
const beforeThird=snapshot();
const third=install();
assert.deepEqual(snapshot(),beforeThird);
assert.doesNotMatch(third,/Đã gộp|Chưa có mặc định|xung đột|Giữ phần bạn đã sửa|Giữ nguyên các file/u);
const state=readJson(path.join(root,'install-state.json'));assert.equal(Object.keys(state.sources).length,3);
assert.equal(fs.existsSync(path.join(root,'.install.lock')),false);
console.log('PASS: cài sạch, một runtime Pi, slash workflows, auth/permission; cài lại gộp mặc định mới, giữ tùy chỉnh và secret giả; lần thứ ba không đổi gì.');
console.log(`Fixture: ${root}`);
if(process.env.GITHUB_ENV){
  fs.appendFileSync(process.env.GITHUB_ENV,`PI_CONFIG_SMOKE_ROOT=${root}\nPI_CONFIG_SMOKE_AGENT_DIR=${agentDir}\nPI_CONFIG_SMOKE_BIN_DIR=${binDir}\n`);
}
