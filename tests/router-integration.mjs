import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

// CLI: node tests/router-integration.mjs <installRoot> <profile>
// Only installed configuration on the explicit root is used. The test copies
// a fixed whitelist into a disposable agent, never auth/history/cache/secrets.
const [installArg, profile] = process.argv.slice(2);
if (!installArg || !["main", "goal"].includes(profile)) {
  throw new Error("Cách dùng: node tests/router-integration.mjs <installRoot> <main|goal|background|advisor>");
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
assert.ok(configuration?.agentDir && ["current", "compat"].includes(configuration.runtime));
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-config ${profile} integration `)));
const agentDir = path.join(fixture, "fixture agent");
const cwd = path.join(fixture, "fixture workspace");
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
for (const name of ["settings.json", "models.json", "advisor.json", "subagents.json", "mcp.json", "open-tui.json", "pi-goal-x-settings.json"]) {
  fs.copyFileSync(path.join(configuration.agentDir, name), path.join(agentDir, name));
}
fs.mkdirSync(path.join(agentDir, "agents"));
for (const name of ["researcher", "worker", "debugger", "reviewer"]) {
  const role = fs.readFileSync(path.join(configuration.agentDir, "agents", `${name}.md`), "utf8");
  fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), role);
}
const compactFile = path.join(agentDir, "compact-adviser.json");
writeJson(compactFile, { version: 1, mode: "off", minContextTokens: 40000, autoAcknowledged: false,
  logRequests: false, typesafeApiKey: "synthetic-adviser-key-not-a-secret" });
const permissionDir = path.join(agentDir, "extensions", "pi-permission-system");
fs.mkdirSync(permissionDir, { recursive: true });
const permission = readJson(path.join(configuration.agentDir, "extensions", "pi-permission-system", "config.json"));
permission.permission.path[compactFile.replaceAll("\\", "/")] = "deny";
permission.permission.dispatch_task = "allow";
permission.permission.path["**/routing.json"] = "deny";
permission.permission.path["**/routing-state/**"] = "deny";
writeJson(path.join(permissionDir, "config.json"), permission);
const settings = readJson(path.join(agentDir, "settings.json"));
Object.assign(settings, {
  defaultProvider: "config-test", defaultModel: "parent", defaultThinkingLevel: "off",
  enabledModels: ["config-test/parent", "openai-codex/gpt-5.6-sol", "opencode-go/glm-5.3-flash"],
  extensions: [fileURLToPath(new URL("./router-provider.ts", import.meta.url)), fileURLToPath(new URL("../assets/extensions/pi-dispatch-router/index.ts", import.meta.url))],
  compaction: { enabled: false }, retry: { enabled: false }, skills: [], cacheWarming: "off",
});
if (settings.workspaceHistory) settings.workspaceHistory.storageDir = path.join(fixture, "history");
writeJson(path.join(agentDir, "settings.json"), settings);
writeJson(path.join(agentDir, "auth.json"), {});
if (profile === "advisor") {
  const advisorFile = path.join(agentDir, "advisor.json");
  const advisor = readJson(advisorFile);
  Object.assign(advisor, { executor: "config-test/parent", advisor: "config-test/worker", alwaysOn: true });
  writeJson(advisorFile, advisor);
}
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
  PI_LENS_DISABLE_LSP_INSTALL: "1", PI_LENS_DISABLE_TOOL_INSTALL: "1",
  FIRECRAWL_NO_SEARCH_FEEDBACK: "1", FIRECRAWL_NO_ENDPOINT_FEEDBACK: "1",
});
for (const key of Object.keys(process.env)) {
  if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|TYPESAFE/u.test(key)) delete process.env[key];
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
let jevCalls = 0;
globalThis.fetch = async (url, init) => {
 if (url !== "https://api.typesafe.ai/v1/systemone") return networkBlocked();
 jevCalls++;
 assert.equal(init.headers.Authorization, "Bearer synthetic-adviser-key-not-a-secret");
 return new Response(JSON.stringify({model:"jev-1.13.0", answers:Object.fromEntries(Object.entries({needs_design:0.01,glm_can_complete:0.98,sol_can_complete:0.99}).map(([k,noul])=>[k,{type:"noul",noul}])),usage:{input_tokens:1000,output_tokens:10}}));
};
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
  if (/\/(?:auth\.json|\.?credentials\.json|compact-adviser\.json)$/u.test(normalized)
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
const control = { plans: {}, seen: [] };
globalThis[Symbol.for("pi-config:test")] = control;
const errors = [], prompts = [], notices = [], results = [];
const routerPolicy = {version:1,mode:"record",allowExplicitGlm:true,jev:{enabled:false,model:"jev-1.13.0",budgetUsd:0,maxCalls:0,timeoutMs:5000},thresholds:{canComplete:0.9,needsDesign:0.2},glmAutoClasses:[],timeoutMs:30000,cacheTtlMs:3600000};
writeJson(path.join(agentDir,"routing.json"),routerPolicy);
writeJson(path.join(agentDir,"routing-capabilities.json"),{version:1,glm:[],sol:[]});
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
const tool = (name, args) => ({ type: 'toolCall', id: `router-${sequence++}`, name, arguments: args });
const final = text => [{type:'text',text}];
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const dispatch = (id, extra={}) => ({requestId:id,role:'researcher',taskClass:'lookup',candidate:'auto',brief:`CASE:child_${id} Đọc safe.txt, báo nội dung, không sửa.`,acceptance:'Nội dung phải khớp file và chỉ đọc.',...extra});
async function run(id, args, childSteps=[final('CHILD_OK')]) {
  const parentKey=`parent_${id}`,childKey=`child_${id}`;
  control.plans[parentKey]=[[tool('dispatch_task',args)],final('PARENT_ACCEPTED')];
  control.plans[childKey]=childSteps;control.fallbackKey=parentKey;
  const before=session.messages.length;
  await session.prompt(`CASE:${parentKey}`);
  await delay(50);
  return session.messages.slice(before).filter(m=>m.role==='toolResult');
}
async function check(name,fn) {
  activePhase=name;console.log(`Router ${profile}: ${name}`);
  try {await fn();results.push({name,status:'PASS'});}catch(error){results.push({name,status:'FAIL',error:error.stack});}
}
await check('record keeps Sol/high with separate context; no Jev',async()=>{
  const out=await run('baseline',dispatch('baseline'));
  assert.equal(out[0]?.isError,false,JSON.stringify(out));
  assert.equal(out[0].details.model,'openai-codex/gpt-5.6-sol');assert.equal(out[0].details.thinking,'high');
  const child=control.seen.find(x=>x.key==='child_baseline');assert.equal(child.model,'gpt-5.6-sol');
  assert.equal(child.options.reasoning,'high');assert.ok(!JSON.stringify(child.messages).includes('CASE:parent_baseline'));
  assert.equal(jevCalls,0);
});
await check('explicit native GLM uses max and reads file through permission layer',async()=>{
  const out=await run('glm',dispatch('glm',{candidate:'glm'}),[[tool('read',{path:'safe.txt'})],final('CHILD_OK')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));assert.equal(out[0].details.model,'opencode-go/glm-5.3-flash');
  assert.equal(control.seen.find(x=>x.key==='child_glm').options.reasoning,'max');
  const seen=control.seen.filter(x=>x.key==='child_glm').at(-1);assert.match(JSON.stringify(seen.messages),/SAFE_CONTENT/);
});
await check('duplicate request returns previous result, does not spawn',async()=>{
  const count=control.seen.filter(x=>x.key==='child_glm').length;
  const out=await run('repeat',dispatch('glm',{candidate:'glm'}));
  assert.equal(out[0]?.isError,false,JSON.stringify(out));assert.equal(control.seen.filter(x=>x.key==='child_glm').length,count);
});
await check('reviewer cannot be downgraded to explicit GLM',async()=>{
  const out=await run('review',dispatch('review',{candidate:'glm',role:'reviewer'}));assert.equal(out[0]?.isError,true);
  assert.ok(!control.seen.some(x=>x.key==='child_review'));
});
await check('worker permissions deny .env; no child bypass',async()=>{
  const out=await run('deny',dispatch('deny',{candidate:'glm',role:'worker',taskClass:'mechanical'}),[[tool('read',{path:'.env'})],final('BLOCKED_AS_EXPECTED')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));
  const child=control.seen.filter(x=>x.key==='child_deny').at(-1);
  assert.ok(child.messages.some(m=>m.role==='toolResult'&&m.isError));
  assert.ok(!JSON.stringify(child.messages).includes('must-not-be-read'));
});
await check('worker cannot change routing policy or budget',async()=>{
  const before=fs.readFileSync(path.join(agentDir,'routing.json'),'utf8');
  const out=await run('policy',dispatch('policy',{candidate:'glm',role:'worker',taskClass:'mechanical'}),[[tool('write',{path:path.join(agentDir,'routing.json'),content:'{}'})],final('BLOCKED_AS_EXPECTED')]);
  assert.equal(out[0]?.isError,false,JSON.stringify(out));
  assert.equal(fs.readFileSync(path.join(agentDir,'routing.json'),'utf8'),before);
  assert.ok(control.seen.filter(x=>x.key==='child_policy').at(-1).messages.some(m=>m.role==='toolResult'&&m.isError));
});
await check('shadow calls fixture Jev, keeps Sol, records budget',async()=>{
  Object.assign(routerPolicy,{mode:'shadow'});Object.assign(routerPolicy.jev,{enabled:true,budgetUsd:0.01,maxCalls:5});
  writeJson(path.join(agentDir,'routing.json'),routerPolicy);
  const out=await run('shadow',dispatch('shadow'));
  assert.equal(out[0]?.isError,false,JSON.stringify(out));assert.equal(out[0].details.model,'openai-codex/gpt-5.6-sol');assert.equal(jevCalls,1);
  assert.equal(readJson(path.join(agentDir,'routing-state','jev-budget.json')).calls,1);
});
await check('balanced needs accepted evidence; valid fixture routes GLM max',async()=>{
  routerPolicy.mode='balanced';routerPolicy.glmAutoClasses=['lookup'];writeJson(path.join(agentDir,'routing.json'),routerPolicy);
  writeJson(path.join(agentDir,'routing-capabilities.json'),{version:1,sol:[],glm:[{model:'opencode-go/glm-5.3-flash',thinking:'max',role:'researcher',taskClass:'lookup',status:'accepted',samples:12,passed:12,evidenceId:'fixture-only',expiresAt:'2099-01-01'}]});
  const out=await run('balanced',dispatch('balanced'));assert.equal(out[0]?.isError,false,JSON.stringify(out));
  assert.equal(out[0].details.model,'opencode-go/glm-5.3-flash');assert.equal(out[0].details.thinking,'max');
});
await check('exhausted Jev budget falls back without extra API requests',async()=>{
  const before=jevCalls;routerPolicy.jev.maxCalls=0;writeJson(path.join(agentDir,'routing.json'),routerPolicy);
  const out=await run('budget',dispatch('budget'));assert.equal(out[0]?.isError,false,JSON.stringify(out));
  assert.equal(out[0].details.model,'openai-codex/gpt-5.6-sol');assert.equal(jevCalls,before);
});
await check('scope and project role drift fail before spawning',async()=>{
  fs.mkdirSync(path.join(cwd,'.pi'),{recursive:true});writeJson(path.join(cwd,'.pi','settings.json'),{enabledModels:['openai-codex/gpt-5.6-sol']});
  const out=await run('scope',dispatch('scope',{candidate:'glm'}));assert.equal(out[0]?.isError,true);
  assert.ok(!control.seen.some(x=>x.key==='child_scope'));
  fs.unlinkSync(path.join(cwd,'.pi','settings.json'));
  fs.mkdirSync(path.join(cwd,'.pi','agents'));fs.writeFileSync(path.join(cwd,'.pi','agents','researcher.md'),fs.readFileSync(path.join(agentDir,'agents','researcher.md'),'utf8').replace('inherit_context: false','inherit_context: true'));
  const drift=await run('drift',dispatch('drift',{candidate:'glm'}));assert.equal(drift[0]?.isError,true);
});
await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();
const failed=results.some(r=>r.status==='FAIL')||errors.length>0||networkAttempts.length>0;
console.log(JSON.stringify({profile,results,extensionErrors:errors,realNetworkAttempts:networkAttempts.length,fixture:failed?fixture:undefined},null,2));
if(!failed)await fs.promises.rm(fixture,{recursive:true,force:true,maxRetries:20,retryDelay:50});
clearTimeout(watchdog);process.exit(failed?1:0);
