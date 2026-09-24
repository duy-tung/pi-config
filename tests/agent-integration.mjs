import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

// CLI: node tests/agent-integration.mjs <installRoot> <profile>
// Only installed configuration on the explicit root is used. The test copies
// a fixed whitelist into a disposable agent, never auth/history/cache/secrets.
const [installArg, profile] = process.argv.slice(2);
if (!installArg || !["main"].includes(profile)) {
  throw new Error("Cách dùng: node tests/agent-integration.mjs <installRoot> <main>");
}
let activePhase = "khởi tạo runtime";
const watchdog = setTimeout(() => {
  console.error(`TIMEOUT: ${profile}: ${activePhase}; giữ fixture để chẩn đoán.`);
  process.exit(124);
}, 120000);
const installRoot = path.resolve(installArg);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const configuration = readJson(path.join(installRoot, "profiles.json"))[profile];
assert.ok(configuration?.agentDir && configuration.runtime === "current");
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-config ${profile} integration `)));
const agentDir = path.join(fixture, "fixture agent");
const cwd = path.join(fixture, "fixture workspace");
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
for (const name of ["settings.json", "keybindings.json", "models.json", "advisor.json", "subagents.json", "mcp.json", "open-tui.json", "pi-goal-x-settings.json", "pi-usage.json"]) {
  if (fs.existsSync(path.join(configuration.agentDir, name))) fs.copyFileSync(path.join(configuration.agentDir, name), path.join(agentDir, name));
}
fs.mkdirSync(path.join(agentDir, "agents"));
for (const name of ["researcher", "worker", "debugger", "reviewer"]) {
  const role = fs.readFileSync(path.join(configuration.agentDir, "agents", `${name}.md`), "utf8");
  fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), role);
}
const settings = readJson(path.join(agentDir, "settings.json"));
settings.autoMode = { ...settings.autoMode, model: "config-test/parent", stateDir: path.join(fixture, "auto-mode") };
Object.assign(settings, {
  defaultProvider: "config-test", defaultModel: "parent", defaultThinkingLevel: "off",
  enabledModels: ["config-test/parent", "openai-codex/gpt-6-sol", "openai-codex/gpt-6-astra", "opencode-go/glm-5.3-flash"],
  // Cổng permission của bản cài nạp sau provider giả.
  extensions: [fileURLToPath(new URL("./agent-provider.ts", import.meta.url)),
    ...(settings.extensions ?? []).filter((entry) => typeof entry === "string" && entry.replaceAll("\\", "/").endsWith("/pi-auto-mode"))],
  compaction: { enabled: false }, retry: { enabled: false }, skills: [], cacheWarming: "off",
});
if (settings.rewind) settings.rewind.storageDir = path.join(fixture, "rewind");
writeJson(path.join(agentDir, "settings.json"), settings);
// Advisor luôn bật của bản cài, executor là model giả của parent thay cho Opus (fixture không có auth Claude).
const advisorFile = path.join(agentDir, "advisor.json");
writeJson(advisorFile, { ...readJson(advisorFile), executor: "config-test/parent" });
writeJson(path.join(agentDir, "auth.json"), {});
// Explicitly replace web config rather than copying a live credential command.
writeJson(path.join(agentDir, "web-search.json"), {
  provider: "firecrawl", workflow: "none", firecrawlApiKey: "fixture-never-used",
  allowBrowserCookies: false, searchRouting: { providers: ["firecrawl"], useCurrentModel: false },
  githubClone: { enabled: false },
});
writeJson(path.join(cwd, "package.json"), { name: "pi-config-integration-fixture", private: true, type: "module" });
fs.writeFileSync(path.join(cwd, "safe.txt"), "SAFE_CONTENT\n");
fs.writeFileSync(path.join(cwd, ".env"), "SYNTHETIC_SECRET=must-not-be-read\n");
let symlinkAvailable = true;
try { fs.symlinkSync(path.join(cwd, ".env"), path.join(cwd, "secret-alias.txt")); }
catch (error) { if (process.platform !== "win32") throw error; symlinkAvailable = false; }
const modules = path.join(installRoot, "runtimes", configuration.runtime, "node_modules");
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: agentDir, PI_WORKSPACE_DIR: cwd, PI_LENS_HOME: path.join(fixture, "lens-state"),
  PI_CONFIG_AUTH_PATH: path.join(agentDir, "auth.json"), PI_LENS_CONFIG_PATH: path.join(installRoot, "config", "pi-lens.json"),
  PI_LENS_DISABLE_LSP_INSTALL: "1", PI_LENS_DISABLE_TOOL_INSTALL: "1", PI_BG_DISABLE_UPDATE_CHECK: "1",
  FIRECRAWL_NO_SEARCH_FEEDBACK: "1", FIRECRAWL_NO_ENDPOINT_FEEDBACK: "1",
});
for (const key of Object.keys(process.env)) {
  if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN/u.test(key)) delete process.env[key];
}
const pathKey = process.platform === "win32" ? Object.keys(process.env).find((key) => key.toLowerCase() === "path") : "PATH";
const existingPath = process.env[pathKey] ?? "";
if (process.platform === "win32") for (const key of Object.keys(process.env)) if (key.toLowerCase() === "path") delete process.env[key];
process.env.PATH = [path.join(modules, ".bin"), path.join(installRoot, "runtimes", "current", "node_modules", ".bin"),
  ...(settings.shellPath ? [path.dirname(settings.shellPath)] : []), existingPath].join(path.delimiter);

// No test path has permission to call a paid service. Prevent unexpected HTTP
// traffic from extensions as well; MCP is a local stdio child, not a socket.
const networkAttempts = [];
const networkBlocked = () => { networkAttempts.push("blocked outbound request"); throw new Error("Network disabled in Pi integration fixture"); };
globalThis.fetch = async () => networkBlocked();
http.request = networkBlocked; http.get = networkBlocked;
https.request = networkBlocked; https.get = networkBlocked;
net.connect = networkBlocked; net.createConnection = networkBlocked;
net.Socket.prototype.connect = networkBlocked;
// Keep operating-system HOME intact. Guard credential file reads instead of
// changing a system variable; each extension still receives explicit temp paths.
const ensureSafeRead = (file) => {
  if (typeof file !== "string" && !(file instanceof URL)) return;
  const resolved = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
  const relative = path.relative(fixture, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  const normalized = resolved.replaceAll("\\", "/");
  if (/\/(?:auth\.json|\.?credentials\.json)$/u.test(normalized)
      || /\/(?:\.ssh|\.aws|secrets)\//u.test(normalized)) {
    throw new Error("Fixture refused credential read outside its temporary directory");
  }
};
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) { ensureSafeRead(file); return originalReadFileSync.call(this, file, ...args); };
const originalReadFile = fs.readFile;
fs.readFile = function (file, ...args) { ensureSafeRead(file); return originalReadFile.call(this, file, ...args); };
const originalReadFilePromise = fs.promises.readFile;
fs.promises.readFile = async function (file, ...args) { ensureSafeRead(file); return originalReadFilePromise.call(this, file, ...args); };
syncBuiltinESMExports();
const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
const control = { plans: {}, seen: [], classifier: [] };
globalThis[Symbol.for("pi-config:test")] = control;
const errors = [], prompts = [], notices = [], results = [];
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false });
const sessionManager = sdk.SessionManager.create(cwd, path.join(fixture, "sessions"));
const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, sessionManager });
// Automatic approvals are restricted to our isolated fixture and fake model.
const ui = {
  ...Object.fromEntries(["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"].map((key) => [key, () => {}])),
  onTerminalInput: () => () => {}, input: async () => undefined, editor: async () => undefined,
  getEditorComponent: () => undefined, getAllThemes: () => [], setTheme: () => ({ success: true }),
  theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, italic: (text) => text, dim: (text) => text },
  select: async (title, options) => { prompts.push({ kind: "select", title }); return options.find((option) => /^Allow once|^Approve once/u.test(option)) ?? options[0]; },
  confirm: async (title) => { prompts.push({ kind: "confirm", title }); return true; },
  notify: (message, type) => notices.push({ message, type }),
  custom: async () => { throw new Error("Unexpected TUI dialog in RPC fixture"); },
  getToolsExpanded: () => false, getEditorText: () => "", getTheme: () => undefined,
};
await session.bindExtensions({ uiContext: ui, mode: "rpc", onError: (error) => errors.push(error),
  commandContextActions: { waitForIdle: () => session.waitForIdle(), navigateTree: (id, options) => session.navigateTree(id, options) } });
await session.setModel(runtime.getModel("config-test", "parent"));
let sequence = 0;
const tool = (name, args) => ({ type: 'toolCall', id: `agent-${sequence++}`, name, arguments: args });
const final = text => [{type:'text',text}];
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const invocation = (id, extra={}) => ({subagent_type:'researcher',description:'Native Agent fixture',
  prompt:`CASE:child_${id} Đọc safe.txt và báo bằng chứng; chỉ làm phạm vi được giao.`,run_in_background:false,...extra});
async function run(id, args, childSteps=[final('CHILD_OK')]) {
  const parentKey=`parent_${id}`,childKey=`child_${id}`;
  control.plans[parentKey]=[[tool('Agent',args)],final('PARENT_ACCEPTED')];
  control.plans[childKey]=childSteps;control.fallbackKey=parentKey;
  const before=session.messages.length;
  await session.prompt(`CASE:${parentKey}`);
  await delay(50);
  return session.messages.slice(before).filter(m=>m.role==='toolResult');
}
async function check(name,fn) {
  activePhase=name;console.log(`Agent ${profile}: ${name}`);
  try {await fn();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',error:error.stack});}
}
await check('native delegation tools and four task roles are available',async()=>{
  const names=session.getAllTools().map(tool=>tool.name);
  assert.ok(names.includes('Agent'));
  for(const name of ['get_subagent_result','steer_subagent'])assert.ok(names.includes(name));
  assert.deepEqual(fs.readdirSync(path.join(agentDir,'agents')).sort(),['debugger.md','researcher.md','reviewer.md','worker.md']);
});
await check('researcher uses GLM/max and separate context',async()=>{
  const out=await run('sol',invocation('sol'),[[tool('read',{path:'safe.txt'})],final('CHILD_OK')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));
  const child=control.seen.filter(x=>x.key==='child_sol');assert.ok(child.length>0);
  assert.ok(child.every(x=>x.model==='glm-5.3-flash'&&x.options.reasoning==='max'));
  assert.ok(!JSON.stringify(child).includes('CASE:parent_sol'));
  assert.match(JSON.stringify(child.at(-1).messages),/SAFE_CONTENT/);
});
const configured={researcher:['glm-5.3-flash','max'],worker:['gpt-6-sol','max'],debugger:['gpt-6-sol','max'],reviewer:['gpt-6-astra','high']};
for(const role of ['researcher','worker','debugger','reviewer']) {
  await check(`native ${role} keeps its configured model/effort despite conflicting tool parameters`,async()=>{
    const id='configured-'+role;
    const [expectedModel,expectedEffort]=configured[role];
    const opposite=role==='researcher'?'openai-codex/gpt-6-sol':'opencode-go/glm-5.3-flash';
    const out=await run(id,invocation(id,{subagent_type:role,model:opposite,thinking:'off',inherit_context:true,isolated:true,max_turns:999}));
    assert.equal(out[0]?.isError,false,JSON.stringify(out));
    const seen=control.seen.filter(x=>x.key==='child_'+id);
    assert.ok(seen.length>0);assert.ok(seen.every(x=>x.model===expectedModel&&x.options.reasoning===expectedEffort));
    assert.ok(!JSON.stringify(seen).includes('CASE:parent_'+id));
  });
}
await check('researcher gets pi-web-access tools from its role',async()=>{
  await run('web',invocation('web'));
  const child=control.seen.filter(x=>x.key==='child_web');assert.ok(child.length>0);
  for(const name of ['web_search','fetch_content'])assert.ok(child[0].tools.includes(name),JSON.stringify(child[0].tools));
});
await check('Codex fast mode reaches worker/debugger requests, not the Astra reviewer',async()=>{
  for(const [role,tier] of [['worker','priority'],['debugger','priority'],['reviewer',undefined]]){
    const id='fast-'+role;
    const out=await run(id,invocation(id,{subagent_type:role}));
    assert.equal(out[0]?.isError,false,JSON.stringify(out));
    const seen=control.seen.filter(x=>x.key==='child_'+id);assert.ok(seen.length>0);
    assert.ok(seen.every(x=>x.payload?.service_tier===tier),`${role}: ${JSON.stringify(seen.map(x=>x.payload))}`);
  }
});
await check('worker has no turn limit',async()=>{
  const steps=Array.from({length:16},()=>[tool('read',{path:'safe.txt'})]);
  const out=await run('long',invocation('long',{subagent_type:'worker',max_turns:3}),[...steps,final('LONG_DONE')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));assert.match(JSON.stringify(out),/LONG_DONE/);
  assert.equal(control.seen.filter(x=>x.key==='child_long').length,17);
});
await check('GLM researcher remains read-only',async()=>{
  const out=await run('readonly',invocation('readonly',{subagent_type:'researcher'}),[[tool('write',{path:'forbidden.txt',content:'should-not-exist'})],final('BLOCKED')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));assert.equal(fs.existsSync(path.join(cwd,'forbidden.txt')),false);
  assert.ok(control.seen.filter(x=>x.key==='child_readonly').at(-1).messages.some(m=>m.role==='toolResult'&&m.isError));
});
await check('Sol worker retains permission gate even when isolated=true was requested',async()=>{
  const out=await run('permission',invocation('permission',{subagent_type:'worker',isolated:true}),
    [[tool('read',{path:'.env'})],[tool('bash',{command:'printf native-agent-permission-ok > gate-proof.txt',timeout:10})],final('CHECKED')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));
  const messages=control.seen.filter(x=>x.key==='child_permission').at(-1).messages;
  assert.ok(messages.some(m=>m.role==='toolResult'&&m.isError));
  assert.ok(!JSON.stringify(messages).includes('must-not-be-read'));
  assert.equal(fs.readFileSync(path.join(cwd,'gate-proof.txt'),'utf8'),'native-agent-permission-ok');
  const reviewed=control.seen.filter(x=>x.key==='classifier').map(x=>JSON.stringify(x.messages));
  assert.ok(reviewed.some(text=>text.includes('gate-proof.txt')&&text.includes('delegated_task')),'Child phải qua bộ phân loại của pi-auto-mode');
});
await check('Sol worker can make an authorized file edit',async()=>{
  const out=await run('write',invocation('write',{subagent_type:'worker'}),[[tool('write',{path:'result.txt',content:'NATIVE_WRITE_OK'})],final('DONE')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(cwd,'result.txt'),'utf8'),'NATIVE_WRITE_OK');
});
await check('unknown role is rejected without spawning a child',async()=>{
  const out=await run('unknown-role',invocation('unknown-role',{subagent_type:'undefined-agent'}));
  assert.ok(out.length>0);
  assert.ok(!control.seen.some(x=>x.key==='child_unknown-role'));
  assert.ok(!JSON.stringify(out).includes('CHILD_OK'));
});
await check('foreground completion returns inline without another parent generation',async()=>{
  const out=await run('completion',invocation('completion',{subagent_type:'worker'}));
  assert.equal(out[0]?.isError,false,JSON.stringify(out));assert.match(JSON.stringify(out),/CHILD_OK/);
  await delay(200);
  assert.equal(control.seen.filter(x=>x.key==='parent_completion').length,2);
  assert.equal(session.isStreaming,false);assert.equal(session.pendingMessageCount,0);
});
// Một prompt của parent theo kịch bản, không qua Agent; chờ cả lượt goal tự tiếp tục chạy xong.
async function turn(key, steps) {
  control.plans[key]=steps;control.fallbackKey=key;
  const before=session.messages.length;
  await session.prompt(`CASE:${key}`);
  await delay(50);
  const deadline=Date.now()+15000;
  while(session.isStreaming||session.pendingMessageCount>0){
    if(Date.now()>deadline)throw new Error('Fixture session did not settle within 15 seconds');
    await delay(50);
  }
  return session.messages.slice(before).filter(m=>m.role==='toolResult');
}
// Phần đầu request (system prompt và khai báo tool trước user message đầu tiên): đổi phần này thì mất prompt cache.
const head=entry=>{const first=entry.messages.findIndex(m=>m.role==='user');return JSON.stringify([entry.systemPrompt??null,entry.messages.slice(0,first<0?0:first)]);};
await check('advisor Astra/high is always on for the parent and a consultation keeps the system prompt',async()=>{
  assert.ok(session.getActiveToolNames().includes('ask_advisor'),'alwaysOn phải bật advisor khi mở phiên');
  control.plans.advisor=[final('Verdict: sound\n\nADVISOR_FIXTURE_OK')];
  const out=await turn('advisor-one',[[tool('ask_advisor',{})],final('DONE')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));assert.match(JSON.stringify(out),/ADVISOR_FIXTURE_OK/);
  await turn('advisor-two',[final('DONE')]);
  const advice=control.seen.filter(x=>x.key==='advisor');
  assert.equal(advice.length,1);assert.equal(advice[0].model,'gpt-6-astra');assert.equal(advice[0].options.reasoning,'high');
  const [one,two]=['advisor-one','advisor-two'].map(key=>head(control.seen.find(x=>x.key===key)));
  assert.equal(one,two,'System prompt không được đổi sau mỗi lần hỏi advisor');
  assert.match(one,/after two consecutive materially equivalent failed attempts/);
  assert.match(one,/Before declaring success, use ask_advisor/);
  assert.match(one,/Advisor calls are limited to 5 per session/);
  assert.doesNotMatch(one,/Before committing to a materially consequential plan/);
});
await check('goal auditor uses Astra/high and its bash passes the permission gate like a subagent',async()=>{
  control.plans.auditor=[[tool('bash',{command:'printf denied > audit-denied.txt',timeout:10})],
    [tool('bash',{command:'printf allowed > audit-allowed.txt',timeout:10})],final('Checked the workspace.\n<approved/>')];
  // Lệnh đầu bị bộ phân loại chặn (hai giai đoạn), lệnh sau được phép.
  control.classifier.push('<block>yes</block>','<block>yes</block><rule>Persistence</rule><reason>Fixture block.</reason>');
  const out=await turn('goal-audit',[[tool('create_goal',{objective:'Fixture goal: audit the workspace.'})],
    [tool('update_goal',{status:'complete',completion_summary:'Fixture work is done.'})],final('GOAL_DONE')]);
  assert.ok(out.length===2&&out.every(m=>!m.isError),JSON.stringify(out));
  assert.match(JSON.stringify(out),/Goal audit approved/);
  const audits=control.seen.filter(x=>x.key==='auditor');
  assert.equal(audits.length,3);
  assert.ok(audits.every(x=>x.model==='gpt-6-astra'&&x.options.reasoning==='high'));
  assert.ok(audits[0].tools.includes('bash'));
  assert.equal(fs.existsSync(path.join(cwd,'audit-denied.txt')),false);
  assert.equal(fs.readFileSync(path.join(cwd,'audit-allowed.txt'),'utf8'),'allowed');
  const reviewed=control.seen.filter(x=>x.key==='classifier').map(x=>JSON.stringify(x.messages));
  assert.ok(reviewed.some(text=>text.includes('audit-denied.txt')&&text.includes('delegated_task')),'Auditor phải qua bộ phân loại như phiên con');
  assert.ok(reviewed.some(text=>text.includes('audit-allowed.txt')));
});
await check('/advisor-off lasts into the next session; alwaysOn brings the advisor back',async()=>{
  await session.prompt('/advisor-off');
  assert.ok(!session.getActiveToolNames().includes('ask_advisor'));
  assert.equal(readJson(advisorFile).alwaysOn,false);
  // Pi bật mọi tool của extension khi mở phiên; bản vá đưa advisor về trạng thái tắt trừ khi alwaysOn.
  const toolsOfNewSession=async()=>{
    const freshLoader=new sdk.DefaultResourceLoader({cwd,agentDir});await freshLoader.reload();
    const {session:fresh}=await sdk.createAgentSession({cwd,agentDir,resourceLoader:freshLoader,modelRuntime:runtime,sessionManager:sdk.SessionManager.inMemory(cwd)});
    try{await fresh.bindExtensions({uiContext:ui,mode:'rpc',onError:error=>errors.push(error)});return fresh.getActiveToolNames();}
    finally{await fresh.extensionRunner.emit({type:'session_shutdown',reason:'quit'});fresh.dispose();}
  };
  assert.ok(!(await toolsOfNewSession()).includes('ask_advisor'),'Phiên mới sau /advisor-off không được bật advisor');
  writeJson(advisorFile,{...readJson(advisorFile),alwaysOn:true});
  assert.ok((await toolsOfNewSession()).includes('ask_advisor'));
});
await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();
const failed=results.some(r=>r.status==='FAIL')||errors.length>0||networkAttempts.length>0;
console.log(JSON.stringify({profile,results,extensionErrors:errors,realNetworkAttempts:networkAttempts.length,fixture:failed?fixture:undefined},null,2));
if(!failed)await fs.promises.rm(fixture,{recursive:true,force:true,maxRetries:20,retryDelay:50});
clearTimeout(watchdog);process.exit(failed?1:0);
