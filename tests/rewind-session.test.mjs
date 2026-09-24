import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// /clear của pi-rewind trên runtime thật của bản cài: phiên mới, /rewind có "Resume previous session"
// để quay lại phiên cũ. Không gọi model, mọi fetch đều bị chặn.
const root = process.env.PI_CONFIG_TEST_ROOT;
test("/clear mở phiên mới, /rewind → Resume previous session quay lại phiên cũ", { skip: !root, timeout: 120000 }, async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-rewind-session-")));
  const agentDir = path.join(temp, "agent"), cwd = path.join(temp, "work"), sessions = path.join(temp, "sessions");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  const modules = path.join(root, "runtimes", "current", "node_modules");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: [path.join(root, "assets", "extensions", "pi-rewind")], skills: [],
    quietStartup: true, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
    doubleEscapeAction: "none", rewind: { storageDir: path.join(temp, "rewind") },
  }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
  const saved = { fetch: globalThis.fetch, agentDir: process.env.PI_CODING_AGENT_DIR };
  globalThis.fetch = async () => { throw new Error("network is blocked in this fixture"); };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let runtime;
  try {
    const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
    // Phiên cũ đã có câu trả lời nên Pi đã ghi nó ra đĩa.
    const first = sdk.SessionManager.create(cwd, sessions);
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    first.appendMessage({ role: "user", content: "fix the login bug", timestamp: Date.now() });
    first.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fixed." }], api: "anthropic-messages", provider: "fixture", model: "fixture", usage: zero, stopReason: "stop", timestamp: Date.now() });
    const firstFile = first.getSessionFile();
    assert.ok(fs.existsSync(firstFile));
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime = await sdk.createAgentSessionRuntime(async ({ cwd: target, sessionManager, sessionStartEvent }) => {
      const services = await sdk.createAgentSessionServices({ cwd: target, agentDir, modelRuntime });
      return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })), services, diagnostics: services.diagnostics };
    }, { cwd, agentDir, sessionManager: sdk.SessionManager.open(firstFile, sessions) });
    const answers = [], notices = [], errors = [];
    const ui = {
      ...Object.fromEntries(["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"].map((key) => [key, () => {}])),
      onTerminalInput: () => () => {}, input: async () => undefined, editor: async () => undefined, confirm: async () => true,
      getEditorComponent: () => undefined, getAllThemes: () => [], setTheme: () => ({ success: true }), getTheme: () => undefined,
      theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, italic: (text) => text, dim: (text) => text },
      select: async (_title, options) => options.find((option) => option === answers[0]) && answers.shift(),
      notify: (message) => notices.push(message),
      custom: async () => { throw new Error("Unexpected TUI dialog in RPC fixture"); },
      getToolsExpanded: () => false, getEditorText: () => "",
    };
    const bind = () => runtime.session.bindExtensions({
      uiContext: ui, mode: "rpc", onError: (error) => errors.push(error),
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        switchSession: (file, options) => runtime.switchSession(file, options),
        fork: (entryId, options) => runtime.fork(entryId, options),
        navigateTree: (entryId, options) => runtime.session.navigateTree(entryId, options),
        reload: () => runtime.session.reload(),
      },
    });
    runtime.setRebindSession(bind);
    await bind();
    assert.ok(runtime.session.extensionRunner.getRegisteredCommands().some((command) => command.name === "clear"));

    await runtime.session.prompt("/clear");
    assert.notEqual(runtime.session.sessionFile, firstFile);
    assert.equal(runtime.session.messages.length, 0);
    assert.ok(notices.some((message) => /Resume previous session/u.test(message)), JSON.stringify(notices));
    answers.push("Resume previous session", "Resume previous session");
    await runtime.session.prompt("/rewind");
    assert.deepEqual(answers, [], "Menu phải có mục Resume previous session và màn hình xác nhận");
    assert.equal(runtime.session.sessionFile, firstFile);
    assert.ok(runtime.session.messages.some((message) => message.role === "user"));
    assert.deepEqual(errors, []);
  } finally {
    await runtime?.dispose();
    globalThis.fetch = saved.fetch;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
