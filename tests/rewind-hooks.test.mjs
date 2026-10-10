import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Hook của pi-rewind trên runtime thật của bản cài: /tree và /fork của Pi khôi phục code, lệnh `!` của người dùng được
// theo dõi, lượt bị dừng (Esc) vẫn có checkpoint và được báo. Provider giả chạy theo kịch bản, mọi fetch đều bị chặn.
const root = process.env.PI_CONFIG_TEST_ROOT;
const rewindDir = fileURLToPath(new URL("../assets/extensions/pi-rewind", import.meta.url));
const CONTROL = Symbol.for("pi-config:rewind-hooks-test");

const PROVIDER = `import * as ai from "@earendil-works/pi-ai";
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export default function (pi) {
  pi.registerProvider("rewind-test", {
    api: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "local-fixture-no-network",
    models: [{ id: "model", name: "model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
    streamSimple(model, _context, options) {
      const stream = ai.createAssistantMessageEventStream();
      const control = globalThis[Symbol.for("pi-config:rewind-hooks-test")];
      const step = control.steps.shift() ?? [{ type: "text", text: "DONE" }];
      void (async () => {
        await Promise.resolve();
        const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: zero, timestamp: Date.now() };
        if (step === "hang") {
          // Như provider thật: chờ tới khi người dùng dừng lượt (Esc).
          await new Promise((resolve) => {
            if (options?.signal?.aborted) return resolve();
            options?.signal?.addEventListener("abort", resolve, { once: true });
            control.hanging?.();
          });
          const message = { ...base, content: [], stopReason: "aborted", errorMessage: "Request was aborted" };
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
          return;
        }
        const message = { ...base, content: step, stopReason: step.some((part) => part.type === "toolCall") ? "toolUse" : "stop" };
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      })();
      return stream;
    },
  });
}
`;

let sequence = 0;
const write = (file, content) => ({ type: "toolCall", id: `call-${sequence++}`, name: "write", arguments: { path: file, content } });
const done = [{ type: "text", text: "DONE" }];

async function harness(t, { git = false } = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-rewind-hooks-")));
  const agentDir = path.join(temp, "agent"), cwd = path.join(temp, "work"), sessions = path.join(temp, "sessions");
  const storageDir = path.join(temp, "rewind");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  if (git) {
    const run = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "fixture@example.invalid");
    run("config", "user.name", "fixture");
    fs.writeFileSync(path.join(cwd, "b.txt"), "base\n");
    run("add", "b.txt");
    run("commit", "-q", "-m", "base");
  }
  fs.writeFileSync(path.join(temp, "provider.ts"), PROVIDER);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: [path.join(temp, "provider.ts"), rewindDir], skills: [],
    defaultProvider: "rewind-test", defaultModel: "model", defaultThinkingLevel: "off",
    quietStartup: true, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
    doubleEscapeAction: "none", rewind: { storageDir, watchSlowMs: 60000 },
  }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
  const control = { steps: [] };
  const saved = { fetch: globalThis.fetch, agentDir: process.env.PI_CODING_AGENT_DIR };
  globalThis.fetch = async () => { throw new Error("network is blocked in this fixture"); };
  globalThis[CONTROL] = control;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let runtime;
  t.after(async () => {
    await runtime?.dispose();
    delete globalThis[CONTROL];
    globalThis.fetch = saved.fetch;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const modules = path.join(root, "runtimes", "current", "node_modules");
  const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  runtime = await sdk.createAgentSessionRuntime(async ({ cwd: target, sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({ cwd: target, agentDir, modelRuntime });
    return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })), services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, sessions) });
  const answers = [], titles = [], notices = [], errors = [];
  const ui = {
    ...Object.fromEntries(["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"].map((key) => [key, () => {}])),
    onTerminalInput: () => () => {}, input: async () => undefined, editor: async () => undefined, confirm: async () => true,
    getEditorComponent: () => undefined, getAllThemes: () => [], setTheme: () => ({ success: true }), getTheme: () => undefined,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, italic: (text) => text, dim: (text) => text },
    select: async (title, options) => {
      titles.push(title);
      return options.find((option) => option === answers[0]) && answers.shift();
    },
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
  const prompt = async (text, ...steps) => {
    control.steps.push(...steps);
    await runtime.session.prompt(text);
    await runtime.session.waitForIdle();
  };
  const userEntries = () => runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
  const rewindEntries = (kind) => runtime.session.sessionManager.getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-rewind" && entry.data?.kind === kind).map((entry) => entry.data);
  const read = (file) => fs.readFileSync(path.join(cwd, file), "utf8");
  // Vị trí hội thoại: leaf bỏ qua entry ghi chép của pi-rewind (lần khôi phục được ghi sau khi điều hướng).
  const position = () => {
    const manager = runtime.session.sessionManager;
    let entry = manager.getEntry(manager.getLeafId());
    while (entry?.type === "custom" && entry.customType === "pi-rewind") entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
    return entry?.id ?? null;
  };
  return { runtime: () => runtime, cwd, storageDir, control, answers, titles, notices, errors, prompt, userEntries, rewindEntries, read, position };
}

const ASK_TREE = /^Rewind: also restore the code to this point\?/u;
const ASK_FORK = /^Rewind: also restore the code to this point for the forked session\?/u;

test("/tree tới prompt cũ hỏi khôi phục code; Never mind hủy điều hướng; Redo đưa code và hội thoại về; /rewind không hỏi lại", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t);
  await h.prompt("one", [write("a.txt", "v1")], done);
  await h.prompt("two", [write("a.txt", "v2")], done);
  const [, second] = h.userEntries();
  const session = h.runtime().session;
  const leaf = session.sessionManager.getLeafId();

  h.answers.push("Never mind");
  assert.equal((await session.navigateTree(second.id, { summarize: false })).cancelled, true);
  assert.equal(session.sessionManager.getLeafId(), leaf, "Never mind giữ nguyên hội thoại");
  assert.equal(h.read("a.txt"), "v2");
  assert.match(h.titles.at(-1), ASK_TREE);
  assert.match(h.titles.at(-1), /a\.txt/u);

  h.answers.push("Restore code and conversation");
  assert.equal((await session.navigateTree(second.id, { summarize: false })).cancelled, false);
  assert.deepEqual(h.answers, []);
  assert.equal(h.read("a.txt"), "v1", "code về như trước prompt two");
  assert.equal(h.position(), second.parentId);
  assert.ok(h.notices.some((message) => /Restored the code in a\.txt/u.test(message)), JSON.stringify(h.notices));
  assert.deepEqual(h.rewindEntries("rewind").map((entry) => [entry.mode, entry.fromLeafId]), [["both", leaf]]);

  await session.prompt("/redo");
  assert.equal(h.read("a.txt"), "v2", "Redo đưa code về như trước /tree");
  assert.equal(h.position(), leaf, "Redo quay lại nhánh cũ");

  // Chọn "Restore conversation only" thì chỉ đổi hội thoại (điều hướng của Pi, quay lại bằng /tree).
  h.answers.push("Restore conversation only");
  await session.navigateTree(second.id, { summarize: false });
  assert.equal(h.read("a.txt"), "v2");
  assert.equal(h.position(), second.parentId);
  assert.equal(h.rewindEntries("rewind").length, 1, "không ghi lần khôi phục khi code giữ nguyên");
  await session.navigateTree(leaf, { summarize: false });
  assert.equal(h.position(), leaf);

  // /rewind tự điều hướng: hook /tree không hỏi thêm.
  const asked = h.titles.length;
  h.answers.push("2. two", "Restore conversation");
  await session.prompt("/rewind");
  assert.deepEqual(h.answers, []);
  assert.equal(h.titles.slice(asked).filter((title) => ASK_TREE.test(title)).length, 0, JSON.stringify(h.titles.slice(asked)));
  assert.equal(h.read("a.txt"), "v2");
  assert.deepEqual(h.errors, []);
});

test("/tree tới câu trả lời cũ: code như trước prompt kế tiếp; code đã khớp thì không hỏi", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t);
  await h.prompt("one", [write("a.txt", "v1")], done);
  await h.prompt("two", [write("a.txt", "v2")], done);
  const session = h.runtime().session;
  const branch = session.sessionManager.getBranch();
  const second = h.userEntries()[1];
  const answer = branch[branch.findIndex((entry) => entry.id === second.id) - 1];
  assert.equal(answer.message.role, "assistant");
  h.answers.push("Restore code and conversation");
  await session.navigateTree(answer.id, { summarize: false });
  assert.equal(h.read("a.txt"), "v1");
  assert.equal(h.position(), answer.id);

  // Không hỏi: câu trả lời cuối của nhánh cũ không nằm trên nhánh hiện tại (không biết code ở điểm đó), và quay lại
  // câu trả lời cũ khi code đã khớp thì không có gì để khôi phục.
  const asked = h.titles.length;
  await session.navigateTree(branch.at(-1).id, { summarize: false });
  assert.equal(h.read("a.txt"), "v1");
  await session.navigateTree(answer.id, { summarize: false });
  assert.equal(h.titles.length, asked, JSON.stringify(h.titles.slice(asked)));
  assert.deepEqual(h.errors, []);
});

test("/fork hỏi ở phiên cũ, ghi code trong phiên mới; Redo trong phiên mới đưa code về", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t);
  await h.prompt("one", [write("a.txt", "v1")], done);
  await h.prompt("two", [write("a.txt", "v2")], done);
  const [, second] = h.userEntries();
  const oldFile = h.runtime().session.sessionFile;
  h.answers.push("Restore code");
  assert.equal((await h.runtime().fork(second.id)).cancelled, false);
  assert.notEqual(h.runtime().session.sessionFile, oldFile);
  assert.match(h.titles.at(-1), ASK_FORK);
  assert.equal(h.read("a.txt"), "v1");
  assert.ok(h.notices.some((message) => /Restored the code in a\.txt for the forked session/u.test(message)), JSON.stringify(h.notices));
  assert.deepEqual(fs.readdirSync(h.storageDir).filter((name) => name.startsWith("fork-handoff")), []);
  await h.runtime().session.prompt("/redo");
  assert.equal(h.read("a.txt"), "v2");

  // Keep the current code: fork không đổi file; Never mind hủy fork.
  const forked = h.runtime().session.sessionFile;
  h.answers.push("Never mind");
  const first = h.userEntries()[0];
  assert.equal((await h.runtime().fork(first.id)).cancelled, true);
  assert.equal(h.runtime().session.sessionFile, forked);
  h.answers.push("Keep the current code");
  await h.runtime().fork(first.id);
  assert.deepEqual(h.answers, [], "hook đã hỏi");
  assert.match(h.titles.at(-1), ASK_FORK);
  assert.notEqual(h.runtime().session.sessionFile, forked);
  assert.equal(h.read("a.txt"), "v2");
  assert.deepEqual(fs.readdirSync(h.storageDir).filter((name) => name.startsWith("fork-handoff")), []);
  assert.deepEqual(h.errors, []);
});

test("lệnh ! của người dùng được theo dõi: /rewind → Restore code đưa file về; Pi vẫn tự chạy lệnh", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t, { git: true });
  await h.prompt("one", done);
  const session = h.runtime().session;
  // Như handleBashCommand của Pi: user_bash rồi executeBash với operations (nếu extension trả về).
  const command = "printf 'changed\\n' > b.txt";
  const intercepted = await session.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext: false, cwd: h.cwd });
  assert.equal(intercepted, undefined, "pi-rewind không thay backend bash của Pi");
  const result = await session.executeBash(command, undefined, { operations: intercepted?.operations });
  assert.equal(result.exitCode, 0);
  assert.equal(h.read("b.txt"), "changed\n");
  h.answers.push("1. one", "Restore code");
  await session.prompt("/rewind");
  assert.deepEqual(h.answers, []);
  assert.deepEqual(h.rewindEntries("touch").map((entry) => [path.basename(entry.file), entry.via]), [["b.txt", "user_bash"]]);
  assert.equal(h.read("b.txt"), "base\n");

  // Lệnh ! trước một prompt mới thuộc lượt trước: prompt mới thấy file đã đổi trong ảnh chụp của nó.
  await session.executeBash("printf 'again\\n' > b.txt", undefined, {
    operations: (await session.extensionRunner.emitUserBash({ type: "user_bash", command: "x", excludeFromContext: false, cwd: h.cwd }))?.operations,
  });
  await h.prompt("two", done);
  const touches = h.rewindEntries("touch");
  const two = h.rewindEntries("checkpoint").at(-1);
  assert.ok(touches.filter((entry) => entry.via === "user_bash").every((entry) => entry.checkpointId !== two.id), JSON.stringify(touches));
  assert.equal(path.basename(Object.keys(two.delta)[0] ?? ""), "b.txt", "ảnh chụp của prompt two có bản mới của b.txt");
  assert.deepEqual(h.errors, []);
});

test("lượt bị dừng (Esc): file đã đổi được báo; dừng trước câu trả lời đầu tiên vẫn có checkpoint", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t);
  const session = h.runtime().session;
  const stopWhenHanging = () => new Promise((resolve) => { h.control.hanging = () => { h.control.hanging = undefined; void session.abort().then(resolve); }; });

  let stopped = stopWhenHanging();
  h.control.steps.push([write("c.txt", "x")], "hang");
  await Promise.all([session.prompt("three"), stopped]);
  await session.waitForIdle();
  assert.equal(h.read("c.txt"), "x");
  assert.ok(h.notices.some((message) => /interrupted turn changed c\.txt/u.test(message)), JSON.stringify(h.notices));

  stopped = stopWhenHanging();
  h.control.steps.push("hang");
  await Promise.all([session.prompt("four"), stopped]);
  await session.waitForIdle();
  const four = h.userEntries().at(-1);
  assert.equal(four.message.content.at?.(0)?.text ?? four.message.content, "four");
  // Pi vẫn phát message_start cho câu trả lời bị hủy, nên checkpoint của prompt được ghi như thường.
  assert.ok(h.rewindEntries("checkpoint").some((entry) => entry.userEntryId === four.id), "prompt bị dừng trước câu trả lời vẫn có checkpoint");
  assert.deepEqual(h.errors, []);
});

test("bash bị dừng giữa chừng: file nó đã đổi vẫn được ghi để khôi phục", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t, { git: true });
  await h.prompt("one", done);
  const session = h.runtime().session;
  const bash = { type: "toolCall", id: `call-${sequence++}`, name: "bash", arguments: { command: "printf 'killed\\n' > b.txt; sleep 30" } };
  h.control.steps.push([bash]);
  const running = session.prompt("two");
  const deadline = Date.now() + 20000;
  while (h.read("b.txt") !== "killed\n") {
    assert.ok(Date.now() < deadline, "bash chưa ghi b.txt");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await session.abort();
  await running;
  await session.waitForIdle();
  assert.ok(h.rewindEntries("touch").some((entry) => path.basename(entry.file) === "b.txt"), JSON.stringify(h.rewindEntries("touch")));
  h.answers.push("2. two", "Restore code");
  await session.prompt("/rewind");
  assert.deepEqual(h.answers, []);
  assert.equal(h.read("b.txt"), "base\n");
  assert.deepEqual(h.errors, []);
});

test("/tree: code không ghi được (kho đang bị process khác khóa) thì báo lỗi, Redo vẫn đưa hội thoại về", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t);
  await h.prompt("one", [write("a.txt", "v1")], done);
  await h.prompt("two", [write("a.txt", "v2")], done);
  const [, second] = h.userEntries();
  const session = h.runtime().session;
  const leaf = session.sessionManager.getLeafId();
  // Khóa của một process còn sống (chính process test): pi-rewind chờ 5 giây rồi báo bận.
  fs.writeFileSync(path.join(h.storageDir, "lock"), `${process.pid}\nfixture`);
  h.answers.push("Restore code and conversation");
  await session.navigateTree(second.id, { summarize: false });
  assert.equal(h.read("a.txt"), "v2", "code giữ nguyên");
  assert.equal(h.position(), second.parentId, "hội thoại đã chuyển");
  assert.ok(h.notices.some((message) => /Another Pi process is restoring code[\s\S]*Redo goes back/u.test(message)), JSON.stringify(h.notices));
  fs.rmSync(path.join(h.storageDir, "lock"));
  await session.prompt("/redo");
  assert.equal(h.position(), leaf);
  assert.equal(h.read("a.txt"), "v2");
  assert.deepEqual(h.errors, []);
});

test("/rewind dừng lượt đang chạy để khôi phục: không báo \"lượt bị dừng\"", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t);
  await h.prompt("one", [write("a.txt", "v1")], done);
  const session = h.runtime().session;
  let hanging;
  const reached = new Promise((resolve) => { hanging = resolve; });
  h.control.hanging = () => hanging();
  h.control.steps.push([write("a.txt", "v2")], "hang");
  const running = session.prompt("two");
  await reached;
  h.answers.push("2. two", "Restore code");
  await session.prompt("/rewind");
  await running;
  await session.waitForIdle();
  assert.deepEqual(h.answers, []);
  assert.equal(h.read("a.txt"), "v1");
  assert.ok(!h.notices.some((message) => /interrupted turn/u.test(message)), JSON.stringify(h.notices));
  assert.deepEqual(h.errors, []);
});

test("/tree tới custom message: không đoán code (lượt do thông báo mở không có checkpoint) nên không hỏi", { skip: !root, timeout: 120000 }, async (t) => {
  const h = await harness(t);
  await h.prompt("one", [write("a.txt", "v1")], done);
  const session = h.runtime().session;
  const custom = session.sessionManager.appendCustomMessageEntry("fixture-note", "background job finished", true);
  await h.prompt("two", [write("a.txt", "v2")], done);
  const asked = h.titles.length;
  await session.navigateTree(custom, { summarize: false });
  assert.equal(h.titles.length, asked, JSON.stringify(h.titles.slice(asked)));
  assert.equal(h.read("a.txt"), "v2");
  assert.deepEqual(h.errors, []);
});
