import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

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
for (const name of ["settings.json", "models.json", "advisor.json", "subagents.json", "mcp.json", "open-tui.json", "pi-goal-x-settings.json"]) {
  if (fs.existsSync(path.join(configuration.agentDir, name))) fs.copyFileSync(path.join(configuration.agentDir, name), path.join(agentDir, name));
}
fs.mkdirSync(path.join(agentDir, "agents"));
for (const name of ["researcher", "worker", "debugger", "reviewer"]) {
  const role = fs.readFileSync(path.join(configuration.agentDir, "agents", `${name}.md`), "utf8")
    .replace(/^model: .+$/m, "model: config-test/worker")
    .replace('"pi-permission-system"', '"pi-permission-system", "scripted-provider"');
  fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), role);
}
const credentialFile = path.join(agentDir, 'auth.json');
const permissionDir = path.join(agentDir, "extensions", "pi-permission-system");
fs.mkdirSync(permissionDir, { recursive: true });
const permission = readJson(path.join(configuration.agentDir, "extensions", "pi-permission-system", "config.json"));
permission.permission.path[credentialFile.replaceAll("\\", "/")] = "deny";
writeJson(path.join(permissionDir, "config.json"), permission);
const settings = readJson(path.join(agentDir, "settings.json"));
Object.assign(settings, {
  defaultProvider: "config-test", defaultModel: "parent", defaultThinkingLevel: "off",
  enabledModels: ["config-test/parent", "config-test/worker"],
  extensions: [fileURLToPath(new URL("./scripted-provider.ts", import.meta.url))],
  compaction: { enabled: false }, retry: { enabled: false }, skills: [], cacheWarming: "off",
});
if (settings.workspaceHistory) settings.workspaceHistory.storageDir = path.join(fixture, "history");
writeJson(path.join(agentDir, "settings.json"), settings);
writeJson(credentialFile, {"fixture-secret": {type: "api_key", key: "synthetic-private-credential"}});
if (configuration.packages.includes("pi-advisor-flow")) {
  const advisorFile = path.join(agentDir, "advisor.json");
  const advisor = readJson(advisorFile);
  Object.assign(advisor, { executor: "config-test/parent", advisor: "config-test/worker", alwaysOn: false });
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
const control = { plans: {}, seen: [] };
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
  for (const name of ["goal", "goal-pause", "goal-resume", "bg", "jobs", "logs", "kill", "advisor", "advisor-off", "checkpoint", "undo", "redo"])
    assert.ok(commands.includes(name), `Missing /${name}`);
  assert.equal(new Set(commands).size, commands.length);
  const tools = session.getAllTools().map(tool => tool.name);
  assert.ok(tools.includes("Agent"));
  for (const name of ["bg_delegate", "bg_run_pi_attested", "fusion_reason", "fusion_investigate", "fusion_research", "fusion_validate"])
    assert.ok(!tools.includes(name), `Duplicate model workflow: ${name}`);
  assert.ok(!loader.getExtensions().extensions.some(extension => extension.path?.includes("anthropic-attribution")));
  assert.equal(control.seen.length, 0, "Startup must not call any model");
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
await check("shell asks parent before fixture execution", async () => {
  const before = prompts.length;
  const result = await run("shell", [[tool("bash", { command: "printf integration-ok", timeout: 10 })]]);
  assert.ok(prompts.length > before); assert.match(JSON.stringify(result), /integration-ok/u);
  assert.ok(!result[0]?.isError, JSON.stringify(result));
});
if (configuration.packages.includes("@tintinweb/pi-subagents")) {
  await check("Agent uses separate model/context and forwards permission", async () => {
    control.plans.child = [[tool("bash", { command: "printf child-permission-ok", timeout: 10 })], final("CHILD_DONE")];
    const before = prompts.length;
    const result = await run("parent", [[tool("Agent", { subagent_type: "worker", prompt: "CASE:child Execute fixture command.", description: "fixture worker", run_in_background: false })]], "PARENT_PRIVATE_MARKER");
    const child = control.seen.filter((entry) => entry.key === "child");
    assert.ok(child.length > 0, JSON.stringify(result)); assert.ok(child.every((entry) => entry.model === "worker"));
    assert.ok(child.every((entry) => !JSON.stringify(entry.messages).includes("PARENT_PRIVATE_MARKER")));
    assert.ok(prompts.length > before); assert.match(JSON.stringify(result), /CHILD_DONE/u);
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
  await check("background shell task produces output and completes", async () => {
    let result = await run("bg-start", [[tool("bg_run", { name: "Local fixture output", command: "printf BACKGROUND_OK",
      isAgent: false, timeoutSeconds: 10 })]]);
    assert.ok(!result[0]?.isError, JSON.stringify(result));
    const taskId = result[0].details?.task?.id; assert.ok(taskId, JSON.stringify(result));
    assert.equal(result[0].details.task.triggerOnCompletion, false);
    // Windows shell startup is not bounded by an arbitrary 500ms sleep.
    // Poll only inside this offline fixture; the production agent uses notifications.
    const deadline = Date.now() + 15000;
    let poll = 0;
    do {
      result = await run(`bg-status-${poll++}`, [[tool("bg_status", { taskId })]]);
      assert.ok(!result[0]?.isError, JSON.stringify(result));
      if (!["running", "queued"].includes(result[0].details.tasks[0].status)) break;
      assert.ok(Date.now() < deadline, "Fixture background task did not finish within 15 seconds");
      await delay(200);
    } while (true);
    assert.equal(result[0].details.tasks[0].status, "completed");
    result = await run("bg-output", [[tool("bg_logs", { taskId })]]);
    assert.ok(!result[0]?.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /BACKGROUND_OK/u);
  });
}
if (configuration.packages.includes("pi-advisor-flow")) {
  await check("advisor uses second fixture model through patched ModelRuntime", async () => {
    await session.prompt("/advisor");
    control.plans.advice = [final("ADVISOR_APPROVED_FIXTURE")];
    const result = await run("advisor", [[tool("ask_advisor", { question: "CASE:advice Review local fixture.", gitContext: "none" })]]);
    assert.equal(result.length, 1); assert.ok(!result[0].isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /ADVISOR_APPROVED_FIXTURE/u);
    assert.ok(control.seen.some((entry) => entry.key === "advice" && entry.model === "worker"));
    await session.prompt("/advisor-off");
  });
}
await check("workspace checkpoint, undo and redo restore actual file contents", async () => {
  const target = path.join(cwd, "restore.txt");
  fs.writeFileSync(target, "BEFORE\n");
  await session.prompt("/checkpoint fixture baseline");
  assert.ok(sessionManager.getEntries().some(entry => entry.customType === "workspace-history.snapshot" && entry.data?.kind === "manual"));
  await run("workspace-edit", [[tool("write", {path: "restore.txt", content: "AFTER\n"})]]);
  assert.equal(fs.readFileSync(target,"utf8"), "AFTER\n");
  await session.prompt("/undo");
  assert.equal(fs.readFileSync(target,"utf8"), "BEFORE\n", JSON.stringify(notices));
  await session.prompt("/redo");
  assert.equal(fs.readFileSync(target,"utf8"), "AFTER\n");
});
await check("headless permission asks fail closed", async () => {
  session.extensionRunner.setUIContext(undefined, "print");
  const result = await run("headless", [[tool("bash", { command: "printf forbidden > headless-forbidden.txt", timeout: 5 })]]);
  assert.equal(result[0]?.isError, true, JSON.stringify(result));
  assert.ok(!fs.existsSync(path.join(cwd, "headless-forbidden.txt")));
  const background = await run("headless-background", [[tool("bg_run", { name: "Denied job", isAgent: false, command: "printf forbidden > bg-forbidden.txt", triggerOnCompletion: false })]]);
  assert.equal(background[0]?.isError, true, JSON.stringify(background));
  assert.ok(!fs.existsSync(path.join(cwd,"bg-forbidden.txt")));
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
