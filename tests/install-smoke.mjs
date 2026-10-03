import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {run,npmTimeout,readJson,writeJson,sha256} from '../lib/system.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'pi-config-smoke-'));
const root=path.join(temporary,'platform with spaces'),agentDir=path.join(temporary,'agent'),binDir=path.join(temporary,'bin');
const args=[path.join(repo,'install.mjs'),'--root',root,'--agent-dir',agentDir,'--bin-dir',binDir,'--no-path'];
// Lần cài đầu chạy npm ci cho runtime và Firecrawl, mỗi lần tối đa npmTimeout() (registry chậm trên runner Windows).
await run(process.execPath,args,{timeout:2*npmTimeout()+600000});
await run(process.execPath,[path.join(root,'bin/launch.mjs'),'main','--version']);
// Launcher trong bin-dir chạy được; Node ghim trong launcher bị gỡ thì báo cách sửa thay vì lỗi "not found".
{
  const windows=process.platform==='win32';
  const launcherPath=path.join(binDir,windows?'pi.cmd':'pi');
  const exec=file=>windows?spawnSync('cmd.exe',['/d','/c',file,'--version'],{encoding:'utf8'}):spawnSync(file,['--version'],{encoding:'utf8'});
  const ok=exec(launcherPath);
  assert.equal(ok.status,0,ok.stdout+ok.stderr);
  const broken=path.join(temporary,windows?'broken.cmd':'broken');
  fs.writeFileSync(broken,fs.readFileSync(launcherPath,'utf8').replaceAll(process.execPath,path.join(temporary,'gone','node'+(windows?'.exe':''))),{mode:0o755});
  const gone=exec(broken);
  assert.equal(gone.status,windows?9009:127,gone.stdout+gone.stderr);
  assert.match(gone.stderr,windows?/Node not found at .*Run install\.ps1 again/u:/không thấy Node tại .*Chạy lại installer/u);
}
// Cài mới tạo model-roles.json (thuộc về người dùng) chưa có ghi đè.
const modelRolesPath=path.join(agentDir,'model-roles.json');
assert.deepEqual(readJson(modelRolesPath),{roles:{}});
// pi-doctor báo lỗi khi searchRouting.providers có provider ngoài webSearch.allowedProviders (pi-web-access sẽ không nạp).
const webSearchPath=path.join(agentDir,'web-search.json'),webSearchBytes=fs.readFileSync(webSearchPath);
const mismatched=readJson(webSearchPath);mismatched.searchRouting.providers.push('parallel-mcp');writeJson(webSearchPath,mismatched);
const doctor=spawnSync(process.execPath,[path.join(root,'bin/launch.mjs'),'doctor'],{encoding:'utf8'});
fs.writeFileSync(webSearchPath,webSearchBytes);
assert.equal(doctor.status,1,doctor.stdout+doctor.stderr);
assert.match(doctor.stderr,/parallel-mcp có trong searchRouting\.providers nhưng không có trong webSearch\.allowedProviders/u);
// Thiếu package trong runtime: doctor báo từng package bằng một dòng, không ném ENOENT.
const advisorDir=path.join(root,'runtimes','current','node_modules','pi-advisor-flow'),advisorAside=`${advisorDir}.aside`;
fs.renameSync(advisorDir,advisorAside);
const missing=spawnSync(process.execPath,[path.join(root,'bin/launch.mjs'),'doctor'],{encoding:'utf8'});
fs.renameSync(advisorAside,advisorDir);
assert.equal(missing.status,1,missing.stdout+missing.stderr);
assert.match(missing.stderr,/^current\/pi-advisor-flow: chưa cài \(thiếu /mu);
assert.doesNotMatch(missing.stderr,/ENOENT|at file:/u);
await run(process.execPath,['--test',...['extensions-typecheck','models','glm-wire','native-search-wire','claude-effort-wire','rewind-session','subagent-markdown','patched-typecheck','model-roles','models-command'].map(name=>path.join(repo,`tests/${name}.test.mjs`))],{env:{...process.env,PI_CONFIG_TEST_ROOT:root}});
await run(process.execPath,[path.join(repo,'tests/config-integration.mjs'),root]);
await run(process.execPath,[path.join(repo,'tests/agent-integration.mjs'),root]);
// Cài lại gộp ba chiều file JSON cấu hình: base là mặc định lần cài trước, lưu riêng trong <root>/state/defaults.
const defaultsOf=file=>path.join(root,'state','defaults',`${sha256(file).slice(0,24)}${path.extname(file)}`);
const settingsPath=path.join(agentDir,'settings.json'),settingsBase=defaultsOf(settingsPath);
assert.deepEqual(readJson(settingsBase),readJson(settingsPath));
const settings=readJson(settingsPath),base=readJson(settingsBase);
// Pi ghi lại settings.json khi người dùng đổi theme/model (không có newline cuối); người dùng thêm một luật deny.
Object.assign(settings,{theme:'rose-pine-dawn',defaultProvider:'openai-codex',defaultModel:'gpt-6.1-sol'});
settings.permissions.deny.push('Path(~/notes/private/**)');
// Mặc định của bản cũ hơn: chưa có luật deny ~/.gnupg/**, Esc Esc mở /tree, còn compaction và defaultProjectTrust (nay
// bỏ vì trùng mặc định của Pi). Người dùng chưa đổi các mục này nên nhận mặc định mới, khóa đã bỏ thì bỏ theo; riêng
// defaultProjectTrust người dùng đã đổi nên được giữ. defaultModel cũ khác cả giá trị người dùng lẫn mặc định mới:
// xung đột, giữ của người dùng.
const gnupg='Path(~/.gnupg/**)';
for(const value of [settings,base]){
  value.permissions.deny=value.permissions.deny.filter(rule=>rule!==gnupg);
  Object.assign(value,{doubleEscapeAction:'tree',compaction:{enabled:true,keepRecentTokens:10000},defaultProjectTrust:'ask'});
}
settings.defaultProjectTrust='always';
base.defaultModel='claude-opus-5';
fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2));writeJson(settingsBase,base);
// Bản cài trước khi có base: open-tui.json người dùng đã sửa được gộp cộng dồn.
const openTuiPath=path.join(agentDir,'open-tui.json');fs.rmSync(defaultsOf(openTuiPath));
const openTui=readJson(openTuiPath);openTui.thinkingPeek.lines=2;delete openTui.cursorStyle;writeJson(openTuiPath,openTui);
const statePath=path.join(root,'install-state.json'),prior=readJson(statePath);
const unused=path.join(root,'assets/unused-resource.json');
writeJson(unused,{fixture:'managed resource'});prior.files[unused]=sha256(fs.readFileSync(unused));
// File cấu hình bản cũ ghi mà bản này không ghi nữa (pi-goal-x và role debugger đã gỡ): chưa sửa thì được lưu vào backups.
const retiredConfig=path.join(agentDir,'pi-goal-x-settings.json'),retiredRole=path.join(agentDir,'agents','debugger.md');
writeJson(retiredConfig,{maxAutonomousRuns:10,oracle:{enabled:true}});
fs.writeFileSync(retiredRole,fs.readFileSync(path.join(agentDir,'agents','worker.md'),'utf8').replace(/^name: worker$/mu,'name: debugger'));
for(const file of [retiredConfig,retiredRole])prior.files[file]=sha256(fs.readFileSync(file));
writeJson(statePath,prior);
const secret=path.join(root,'secrets/provider.env');
fs.mkdirSync(path.dirname(secret),{recursive:true});fs.writeFileSync(secret,'PROVIDER_API_KEY=synthetic-preservation-fixture\n',{mode:0o600});
const secretBefore=fs.readFileSync(secret);
const auth=path.join(agentDir,'auth.json');const authBefore=fs.readFileSync(auth);
function install(extra=[]){
  const result=spawnSync(process.execPath,[...args,...extra],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:1800000});
  process.stdout.write(result.stdout ?? '');process.stderr.write(result.stderr ?? '');
  assert.equal(result.status,0,'Cài lại thất bại');
  return result.stdout;
}
const reinstall=install();
const merged=readJson(settingsPath);
assert.deepEqual([merged.theme,merged.defaultProvider,merged.defaultModel],['rose-pine-dawn','openai-codex','gpt-6.1-sol']);
assert.ok(merged.permissions.deny.includes('Path(~/notes/private/**)'));
assert.ok(merged.permissions.deny.includes(gnupg),'luật deny mới của mặc định vào được file người dùng đã sửa');
assert.deepEqual([merged.doubleEscapeAction,merged.compaction,merged.defaultProjectTrust],['none',undefined,'always']);
assert.ok(merged.extensions.filter(entry=>!entry.startsWith('-')).at(-1).endsWith('pi-auto-mode'));
for(const name of ['mcp','codemode','tool-search'])assert.ok(merged.extensions.includes(`-builtin:${name}`),`thiếu -builtin:${name}`);
const settingsDefault=readJson(settingsBase);
assert.deepEqual([settingsDefault.defaultModel,settingsDefault.compaction,settingsDefault.permissions.deny.includes(gnupg)],['claude-opus-5-5',undefined,true]);
assert.ok(reinstall.includes(`Đã gộp mặc định mới vào ${settingsPath}, giữ phần bạn đã sửa:`),reinstall);
assert.ok(reinstall.includes(`  - thêm vào permissions.deny: ${gnupg}`),reinstall);
assert.ok(reinstall.includes('  - xung đột: giữ giá trị của bạn cho defaultModel; mặc định mới là "claude-opus-5-5"'),reinstall);
assert.ok(reinstall.includes('  - doubleEscapeAction: "tree" → "none"'),reinstall);
assert.ok(reinstall.includes('  - bỏ compaction (mặc định mới không còn khóa này)'),reinstall);
assert.ok(reinstall.includes('  - xung đột: giữ giá trị của bạn cho defaultProjectTrust; mặc định mới đã bỏ khóa này'),reinstall);
const tui=readJson(openTuiPath);
assert.deepEqual([tui.thinkingPeek.lines,tui.cursorStyle],[2,'bar']);
assert.ok(reinstall.includes('  - xung đột: giữ giá trị hiện có cho thinkingPeek.lines; mặc định mới là 0'),reinstall);
assert.ok(fs.existsSync(defaultsOf(openTuiPath)));
assert.equal(fs.existsSync(unused),false);
for(const [file,archived] of [[retiredConfig,'pi-goal-x-settings.json'],[retiredRole,path.join('agents','debugger.md')]]){
  assert.equal(fs.existsSync(file),false,file);
  assert.ok(!Object.hasOwn(readJson(statePath).files,file),file);
  assert.ok(fs.readdirSync(path.join(root,'backups')).some(name=>name.startsWith('resources-')&&fs.existsSync(path.join(root,'backups',name,'4',archived))),`${archived} nằm trong backups`);
}
assert.match(reinstall,/Đã lưu \d+ tài nguyên ngoài cấu hình hiện tại tại /u);
assert.deepEqual(fs.readFileSync(secret),secretBefore);
await run(process.execPath,[path.join(repo,'tests/agent-integration.mjs'),root]);
assert.deepEqual(fs.readFileSync(auth),authBefore);
// Ghi đè để chỉ dùng Claude trong model-roles.json: mọi file gốc nhận model mới; dòng tools người dùng sửa trong file
// role được giữ. Khóa preset cũ và ghi đè của vai đã gỡ (debugger) còn sót: installer và pi-doctor chỉ cảnh báo.
const claudeRoles={researcher:{model:'anthropic/claude-sonnet-5-5'},worker:{model:'anthropic/claude-opus-5-5',thinking:'high'},
  reviewer:{model:'anthropic/claude-fable-5-1'},advisor:{model:'anthropic/claude-fable-5-1'}};
writeJson(modelRolesPath,{preset:'claude',roles:{...claudeRoles,debugger:{thinking:'low'}}});
const workerPath=path.join(agentDir,'agents','worker.md');
fs.writeFileSync(workerPath,fs.readFileSync(workerPath,'utf8').replace(/^tools: .*$/mu,'tools: "read, grep, find, ls, bash"'));
const switched=install();
const frontmatter=role=>fs.readFileSync(path.join(agentDir,'agents',`${role}.md`),'utf8').split('\n---\n')[0];
for(const [role,model,thinking] of [['worker','claude-opus-5-5','high'],['researcher','claude-sonnet-5-5','max'],['reviewer','claude-fable-5-1','high']]){
  assert.match(frontmatter(role),new RegExp(`^model: anthropic/${model}\\nthinking: ${thinking}$`,'mu'),role);
}
assert.match(frontmatter('worker'),/^tools: "read, grep, find, ls, bash"$/mu);
assert.ok(switched.includes(`Đã gộp mặc định mới vào ${workerPath}, giữ phần bạn đã sửa:`),switched);
const advisorNow=readJson(path.join(agentDir,'advisor.json'));
assert.deepEqual([advisorNow.executor,advisorNow.advisor],['anthropic/claude-opus-5-5','anthropic/claude-fable-5-1']);
assert.deepEqual(readJson(settingsPath).enabledModels,['anthropic/claude-opus-5-5','anthropic/claude-fable-5-1','anthropic/claude-sonnet-5-5']);
const doctorModels=spawnSync(process.execPath,[path.join(root,'bin/launch.mjs'),'doctor'],{encoding:'utf8'});
assert.equal(doctorModels.status,0,doctorModels.stdout+doctorModels.stderr);
assert.match(doctorModels.stdout,/^mặc định \+ ghi đè \(/mu);
assert.doesNotMatch(doctorModels.stderr,/đang dùng/u,'không vai nào lệch');
assert.match(doctorModels.stderr,/model-roles\.json: roles: bỏ qua debugger \(vai đã gỡ khỏi pi-config\)/u);
assert.match(doctorModels.stderr,/model-roles\.json: bỏ qua "preset": "claude" \(preset đã gỡ khỏi pi-config/u);
assert.ok(!fs.existsSync(path.join(agentDir,'agents','debugger.md')));
// Model sai tên (pi-subagents sẽ lặng lẽ dùng model của parent): installer dừng trước khi ghi cấu hình.
writeJson(modelRolesPath,{roles:{...claudeRoles,worker:{model:'anthropic/claude-opus-5-6'}}});
const beforeFailure=snapshot();
const failed=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:1800000});
assert.notEqual(failed.status,0,failed.stdout);
assert.match(failed.stderr,/worker: không có model anthropic\/claude-opus-5-6 trong catalog của Pi/u);
assert.deepEqual(snapshot(),beforeFailure);
writeJson(modelRolesPath,{roles:claudeRoles});
// /model lưu Sonnet vào executor của advisor, /advisor-settings đổi số lượt: pi-doctor báo vai lệch và chỉ tới /models.
const advisorPath=path.join(agentDir,'advisor.json');
writeJson(advisorPath,{...readJson(advisorPath),executor:'anthropic/claude-sonnet-5-5',advisorMaxCallsPerSession:9});
const drifted=spawnSync(process.execPath,[path.join(root,'bin/launch.mjs'),'doctor'],{encoding:'utf8'});
assert.equal(drifted.status,0,drifted.stdout+drifted.stderr);
assert.match(drifted.stderr,/main đang dùng anthropic\/claude-sonnet-5-5 \(high\) theo advisor\.json, khác model-roles\.json \(anthropic\/claude-opus-5-5 \(high\)\)\. Trong \/models: /u);
assert.match(drifted.stdout,/tối đa 9 lần\/phiên/u);
// Lần cài cuối không có gì mới: không ghi file cấu hình, base hay backup, không báo gộp.
function snapshot(){
  const files={};
  const walk=dir=>{if(fs.existsSync(dir))for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())walk(file);else files[file]=[sha256(fs.readFileSync(file)),fs.statSync(file).mtimeMs];
  }};
  for(const dir of [agentDir,path.join(root,'state','defaults'),path.join(root,'backups')])walk(dir);
  return files;
}
// Nguồn không còn trong sources.lock.json (mattpocock-skills của bản cài cũ): lần cài
// sau chuyển thư mục vào backups và bỏ khỏi state.
const retiredSource=path.join(root,'sources','mattpocock-skills'),installState=path.join(root,'install-state.json');
fs.mkdirSync(path.join(retiredSource,'skills','engineering','tdd'),{recursive:true});
fs.writeFileSync(path.join(retiredSource,'skills','engineering','tdd','SKILL.md'),'---\nname: tdd\ndescription: old\n---\n');
writeJson(installState,{...readJson(installState),sources:{...readJson(installState).sources,'mattpocock-skills':'0'.repeat(64)}});
const retiring=install();
assert.match(retiring,/Nguồn mattpocock-skills không còn dùng: đã chuyển vào /u);
// Cài lại giữ giá trị đổi qua /model và /advisor-settings (gộp ba chiều).
assert.deepEqual([readJson(advisorPath).executor,readJson(advisorPath).advisorMaxCallsPerSession],['anthropic/claude-sonnet-5-5',9]);
assert.equal(fs.existsSync(retiredSource),false);
assert.ok(!Object.hasOwn(readJson(installState).sources,'mattpocock-skills'));
const beforeThird=snapshot();
const third=install();
assert.deepEqual(snapshot(),beforeThird);
assert.doesNotMatch(third,/Đã gộp|Chưa có mặc định|xung đột|Giữ phần bạn đã sửa|Giữ nguyên các file/u);
const state=readJson(path.join(root,'install-state.json'));assert.deepEqual(Object.keys(state.sources).sort(),['firecrawl-cli-source']);
// Không cài skill quy trình: Pi chỉ nạp skill Firecrawl.
assert.ok(!fs.existsSync(path.join(root,'assets','skills')));
assert.ok(readJson(path.join(agentDir,'settings.json')).skills.every(entry=>entry.includes(path.join('sources','firecrawl-'))));
assert.equal(fs.existsSync(path.join(root,'.install.lock')),false);
console.log('PASS: cài sạch, một runtime Pi, skill Firecrawl, auth/permission, type của bản vá; cài lại gộp mặc định mới, giữ tùy chỉnh và secret giả; model-roles.json: ghi đè chỉ dùng Claude, bỏ qua khóa preset cũ, chặn model sai tên, báo vai lệch; bỏ nguồn skills cũ; lần cuối không đổi gì.');
console.log(`Fixture: ${root}`);
if(process.env.GITHUB_ENV){
  fs.appendFileSync(process.env.GITHUB_ENV,`PI_CONFIG_SMOKE_ROOT=${root}\nPI_CONFIG_SMOKE_AGENT_DIR=${agentDir}\nPI_CONFIG_SMOKE_BIN_DIR=${binDir}\n`);
}
