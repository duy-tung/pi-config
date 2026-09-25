import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import Module, { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { anthropicSearchEvents, sse, unifiedHeaders } from "./search-fixtures.mjs";

// CLI: node tests/profile-integration.mjs <installRoot> <profile>
// Only installed configuration on the explicit root is used. The test copies
// a fixed whitelist into a disposable agent, never auth/history/cache/secrets.
const [installArg, profile] = process.argv.slice(2);
if (!installArg || !["main"].includes(profile)) {
  throw new Error("Cách dùng: node tests/profile-integration.mjs <installRoot> <main>");
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
for (const name of ["settings.json", "keybindings.json", "models.json", "advisor.json", "subagents.json", "mcp.json", "open-tui.json", "pi-goal-x-settings.json"]) {
  if (fs.existsSync(path.join(configuration.agentDir, name))) fs.copyFileSync(path.join(configuration.agentDir, name), path.join(agentDir, name));
}
fs.mkdirSync(path.join(agentDir, "agents"));
for (const name of ["researcher", "worker", "debugger", "reviewer"]) {
  const role = fs.readFileSync(path.join(configuration.agentDir, "agents", `${name}.md`), "utf8")
    .replace(/^model: .+$/m, "model: config-test/worker")
    .replace('"pi-auto-mode"', '"pi-auto-mode", "scripted-provider"');
  fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), role);
}
const credentialFile = path.join(agentDir, 'auth.json');
const settings = readJson(path.join(agentDir, "settings.json"));
// Cổng permission của bản cài: thêm deny cho auth của fixture, bộ phân loại dùng model giả.
settings.permissions.deny.push(`Path(${credentialFile.replaceAll("\\", "/")})`);
// Jev cần key và mạng thật: tắt ở đây (không đọc keyring của máy); agent-integration kiểm Jev bằng fixture.
settings.autoMode = { ...settings.autoMode, model: "config-test/worker", stateDir: path.join(fixture, "auto-mode"), jev: false };
Object.assign(settings, {
  defaultProvider: "config-test", defaultModel: "parent", defaultThinkingLevel: "off",
  enabledModels: ["config-test/parent", "config-test/worker"],
  // Giữ pi-rewind, claude-usage và pi-auto-mode (nạp sau cùng) của bản cài;
  // các extension giao diện khác không cần trong RPC.
  extensions: [...(settings.extensions ?? []).filter((entry) => typeof entry === "string" && /\/(?:pi-rewind|claude-usage)$/u.test(entry.replaceAll("\\", "/"))),
    fileURLToPath(new URL("./scripted-provider.ts", import.meta.url)),
    ...(settings.extensions ?? []).filter((entry) => typeof entry === "string" && entry.replaceAll("\\", "/").endsWith("/pi-auto-mode"))],
  compaction: { enabled: false }, retry: { enabled: false }, skills: [], cacheWarming: "off",
});
// Máy CI Windows có lúc chạy git lần đầu chậm hơn 2 giây; pi-rewind khi đó tự tắt theo dõi bash
// (đúng thiết kế) làm kiểm thử rewind bash chập chờn. Fixture nới ngưỡng để kết quả ổn định.
if (settings.rewind) Object.assign(settings.rewind, { storageDir: path.join(fixture, "rewind"), watchSlowMs: 60000 });
writeJson(path.join(agentDir, "settings.json"), settings);
writeJson(credentialFile, {"fixture-secret": {type: "api_key", key: "synthetic-private-credential"},
  anthropic: {type: "oauth", access: "sk-ant-oat01-synthetic-fixture", refresh: "synthetic-refresh", expires: Date.now() + 3600000}});
if (configuration.packages.includes("pi-advisor-flow")) {
  const advisorFile = path.join(agentDir, "advisor.json");
  const advisor = readJson(advisorFile);
  // Giữ alwaysOn và gate của bản cài; chỉ thay model bằng model giả.
  Object.assign(advisor, { executor: "config-test/parent", advisor: "config-test/worker" });
  writeJson(advisorFile, advisor);
}
// Dùng routing web của bản cài nhưng thay credential command bằng giá trị giả; bật thêm tuỳ chọn tìm bằng
// Claude cho model khác Claude để kiểm cả hai nhánh của provider anthropic.
const webConfig = readJson(path.join(configuration.agentDir, "web-search.json"));
writeJson(path.join(agentDir, "web-search.json"), { ...webConfig, firecrawlApiKey: "fixture-never-used",
  anthropicSearch: { modelForNonClaude: "anthropic/claude-sonnet-5" } });
writeJson(path.join(cwd, "package.json"), { name: "pi-config-integration-fixture", private: true, type: "module" });
// Git worktree để pi-rewind theo dõi được file bash sửa (git status trước/sau tool).
childProcess.execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
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
// Chỉ endpoint quota Claude (/claude-usage) và Messages API (web search của Claude) có phản hồi giả;
// mọi request khác bị chặn.
const usageRequests = [], searchRequests = [];
globalThis.fetch = async (input, init = {}) => {
  // SDK Anthropic gọi /v1/messages?beta=true khi dùng OAuth.
  if (/^https:\/\/api\.anthropic\.com\/v1\/messages(?:\?|$)/u.test(String(input instanceof Request ? input.url : input))) {
    const body = input instanceof Request ? await input.text() : init.body;
    searchRequests.push({ headers: new Headers(input instanceof Request ? input.headers : init.headers), body: JSON.parse(body) });
    return new Response(sse(anthropicSearchEvents()), { headers: { "content-type": "text/event-stream" } });
  }
  if (String(input) !== "https://api.anthropic.com/api/oauth/usage") return networkBlocked();
  usageRequests.push(new Headers(init.headers));
  return Response.json({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600000).toISOString() },
    seven_day: { utilization: 34, resets_at: new Date(Date.now() + 86400000).toISOString() },
    extra_usage: { is_enabled: false, used_credits: 0, monthly_limit: 0, currency: "USD" } });
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
const statuses = new Map();
// Câu trả lời định sẵn cho dialog Rewind (RPC dùng select); dialog khác dùng mặc định.
const rewindAnswers = [];
// Chạy một lần khi màn hình xác nhận của Rewind mở (vd. người dùng sửa file trong lúc hộp thoại mở).
let onRewindConfirm;
let imageDraft = "";
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false });
const sessionManager = sdk.SessionManager.create(cwd, path.join(fixture, "sessions"));
const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, sessionManager });
// Automatic approvals are restricted to our isolated fixture and fake model.
const ui = {
  ...Object.fromEntries(["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"].map((key) => [key, () => {}])),
  onTerminalInput: () => () => {}, input: async () => undefined,
  editor: async (title, text) => { prompts.push({ kind: "editor", title, text }); return undefined; },
  getEditorComponent: () => undefined, getAllThemes: () => [], setTheme: () => ({ success: true }),
  theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, italic: (text) => text, dim: (text) => text },
  select: async (title, options) => {
    prompts.push({ kind: "select", title });
    if (/^Rewind|^Confirm you want/u.test(title)) {
      if (onRewindConfirm && /^Confirm you want to restore/u.test(title)) {
        const hook = onRewindConfirm;
        onRewindConfirm = undefined;
        hook();
      }
      const wanted = rewindAnswers.shift();
      return options.find((option) => option === wanted || new RegExp(`CASE:${wanted}(?:\\s|$)`, "u").test(option));
    }
    return options.find((option) => /^Allow once|^Approve once/u.test(option)) ?? options[0];
  },
  confirm: async (title) => { prompts.push({ kind: "confirm", title }); return true; },
  notify: (message, type) => notices.push({ message, type }),
  custom: async () => { throw new Error("Unexpected TUI dialog in RPC fixture"); },
  getToolsExpanded: () => false, getEditorText: () => "", getTheme: () => undefined,
  pasteToEditor: text => { imageDraft += text; },
  setStatus: (key, value) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
};
await session.bindExtensions({ uiContext: ui, mode: "rpc", onError: (error) => errors.push(error),
  commandContextActions: { waitForIdle: () => session.waitForIdle(), navigateTree: (id, options) => session.navigateTree(id, options) } });
await session.setModel(runtime.getModel("config-test", "parent"));
let sequence = 0;
const tool = (name, args) => ({ type: "toolCall", id: `fixture-${sequence++}`, name, arguments: args });
const final = (text = "OK") => [{ type: "text", text }];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run(name, steps, extra = "") {
  control.plans[name] = [...steps, final()]; control.fallbackKey = name;
  const from = session.messages.length;
  await session.prompt(`CASE:${name} ${extra}`);
  await delay(50);
  const deadline = Date.now() + 15000;
  while (session.isStreaming || session.pendingMessageCount > 0) {
    if (Date.now() > deadline) throw new Error("Fixture session did not settle within 15 seconds");
    await delay(50);
  }
  const messages = session.messages.slice(from);
  assert.deepEqual(messages.filter((message) => message.role === "assistant" && message.stopReason === "error"), []);
  return messages.filter((message) => message.role === "toolResult");
}
async function check(name, fn) {
  activePhase = name;
  console.log(`Kiểm thử ${profile}: ${name}`);
  try { await fn(); results.push({ name, status: "PASS" }); }
  catch (error) { results.push({ name, status: "FAIL", error: error.stack }); }
}
await check("single session exposes slash commands and only one model delegation system", async () => {
  const commands = session.extensionRunner.getRegisteredCommands().map(command => command.name);
  for (const name of ["goal", "goal-pause", "goal-resume", "bg", "jobs", "logs", "kill", "advisor", "advisor-off", "rewind", "checkpoint", "undo", "redo", "clear", "permissions", "auto-mode", "claude-usage"])
    assert.ok(commands.includes(name), `Missing /${name}`);
  assert.equal(new Set(commands).size, commands.length);
  const tools = session.getAllTools().map(tool => tool.name);
  assert.ok(tools.includes("Agent"));
  for (const name of ["bg_delegate", "bg_run_pi_attested", "fusion_reason", "fusion_investigate", "fusion_research", "fusion_validate"])
    assert.ok(!tools.includes(name), `Duplicate model workflow: ${name}`);
  assert.ok(!loader.getExtensions().extensions.some(extension => extension.path?.includes("anthropic-attribution")));
  assert.equal(control.seen.length, 0, "Startup must not call any model");
});
await check("Claude: web_search provider anthropic, quota footer from headers and /claude-usage", async () => {
  const claude = runtime.getModel("anthropic", "claude-sonnet-5");
  const webSearch = session.extensionRunner.getToolDefinition("web_search");
  assert.match(webSearch?.description ?? "", /^Search the web with OpenAI, Anthropic, Exa, Firecrawl\./u);
  const search = async () => {
    searchRequests.length = 0;
    const result = await webSearch.execute("profile-search", { query: "pi coding agent", numResults: 2 }, new AbortController().signal, undefined, session.extensionRunner.createContext());
    return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  };
  const parent = runtime.getModel("config-test", "parent");
  try {
    // Phiên có UI chuyển sang Claude: extension đọc quota qua OAuth ngay, không chờ phản hồi Claude đầu tiên.
    await session.setModel(claude);
    for (const deadline = Date.now() + 15000; !/^claude 88% ↻ /u.test(statuses.get("claude-usage") ?? "");) {
      assert.ok(Date.now() < deadline, `Quota Claude không được đọc khi chuyển sang Claude: ${usageRequests.length} request`);
      await delay(20);
    }
    assert.equal(usageRequests.length, 1);
    assert.equal(usageRequests[0].get("authorization"), "Bearer sk-ant-oat01-synthetic-fixture");
    assert.equal(usageRequests[0].get("anthropic-beta"), "oauth-2025-04-20");
    // Model hiện tại là Claude: tìm bằng chính model đó; model khác Claude: tìm bằng anthropicSearch.modelForNonClaude.
    for (const model of [claude, parent]) {
      await session.setModel(model);
      const text = await search();
      assert.equal(searchRequests.length, 1, `${model.id}: ${text.slice(0, 300)}`);
      assert.equal(searchRequests[0].body.model, "claude-sonnet-5");
      assert.deepEqual(searchRequests[0].body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
      assert.match(searchRequests[0].body.system[0].text, /^x-anthropic-billing-header:/u, "pi-anthropic-auth phải shape request tìm kiếm");
      assert.match(text, /\*\*Provider:\*\* anthropic/u);
      assert.match(text, /https:\/\/code\.example\/pi/u);
    }
    await session.setModel(claude);
    await delay(100);
    assert.equal(usageRequests.length, 1, "Quota đọc chưa tới 15 phút thì không đọc lại");
    await session.extensionRunner.emit({ type: "after_provider_response", status: 200, headers: unifiedHeaders() });
    assert.match(statuses.get("claude-usage") ?? "", /^claude 77% ↻ 2h1\dm 59% ↻ 4d\dh$/u);
    await session.prompt("/claude-usage");
    assert.equal(usageRequests.length, 2);
    assert.equal(usageRequests[1].get("authorization"), "Bearer sk-ant-oat01-synthetic-fixture");
    const report = notices.findLast((notice) => notice.message.startsWith("Claude usage"))?.message ?? "";
    assert.match(report, /Phiên 5 giờ: dùng 12% · còn 88%/u);
    assert.ok(!report.includes("sk-ant-oat01"), "Báo cáo không được chứa credential");
    assert.match(statuses.get("claude-usage") ?? "", /^claude 88% ↻ /u);
  } finally {
    // Các check sau chạy trên model của fixture.
    await session.setModel(parent);
  }
  assert.equal(statuses.has("claude-usage"), false);
  assert.equal(control.seen.length, 0, "Quota và web search không được gọi model của fixture");
});
await check("read safe file; deny .env and symlink escape", async () => {
  const calls = [[tool("read", { path: "safe.txt" })], [tool("read", { path: ".env" })]];
  if (symlinkAvailable) calls.push([tool("read", { path: "secret-alias.txt" })]);
  const result = await run("paths", calls);
  assert.equal(result.length, calls.length); assert.match(JSON.stringify(result[0]), /SAFE_CONTENT/u);
  assert.ok(result.slice(1).every((message) => message.isError));
  assert.ok(!JSON.stringify(result).includes("must-not-be-read"));
});
await check("credential storage is denied to model tools", async () => {
  const result = await run("credential-deny", [[tool("read", { path: credentialFile })]]);
  assert.equal(result[0]?.isError, true);
  assert.ok(!JSON.stringify(result).includes("synthetic-private-credential"));
});
const classifierRequests = () => control.seen.filter((entry) => entry.key === "classifier");
await check("/auto-mode eval runs the labeled cases through the classifier", async () => {
  const before = classifierRequests().length;
  await session.prompt("/auto-mode eval config-test/worker");
  const report = prompts.findLast((item) => item.kind === "editor" && /Auto mode eval/u.test(item.title));
  assert.ok(report, JSON.stringify(notices.slice(-3)));
  assert.match(report.text, /Cases: \d+ \(\d+ must-block, \d+ must-allow\)/u);
  assert.ok(classifierRequests().length > before);
  assert.ok(!report.text.includes("unavailable: 1"), report.text.slice(0, 400));
});
await check("auto mode: read-only shell runs directly, other commands go through the classifier", async () => {
  let before = classifierRequests().length;
  let result = await run("shell", [[tool("bash", { command: "printf integration-ok", timeout: 10 })]]);
  assert.match(JSON.stringify(result), /integration-ok/u); assert.ok(!result[0]?.isError, JSON.stringify(result));
  assert.equal(classifierRequests().length, before, "Lệnh chỉ đọc không cần bộ phân loại");
  control.classifier.push("<block>no</block>");
  result = await run("shell-classified", [[tool("bash", { command: "printf classified-ok > classified.txt", timeout: 10 })]], "USER_INTENT_MARKER");
  assert.ok(!result[0]?.isError, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(cwd, "classified.txt"), "utf8"), "classified-ok");
  const request = classifierRequests().at(-1);
  assert.equal(classifierRequests().length, before + 1);
  const text = JSON.stringify(request.messages);
  assert.match(text, /USER_INTENT_MARKER/u); assert.match(text, /classified-ok > classified\.txt/u);
  assert.ok(!text.includes("SAFE_CONTENT"), "Kết quả tool không được gửi cho bộ phân loại");
  before = classifierRequests().length;
  control.classifier.push("<block>yes</block>", "<block>yes</block><rule>Irreversible Deletion</rule><reason>Fixture block.</reason>");
  result = await run("shell-blocked", [[tool("bash", { command: "printf blocked > blocked.txt", timeout: 10 })]]);
  assert.equal(result[0]?.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result), /denied by Pi's auto mode classifier/u);
  assert.ok(!fs.existsSync(path.join(cwd, "blocked.txt")));
  assert.equal(classifierRequests().length, before + 2);
  assert.ok(notices.some((item) => /denied by auto mode/u.test(item.message)));
});
if (configuration.packages.includes("@tintinweb/pi-subagents")) {
  await check("Agent spawn is classified; the child keeps the gate and the root user intent", async () => {
    control.plans.child = [[tool("bash", { command: "printf child-permission-ok > child-proof.txt", timeout: 10 })], final("CHILD_DONE")];
    const before = classifierRequests().length;
    const result = await run("parent", [[tool("Agent", { subagent_type: "worker", prompt: "CASE:child Execute fixture command.", description: "fixture worker", run_in_background: false })]], "PARENT_PRIVATE_MARKER");
    const child = control.seen.filter((entry) => entry.key === "child");
    assert.ok(child.length > 0, JSON.stringify(result)); assert.ok(child.every((entry) => entry.model === "worker"));
    assert.ok(child.every((entry) => !JSON.stringify(entry.messages).includes("PARENT_PRIVATE_MARKER")));
    assert.match(JSON.stringify(result), /CHILD_DONE/u);
    assert.equal(fs.readFileSync(path.join(cwd, "child-proof.txt"), "utf8"), "child-permission-ok");
    const requests = classifierRequests().slice(before).map((entry) => JSON.stringify(entry.messages));
    assert.ok(requests.some((text) => text.includes('\\"Agent\\"') || text.includes("(worker)")), "Agent spawn phải qua bộ phân loại");
    const fromChild = requests.find((text) => text.includes("child-proof.txt"));
    assert.ok(fromChild, "Child phải có cổng permission");
    assert.match(fromChild, /root_user_messages/u); assert.match(fromChild, /PARENT_PRIVATE_MARKER/u);
    assert.match(fromChild, /delegated_task/u);
  });
  await check("reviewer cannot write", async () => {
    control.plans.reviewchild = [[tool("write", { path: "reviewer-illegal.txt", content: "bad" })], final("REVIEW_DONE")];
    await run("reviewparent", [[tool("Agent", { subagent_type: "reviewer", prompt: "CASE:reviewchild", description: "fixture reviewer", run_in_background: false })]]);
    assert.ok(!fs.existsSync(path.join(cwd, "reviewer-illegal.txt")));
    const child = control.seen.filter((entry) => entry.key === "reviewchild");
    assert.ok(child.length > 0);
    assert.ok(child.some((entry) => entry.messages.some((message) => message.role === "toolResult" && message.isError)));
  });
}
await check("todo persists create and completion", async () => {
  const result = await run("todo", [[tool("todo", { action: "create", subject: "Fixture local" })],
    [tool("todo", { action: "update", id: 1, status: "completed" })], [tool("todo", { action: "get", id: 1 })]]);
  assert.equal(result.length, 3); assert.ok(result.every((message) => !message.isError), JSON.stringify(result));
  assert.match(JSON.stringify(result[2]), /completed/u);
  assert.ok(sessionManager.getEntries().some((entry) => JSON.stringify(entry).includes("Fixture local")));
});
await check("ask_user_question RPC round trip", async () => {
  const before = prompts.length;
  const result = await run("question", [[tool("ask_user_question", { questions: [{ question: "Chọn fixture?", header: "Fixture", options: [
    { label: "Local", description: "Không gọi model mạng" }, { label: "Remote", description: "Không dùng" },
  ] }] })]]);
  assert.ok(prompts.length > before); assert.equal(result.length, 1); assert.ok(!result[0].isError, JSON.stringify(result));
  assert.match(JSON.stringify(result), /Local/u);
});
await check("MCP stdio connects, reads safe file, denies secrets", async () => {
  let result = await run("mcp-connect", [[tool("mcp", { connect: "workspace" })]]);
  assert.ok(!result[0]?.isError, JSON.stringify(result));
  result = await run("mcp-read", [[tool("mcp", { tool: "workspace_read_text_file", args: { path: path.join(cwd, "safe.txt") } })]]);
  assert.ok(!result[0]?.isError, JSON.stringify(result)); assert.match(JSON.stringify(result), /SAFE_CONTENT/u);
  result = await run("mcp-secret", [[tool("mcp", { tool: "workspace_read_text_file", args: { path: path.join(cwd, ".env") } })]]);
  assert.equal(result[0]?.isError, true, JSON.stringify(result));
  assert.ok(!JSON.stringify(result).includes("must-not-be-read"));
  if (symlinkAvailable) {
    result = await run("mcp-alias", [[tool("mcp", { tool: "workspace_read_text_file", args: JSON.stringify({ path: path.join(cwd, "secret-alias.txt") }) })]]);
    assert.equal(result[0]?.isError, true, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes("must-not-be-read"));
  }
});
if (configuration.packages.includes("pi-goal-x")) {
  await check("goal creates, reports state, and honors explicit pause", async () => {
    const result = await run("goal", [
      [tool("create_goal", { objective: "Kiểm thử goal trong fixture cục bộ." })],
      [tool("get_goal", {})],
      [tool("update_goal", { status: "paused", reason: "Người dùng fixture yêu cầu tạm dừng sau kiểm tra trạng thái." })],
    ], "Người dùng fixture yêu cầu tạo goal rồi tạm dừng.");
    assert.equal(result.length, 3); assert.ok(result.every((message) => !message.isError), JSON.stringify(result));
    assert.match(JSON.stringify(result), /paused/u);
  });
}
if (configuration.packages.includes("pi-background-tasks")) {
  await check("background shell job wakes the main session when it ends; triggerOnCompletion:false only notifies", async () => {
    // Windows shell startup is not bounded by an arbitrary sleep: wait on the observable state instead.
    const waitFor = async (probe, what) => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const value = probe();
        if (value) return value;
        assert.ok(Date.now() < deadline, `${what} within 15 seconds`);
        await delay(100);
      }
    };
    const settled = () => !session.isStreaming && session.pendingMessageCount === 0;
    const notifies = (message, taskId) => JSON.stringify(message ?? {}).includes(`<task-id>${taskId}</task-id>`);
    assert.match(session.getToolDefinition("bg_run").promptGuidelines.join("\n"), /completion notification wakes you/u);
    let seen = control.seen.length;
    let result = await run("bg-start", [[tool("bg_run", { name: "Local fixture output", command: "printf BACKGROUND_OK",
      isAgent: false, timeoutSeconds: 10 })]]);
    assert.ok(!result[0]?.isError, JSON.stringify(result));
    const taskId = result[0].details?.task?.id; assert.ok(taskId, JSON.stringify(result));
    assert.equal(result[0].details.task.triggerOnCompletion, true, "bg_run wakes the model by default");
    assert.match(JSON.stringify(result[0].content), /Automatic follow-up turn: enabled/u);
    // The terminal notification starts a model turn by itself: nobody sends a message.
    const wake = await waitFor(() => control.seen.slice(seen).find((request) => notifies(request.messages.at(-1), taskId)),
      "Completion notification starts a turn");
    assert.match(JSON.stringify(wake.messages.at(-1)), /<status>completed<\/status>/u);
    await waitFor(settled, "Woken turn finishes");
    result = await run("bg-output", [[tool("bg_logs", { taskId })]]);
    assert.ok(!result[0]?.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /BACKGROUND_OK/u);
    // Opt-out: the notification still lands in the conversation but starts no turn.
    result = await run("bg-quiet", [[tool("bg_run", { name: "Quiet fixture job", command: "printf QUIET_OK",
      isAgent: false, timeoutSeconds: 10, triggerOnCompletion: false })]]);
    const quietId = result[0].details?.task?.id; assert.ok(quietId, JSON.stringify(result));
    seen = control.seen.length;
    await waitFor(() => session.messages.some((message) => message.role === "custom" && notifies(message, quietId)),
      "Quiet job notification is recorded");
    await delay(300);
    assert.equal(control.seen.length, seen, "triggerOnCompletion:false must not start a turn");
  });
}
if (configuration.packages.includes("pi-advisor-flow")) {
  await check("advisor is on from startup and uses second fixture model through patched ModelRuntime", async () => {
    assert.ok(session.getActiveToolNames().includes("ask_advisor"), "alwaysOn phải bật advisor khi mở phiên");
    await session.prompt("/advisor");
    control.plans.advice = [final("ADVISOR_APPROVED_FIXTURE")];
    const result = await run("advisor", [[tool("ask_advisor", { question: "CASE:advice Review local fixture.", gitContext: "none" })]]);
    assert.equal(result.length, 1); assert.ok(!result[0].isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /ADVISOR_APPROVED_FIXTURE/u);
    assert.ok(control.seen.some((entry) => entry.key === "advice" && entry.model === "worker"));
    await session.prompt("/advisor-off");
  });
}
await check("rewind restores code and conversation like Claude Code; Redo in the menu and /redo bring them back", async () => {
  const fileA = path.join(cwd, "rewind-a.txt"), fileB = path.join(cwd, "rewind-b.txt");
  const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  await run("rewind-one", [[tool("write", { path: "rewind-a.txt", content: "A1\n" })]]);
  await run("rewind-two", [[tool("edit", { path: "rewind-a.txt", edits: [{ oldText: "A1", newText: "A2" }] })],
    [tool("bash", { command: "printf B > rewind-b.txt", timeout: 10 })]]);
  assert.equal(read(fileA), "A2\n"); assert.equal(read(fileB), "B");
  const checkpoints = sessionManager.getEntries().filter((entry) => entry.customType === "pi-rewind" && entry.data?.kind === "checkpoint");
  const userTwo = sessionManager.getEntries().find((entry) => entry.type === "message" && JSON.stringify(entry.message.content).includes("CASE:rewind-two"));
  assert.ok(checkpoints.some((entry) => entry.data.userEntryId === userTwo.id), "Checkpoint phải gắn với user message của prompt");
  rewindAnswers.push("rewind-two", "Restore code and conversation");
  await session.prompt("/rewind");
  assert.equal(read(fileA), "A1\n", JSON.stringify(notices)); assert.equal(read(fileB), null, JSON.stringify(notices));
  assert.ok(!sessionManager.getBranch().some((entry) => entry.id === userTwo.id), "Hội thoại phải quay về trước prompt đã chọn");
  // Redo nằm trong menu /rewind (dưới "(current)"), như /redo.
  rewindAnswers.push("Redo", "Redo");
  await session.prompt("/rewind");
  assert.deepEqual(rewindAnswers, [], "Menu phải có mục Redo");
  assert.equal(read(fileA), "A2\n"); assert.equal(read(fileB), "B");
  assert.ok(sessionManager.getBranch().some((entry) => entry.id === userTwo.id));
  rewindAnswers.push("rewind-one", "Restore code");
  await session.prompt("/undo");
  assert.equal(read(fileA), null); assert.equal(read(fileB), null);
  assert.ok(sessionManager.getBranch().some((entry) => entry.id === userTwo.id), "Restore code giữ nguyên hội thoại");
  await session.prompt("/redo");
  assert.equal(read(fileA), "A2\n"); assert.equal(read(fileB), "B");
  assert.equal(control.seen.filter((entry) => entry.key === "rewind-one" || entry.key === "rewind-two").length, 5);
  assert.equal(fs.readdirSync(path.join(fixture, "rewind", "journal")).length, 0, "Nhật ký phục hồi phải được xóa khi khôi phục xong");
});
await check("rewind: a restore interrupted by a crash can be finished from the menu", async () => {
  const file = path.join(cwd, "rewind-journal.txt");
  fs.writeFileSync(file, "X-before\n");
  const { BlobStore } = await import(pathToFileURL(path.join(installRoot, "assets", "extensions", "pi-rewind", "lib", "store.ts")).href);
  const store = new BlobStore(path.join(fixture, "rewind"));
  const version = (text) => ({ kind: "file", sha: store.put(Buffer.from(text)), size: Buffer.byteLength(text), mode: fs.statSync(file).mode & 0o7777, dir: fs.realpathSync.native(cwd) });
  // Process đã thoát: như Pi chết giữa lúc khôi phục, nhật ký còn lại.
  const dead = childProcess.spawnSync(process.execPath, ["-e", ""]).pid;
  const journal = path.join(fixture, "rewind", "journal", "crashed.json");
  writeJson(journal, { v: 1, id: "crashed", pid: dead, at: Date.now() - 60000, files: { [file]: { before: version("X-before\n"), after: version("X-target\n") } } });
  rewindAnswers.push("⚠ Interrupted code restore", "Finish the restore");
  await session.prompt("/rewind");
  assert.deepEqual(rewindAnswers, [], "Menu phải có mục Interrupted code restore");
  assert.equal(fs.readFileSync(file, "utf8"), "X-target\n");
  assert.equal(fs.existsSync(journal), false);
});
await check("pi-lens: the TypeScript server starts without automatic typings downloads", async () => {
  // tsserver mặc định tự npm install @types vào cache của máy khi mở file JS/TS; cấu hình của bản cài tắt việc này.
  const lsp = await import(pathToFileURL(path.join(modules, "pi-lens", "dist", "clients", "lsp", "config.js")).href);
  await lsp.initLSPConfig(cwd);
  assert.deepEqual(lsp.getServerInitOverride("typescript", path.join(cwd, "app.js"))?.initializationOptions, { disableAutomaticTypingAcquisition: true });
});
await check("rewind: Redo keeps the work done after the rewind; Undo redo in the menu brings it back", async () => {
  const file = path.join(cwd, "redo-c.txt");
  const edit = (from, to) => tool("edit", { path: "redo-c.txt", edits: [{ oldText: from, newText: to }] });
  await run("undo-redo-one", [[tool("write", { path: "redo-c.txt", content: "C1\n" })]]);
  await run("undo-redo-two", [[edit("C1", "C2")]]);
  rewindAnswers.push("undo-redo-two", "Restore code");
  await session.prompt("/rewind");
  assert.equal(fs.readFileSync(file, "utf8"), "C1\n");
  // Việc làm sau lần rewind: Redo đưa code về trước rewind (C2) nhưng phải lưu lại C3.
  await run("undo-redo-three", [[edit("C1", "C3")]]);
  await session.prompt("/redo");
  assert.equal(fs.readFileSync(file, "utf8"), "C2\n");
  rewindAnswers.push("Undo redo", "Undo redo");
  await session.prompt("/rewind");
  assert.deepEqual(rewindAnswers, [], "Menu phải có mục Undo redo ngay sau Redo");
  assert.equal(fs.readFileSync(file, "utf8"), "C3\n");
  // Undo redo cũng được ghi lại như một lần rewind: Redo đưa về C2.
  await session.prompt("/redo");
  assert.equal(fs.readFileSync(file, "utf8"), "C2\n");
  assert.equal(fs.readdirSync(path.join(fixture, "rewind", "journal")).length, 0);
});
await check("rewind: a file changed while the confirmation is open stops the restore; nothing is written", async () => {
  const file = path.join(cwd, "preview-d.txt");
  const rewinds = () => sessionManager.getEntries().filter((entry) => entry.customType === "pi-rewind" && entry.data?.kind === "rewind").length;
  await run("preview-one", [[tool("write", { path: "preview-d.txt", content: "D1\n" })]]);
  await run("preview-two", [[tool("edit", { path: "preview-d.txt", edits: [{ oldText: "D1", newText: "D2" }] })]]);
  const recorded = rewinds(), from = notices.length;
  onRewindConfirm = () => fs.writeFileSync(file, "D2 edited by the user\n");
  rewindAnswers.push("preview-two", "Restore code");
  await session.prompt("/rewind");
  assert.deepEqual(rewindAnswers, []);
  assert.equal(onRewindConfirm, undefined, "Rewind phải hỏi xác nhận trước khi khôi phục");
  assert.equal(fs.readFileSync(file, "utf8"), "D2 edited by the user\n");
  assert.ok(notices.slice(from).some((notice) => notice.type === "error"
    && notice.message === "The code changed since the preview (preview-d.txt). Nothing was restored; open /rewind again."), JSON.stringify(notices.slice(from)));
  assert.equal(rewinds(), recorded, "Không ghi lần rewind nào khi không khôi phục");
  assert.equal(fs.readdirSync(path.join(fixture, "rewind", "journal")).length, 0);
  assert.equal(fs.existsSync(path.join(fixture, "rewind", "lock")), false, "Khóa kho phải được trả");
});
await check("rewind: edits wait while the rewind store cannot save a restore point", async () => {
  const file = path.join(cwd, "redo-c.txt");
  const blobs = path.join(fixture, "rewind", "blobs"), away = `${blobs}-away`;
  const before = fs.readFileSync(file, "utf8");
  // Kho không ghi được (như đĩa đầy): blobs là file thay vì thư mục.
  fs.renameSync(blobs, away);
  fs.writeFileSync(blobs, "not a directory\n");
  try {
    notices.length = 0;
    const [blockedResult] = await run("rewind-store-broken", [[tool("edit", { path: "redo-c.txt", edits: [{ oldText: "C2", newText: "C9" }] })]]);
    assert.equal(blockedResult?.isError, true);
    assert.match(JSON.stringify(blockedResult.content), /Rewind could not save a restore point/u);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.ok(notices.some((notice) => /không lưu được điểm khôi phục/u.test(notice.message)), JSON.stringify(notices));
  } finally {
    fs.rmSync(blobs, { force: true });
    fs.renameSync(away, blobs);
  }
  const [editResult] = await run("rewind-store-fixed", [[tool("edit", { path: "redo-c.txt", edits: [{ oldText: "C2", newText: "C4" }] })]]);
  assert.notEqual(editResult?.isError, true, JSON.stringify(editResult?.content));
  assert.equal(fs.readFileSync(file, "utf8"), "C4\n");
  const fixed = sessionManager.getEntries().find((entry) => entry.type === "message" && JSON.stringify(entry.message.content).includes("CASE:rewind-store-fixed"));
  assert.ok(sessionManager.getEntries().some((entry) => entry.customType === "pi-rewind" && entry.data?.kind === "checkpoint" && entry.data.userEntryId === fixed.id));
});
await check("clipboard image shortcut, attachment, deleted marker and size guard", async () => {
  const {KeybindingsManager}=await import(pathToFileURL(path.join(modules,"@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href);
  const keybindings = KeybindingsManager.create(agentDir);
  const shortcuts = session.extensionRunner.getShortcuts(keybindings.getEffectiveConfig());
  const shortcut = shortcuts.get(process.platform === "win32" ? "alt+v" : "ctrl+v");
  assert.ok(shortcut?.extensionPath.includes("image-paste"));
  assert.ok(!session.extensionRunner.getShortcutDiagnostics().some(item=>item.message.includes("pasteImage")));
  assert.ok(!loader.getExtensions().extensions.some(extension=>extension.path.replaceAll("\\","/").includes("@pi-archimedes/core/")));
  // PNG RGBA 2x2: Pi 0.87 chuẩn hóa ảnh prompt bằng Photon, ảnh xám 1x1 bị bỏ qua.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=", "base64");
  let bytes = png;
  const originalLoad = Module._load, originalSpawn = childProcess.spawnSync, display = process.env.DISPLAY;
  // Isolate the OS boundary: never inspect the user's clipboard in automated tests.
  Module._load = function(name,...args) { return name === "@mariozechner/clipboard" ? {hasImage:()=>true,getImageBinary:async()=>bytes} : originalLoad.call(this,name,...args); };
  childProcess.spawnSync = function(command,...args) { return ["xclip","wl-paste"].includes(command) ? {error:Object.assign(new Error("fixture"),{code:"ENOENT"})} : originalSpawn.call(this,command,...args); };
  process.env.DISPLAY = ":fixture";
  syncBuiltinESMExports();
  try {
    imageDraft=""; await shortcut.handler();
    assert.match(imageDraft,/\[Image #1\]/);
    await run("clipboard-image", [], imageDraft);
    const request=control.seen.findLast(entry=>entry.key==="clipboard-image");
    const attached=request.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(item=>item.type==="image"):[]);
    assert.equal(attached.length,1,"An image must reach the model exactly once; previews must stay UI-only");
    assert.equal(attached[0].data,png.toString("base64"));
    imageDraft=""; await shortcut.handler();
    await run("clipboard-deleted", [], "Marker removed before submit");
    const next=control.seen.findLast(entry=>entry.key==="clipboard-deleted");
    const user=next.messages.findLast(message=>message.role==="user");
    assert.ok(!Array.isArray(user.content)||!user.content.some(item=>item.type==="image"));
    bytes=Buffer.alloc(20*1024*1024+1);imageDraft="";await shortcut.handler();
    assert.equal(imageDraft,"");assert.ok(notices.some(item=>item.message.includes("Image too large")));
  } finally {
    Module._load=originalLoad;childProcess.spawnSync=originalSpawn;syncBuiltinESMExports();
    if(display===undefined)delete process.env.DISPLAY;else process.env.DISPLAY=display;
  }
});
await check("headless auto mode never prompts and fails closed without a verdict", async () => {
  session.extensionRunner.setUIContext(undefined, "print");
  const before = prompts.length;
  control.classifier.push("garbage", "garbage", "garbage");
  const result = await run("headless", [[tool("bash", { command: "printf forbidden > headless-forbidden.txt", timeout: 5 })]]);
  assert.equal(result[0]?.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result), /could not check this action/u);
  assert.ok(!fs.existsSync(path.join(cwd, "headless-forbidden.txt")));
  control.classifier.push("<block>yes</block>", "<block>yes</block><rule>Persistence</rule><reason>Fixture block.</reason>");
  const background = await run("headless-background", [[tool("bg_run", { name: "Denied job", isAgent: false, command: "printf forbidden > bg-forbidden.txt", triggerOnCompletion: false })]]);
  assert.equal(background[0]?.isError, true, JSON.stringify(background));
  assert.ok(!fs.existsSync(path.join(cwd,"bg-forbidden.txt")));
  assert.equal(prompts.length, before);
});
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
session.dispose();
const failed = results.some((result) => result.status === "FAIL") || errors.length > 0;
console.log(JSON.stringify({ profile, runtime: configuration.runtime, platform: process.platform, results,
  extensionErrors: errors, symlinkTest: symlinkAvailable ? "tested" : "SKIP: Windows symlink permission unavailable",
  blockedNetworkRequests: networkAttempts.length, fixture: failed ? fixture : undefined }, null, 2));
if (!failed) await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
clearTimeout(watchdog);
process.exit(failed ? 1 : 0);
