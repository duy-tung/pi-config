import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clock, fitLine, formatWindow, MAX_LINES, modelId, plain, shortModel, statusLine, widgetLines } from "../assets/extensions/agent-tree/lib/format.ts";
import {
  DEFAULT_MAX_CONCURRENT, dominantThinking, parseFrontmatter, readAdvisor, readAutoMode, readMaxConcurrent, readRoles, readSources, sortRoles,
} from "../assets/extensions/agent-tree/lib/sources.ts";
import { applyAdvisor, applyDecision, applySubagent, createState, DECISION_EVENT, firstLine, formatDuration, LOG_LIMIT, pushLog } from "../assets/extensions/agent-tree/lib/state.ts";
import { agentTree } from "../assets/extensions/agent-tree/lib/tree.ts";
import { DECISION_EVENT as AUTO_MODE_DECISION_EVENT } from "../assets/extensions/pi-auto-mode/lib/decision-event.ts";

function agentDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tree-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

const role = (name, model, thinking) => `---\nname: ${name}\ndescription: vai ${name}\nmodel: ${model}\nthinking: ${thinking}\ntools: "read, grep"\n---\nThân.\n`;
const TREE_FILES = {
  "agents/worker.md": role("worker", "anthropic/claude-opus-5-5", "medium"),
  "agents/explorer.md": role("explorer", "anthropic/claude-opus-5-5", "medium"),
  "agents/researcher.md": role("researcher", "anthropic/claude-opus-5-5", "medium"),
  "agents/debugger.md": role("debugger", "anthropic/claude-opus-5-5", "medium"),
  "agents/reviewer.md": role("reviewer", "anthropic/claude-fable-5-1", "high"),
  "agents/verifier.md": role("verifier", "anthropic/claude-fable-5-1", "high"),
  "advisor.json": { alwaysOn: true, advisor: "anthropic/claude-fable-5-1", advisorEffort: "high", advisorPlanGate: true, advisorMaxCallsPerSession: 7 },
  "subagents.json": { maxConcurrent: 4 },
  "settings.json": { autoMode: { model: "anthropic/claude-opus-5-5", stage2Reasoning: "low" } },
};

test("frontmatter và vai: đọc model/thinking, worker, explorer, researcher đứng trước", (t) => {
  assert.deepEqual(parseFrontmatter('---\nname: worker\nmodel: "openai/gpt"\nthinking: max\n---\nbody: no\n'), { name: "worker", model: "openai/gpt", thinking: "max" });
  assert.deepEqual(parseFrontmatter("không có frontmatter"), {});
  assert.deepEqual(parseFrontmatter("---\r\nname: a\r\n---\r\n"), { name: "a" });
  const dir = agentDir(t, { ...TREE_FILES, "agents/notes.txt": "bỏ qua", "agents/bare.md": "---\ndescription: thiếu model\n---\n" });
  const roles = readRoles(dir);
  assert.deepEqual(roles.map((item) => item.name), ["worker", "explorer", "researcher", "bare", "debugger", "reviewer", "verifier"]);
  assert.deepEqual(roles[0], { name: "worker", model: "anthropic/claude-opus-5-5", thinking: "medium" });
  assert.deepEqual(roles[3], { name: "bare", model: undefined, thinking: undefined });
  assert.equal(dominantThinking(roles), "medium");
  // Hoà: vai đứng trước theo thứ tự hiển thị thắng.
  assert.equal(dominantThinking(sortRoles([{ name: "reviewer", thinking: "high" }, { name: "worker", thinking: "max" }])), "max");
  assert.equal(dominantThinking([]), undefined);
  assert.deepEqual(readRoles(path.join(dir, "missing")), []);
});

test("advisor.json, subagents.json và autoMode: giá trị thật, thiếu thì mặc định của package", (t) => {
  const dir = agentDir(t, TREE_FILES);
  assert.deepEqual(readAdvisor(dir), {
    configured: true, alwaysOn: true, model: "anthropic/claude-fable-5-1", effort: "high", gates: ["plan", "failure", "completion"], maxCalls: 7,
  });
  const off = agentDir(t, { "advisor.json": { alwaysOn: false, advisorPlanGate: false, advisorFailureGate: false, advisorMaxCallsPerSession: "5" } });
  assert.deepEqual(readAdvisor(off), { configured: true, alwaysOn: false, model: undefined, effort: undefined, gates: ["completion"], maxCalls: undefined });
  assert.equal(readAdvisor(path.join(dir, "missing")).configured, false);
  const cwd = agentDir(t, {});
  assert.equal(readMaxConcurrent(dir, cwd), 4);
  fs.mkdirSync(path.join(cwd, ".pi"));
  fs.writeFileSync(path.join(cwd, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 2 }));
  assert.equal(readMaxConcurrent(dir, cwd), 2, "cấu hình project ghi đè như pi-subagents");
  assert.equal(readMaxConcurrent(off, off), DEFAULT_MAX_CONCURRENT);
  assert.deepEqual(readAutoMode(dir), { model: "anthropic/claude-opus-5-5", reasoning: "low", jev: true });
  const stage2 = agentDir(t, { "settings.json": { autoMode: { model: "a/b", stage2Model: "a/c", stage2Reasoning: "medium", jev: false } } });
  assert.deepEqual(readAutoMode(stage2), { model: "a/c", reasoning: "medium", jev: false });
  assert.deepEqual(readAutoMode(off), { model: undefined, reasoning: "low", jev: true });
});

test("subagent: đếm đang chạy theo sự kiện của pi-subagents, nhật ký có thời lượng", () => {
  const state = createState();
  assert.equal(applySubagent(state, "started", { type: "worker" }, 0), false, "thiếu id thì bỏ qua");
  applySubagent(state, "started", { id: "a1", type: "worker", description: "Sửa lỗi đăng nhập" }, 1_000);
  applySubagent(state, "started", { id: "a2", type: "explorer", description: "Tìm chỗ gọi API" }, 2_000);
  assert.equal(state.running.size, 2);
  applySubagent(state, "steered", { id: "a1", message: "thêm test" }, 3_000);
  applySubagent(state, "completed", { id: "a2", type: "explorer", description: "Tìm chỗ gọi API", durationMs: 12_400, status: "completed" }, 14_400);
  applySubagent(state, "failed", { id: "a1", type: "worker", status: "error", error: "tool bị chặn" }, 20_000);
  applySubagent(state, "failed", { id: "a3", type: "researcher", status: "stopped" }, 21_000);
  assert.equal(state.running.size, 0);
  assert.deepEqual(state.log.map((entry) => entry.text), [
    "worker bắt đầu · Sửa lỗi đăng nhập", "explorer bắt đầu · Tìm chỗ gọi API", "worker nhận chỉ dẫn thêm",
    "explorer xong (12s) · Tìm chỗ gọi API", "worker lỗi: tool bị chặn", "researcher bị dừng",
  ]);
  assert.deepEqual([formatDuration(950), formatDuration(12_400), formatDuration(185_000)], ["950ms", "12s", "3m05s"]);
});

test("advisor: chỉ lời gọi có lời khuyên được tính, giữ dòng đầu của lời khuyên", () => {
  const state = createState();
  const advice = (text) => ({ result: { content: [{ type: "text", text: `Advisor (claude-fable-5-1)\n\n${text}` }], details: { adviceId: "adv-1", text } } });
  applyAdvisor(state, advice("## Plan\n\n- **Chia nhỏ** migration trước khi sửa schema.\nChi tiết..."), 1);
  assert.deepEqual(state.advisor, { calls: 1, failures: 0, last: "Plan" });
  applyAdvisor(state, advice("\n1. Chạy lại test tích hợp rồi mới báo xong."), 2);
  assert.equal(state.advisor.last, "Chạy lại test tích hợp rồi mới báo xong.");
  applyAdvisor(state, { result: { content: [{ type: "text", text: "Skipped: Jev saw nothing new" }], details: { jev: { skipped: true } } } }, 3);
  applyAdvisor(state, { isError: true, result: { content: [{ type: "text", text: "Advisor call budget exhausted for this session." }] } }, 4);
  assert.deepEqual(state.advisor, { calls: 2, failures: 1, last: "Chạy lại test tích hợp rồi mới báo xong." });
  assert.deepEqual(state.log.map((entry) => entry.tone), ["accent", "accent", "muted", "error"]);
  assert.equal(firstLine("\n\n> **Dừng lại**: kiểm tra"), "Dừng lại: kiểm tra");
});

test("auto mode: sharp gộp một dòng, split ghi phán quyết, luật chặn ghi, lệnh tất định được phép thì không", () => {
  assert.equal(DECISION_EVENT, AUTO_MODE_DECISION_EVENT, "cùng tên sự kiện với pi-auto-mode");
  const state = createState();
  assert.equal(applyDecision(state, { stage: "policy", tool: "read", allowed: true, via: "safe tool" }, 1), false);
  for (const tool of ["bash", "bash", "write"]) applyDecision(state, { stage: "sharp", tool, allowed: true, score: 0.02 }, 2);
  applyDecision(state, { stage: "split", tool: "bash", allowed: false, flaggedBy: "jev", classifierStage: 2 }, 3);
  applyDecision(state, { stage: "sharp", tool: "edit", allowed: true, child: true }, 4);
  applyDecision(state, { stage: "classifier", tool: "bash", allowed: true, classifierStage: 1 }, 5);
  applyDecision(state, { stage: "classifier", tool: "bash", allowed: false, classifierStage: 2 }, 6);
  applyDecision(state, { stage: "policy", tool: "bash", allowed: false, via: "Bash(rm -rf /)" }, 7);
  applyDecision(state, { stage: "split", tool: "write", allowed: true, flaggedBy: "policy" }, 8);
  assert.equal(applyDecision(state, { stage: "sharp" }, 9), false);
  assert.deepEqual(state.jev, { sharp: 4, split: 2, llm: 2 });
  assert.deepEqual(state.log.map((entry) => [entry.text, entry.count ?? 1]), [
    ["jev sharp → chạy write", 3], ["jev split bash → chặn", 1], ["jev sharp → chạy edit (subagent)", 1], ["auto mode chặn bash", 1],
    ["luật chặn bash", 1], ["jev split write → cho phép (chính sách gắn cờ)", 1],
  ]);
  for (let index = 0; index < 30; index++) pushLog(state, { at: index, text: `e${index}` });
  assert.equal(state.log.length, LOG_LIMIT);
  assert.equal(state.log.at(-1).text, "e29");
});

function treeView(t, patch = {}) {
  const dir = agentDir(t, TREE_FILES);
  const state = createState();
  applySubagent(state, "started", { id: "w", type: "worker", description: "Sửa lỗi" }, new Date(2026, 8, 30, 23, 49, 20).getTime());
  for (let index = 0; index < 36; index++) applyDecision(state, { stage: "sharp", tool: "bash", allowed: true }, new Date(2026, 8, 30, 23, 49, 30).getTime());
  for (let index = 0; index < 5; index++) applyDecision(state, { stage: "split", tool: "bash", allowed: true, flaggedBy: "jev" }, new Date(2026, 8, 30, 23, 49, 31).getTime());
  applyAdvisor(state, { result: { content: [], details: { adviceId: "1", text: "Viết test trước khi sửa parser." } } }, new Date(2026, 8, 30, 23, 49, 32).getTime());
  applyAdvisor(state, { result: { content: [], details: { adviceId: "2", text: "Ổn, chạy verify rồi báo xong." } } }, new Date(2026, 8, 30, 23, 49, 33).getTime());
  return { main: { model: "anthropic/claude-opus-5-5", thinking: "high", contextWindow: 1_000_000 }, sources: readSources(dir, dir), state, ...patch };
}

test("footer: thinking main/subagent, agents, advisor, jev; bỏ jev khi chưa sàng lọc", (t) => {
  const view = treeView(t);
  assert.equal(plain(statusLine(view)), "high/medium · agents 1/4 · advisor 2/7 · jev 41↑5");
  const empty = { ...view, state: createState(), sources: { ...view.sources, roles: [], advisor: { ...view.sources.advisor, alwaysOn: false } } };
  assert.equal(plain(statusLine(empty)), "high · agents 0/4 · advisor off");
  const unlimited = { ...view, sources: { ...view.sources, advisor: { ...view.sources.advisor, maxCalls: undefined } } };
  assert.match(plain(statusLine(unlimited)), / · advisor 2 · /u);
  // Hết lượt advisor thì đổi màu cảnh báo.
  const spent = { ...view, sources: { ...view.sources, advisor: { ...view.sources.advisor, maxCalls: 2 } } };
  assert.ok(statusLine(spent).some((segment) => segment.text === "advisor 2/2" && segment.tone === "warning"));
});

test("widget: bố cục cây, dòng không vượt độ rộng, tối đa 10 dòng, hẹp thì bỏ cột nhãn", (t) => {
  const view = treeView(t);
  const lines = widgetLines(view, 90).map(plain);
  assert.equal(lines[0], "main      claude-opus-5-5 · high · 1M · lập kế hoạch, quyết định");
  assert.equal(lines[1], "advisor   claude-fable-5-1 · high · 2/7 lần · trước plan, lỗi lặp, trước khi xong");
  assert.equal(lines[2], "          gần nhất: Ổn, chạy verify rồi báo xong.");
  assert.equal(lines[3], "jev       41 sàng lọc · 36 sharp → chạy · 5 split → claude-opus-5-5 (low)");
  assert.equal(lines[4], "agents    1/4 đang chạy · opus-5-5/medium: worker ◐ explorer ○ researcher ○ debugger ○");
  assert.equal(lines[5], "          fable-5-1/high: reviewer ○ verifier ○");
  assert.equal(lines.filter((line) => /^(?:log {7}| {10})\d\d:\d\d:\d\d /u.test(line)).length, MAX_LINES - 6);
  assert.match(lines.at(-1), / {10}23:49:33 advisor: Ổn, chạy verify rồi báo xong\.$/u);
  assert.ok(lines.length <= MAX_LINES);
  for (const width of [90, 60, 40, 24]) {
    const fitted = widgetLines(view, width).map(plain);
    assert.ok(fitted.every((line) => [...line].length <= width), `${width}: ${fitted.find((line) => [...line].length > width)}`);
    assert.ok(fitted.length <= MAX_LINES);
  }
  assert.match(widgetLines(view, 40).map(plain)[0], /^main claude-opus-5-5 · high · 1M · lập…$/u);
  // Chưa có sự kiện, advisor tắt, Jev tắt.
  const quiet = { ...view, state: createState(), sources: { ...view.sources, advisor: { ...view.sources.advisor, alwaysOn: false }, autoMode: { reasoning: "low", jev: false } } };
  const text = widgetLines(quiet, 90).map(plain);
  assert.ok(text.includes("advisor   tắt (alwaysOn false)"));
  assert.ok(text.includes("jev       tắt (autoMode.jev false) · split → model phiên (low)"));
  assert.equal(text.at(-1), "log       chưa có sự kiện");
  assert.deepEqual(plain(fitLine([{ text: "abcdef" }, { text: "ghij" }], 5)), "abcd…");
  assert.deepEqual([modelId("anthropic/claude-opus-5-5"), shortModel("anthropic/claude-fable-5-1"), shortModel("openai-codex/gpt-6-sol"), modelId(undefined)],
    ["claude-opus-5-5", "fable-5-1", "gpt-6-sol", undefined]);
  assert.deepEqual([formatWindow(1_000_000), formatWindow(200_000), formatWindow(1_500_000)], ["1M", "200k", "1.5M"]);
  assert.equal(clock(new Date(2026, 0, 2, 3, 4, 5).getTime()), "03:04:05");
});

function fakePi() {
  const handlers = new Map(), commands = new Map(), bus = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, spec) => commands.set(name, spec),
    getThinkingLevel: () => "high",
    events: {
      on: (channel, handler) => { bus.set(channel, [...(bus.get(channel) ?? []), handler]); return () => {}; },
      emit: (channel, data) => { for (const handler of bus.get(channel) ?? []) handler(data); },
    },
  };
  return { pi, handlers, commands };
}

function fakeCtx(cwd, { hasUI = true, mode = "rpc" } = {}) {
  const calls = { status: [], widget: [], notify: [] };
  const ctx = {
    hasUI, mode, cwd,
    model: { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 },
    ui: {
      theme: { fg: (color, text) => `<${color}>${text}</>` },
      setStatus: (key, value) => calls.status.push([key, value]),
      setWidget: (key, value) => calls.widget.push([key, value]),
      notify: (message, level) => calls.notify.push([message, level]),
    },
  };
  return { ctx, calls };
}

const strip = (text) => text.replace(/<\/?[a-z]*>/gu, "");

test("extension: footer từ sự kiện thật, /agent-tree bật/tắt widget, bỏ qua agent con và context cũ", async (t) => {
  const dir = agentDir(t, TREE_FILES);
  const { pi, handlers, commands } = fakePi();
  let clockNow = new Date(2026, 8, 30, 23, 49, 28).getTime();
  agentTree(pi, { agentDir: () => dir, now: () => clockNow });
  const main = fakeCtx(dir);
  handlers.get("session_start")({ reason: "startup" }, main.ctx);
  assert.deepEqual(main.calls.status.map(([key, value]) => [key, strip(value)]), [["agent-tree", "high/medium · agents 0/4 · advisor 0/7"]]);
  assert.match(main.calls.status[0][1], /^<muted>high\/medium<\/><dim> · <\/>/u);
  pi.events.emit("subagents:started", { id: "e1", type: "explorer", description: "Tìm chỗ gọi API" });
  pi.events.emit("pi-config:auto-mode-decision", { stage: "sharp", tool: "bash", allowed: true });
  pi.events.emit("pi-config:auto-mode-decision", { stage: "split", tool: "bash", allowed: true, flaggedBy: "jev" });
  handlers.get("tool_execution_end")({ toolName: "ask_advisor", isError: false, result: { content: [], details: { adviceId: "a", text: "Chốt plan." } } }, main.ctx);
  handlers.get("tool_execution_end")({ toolName: "bash", isError: false, result: {} }, main.ctx);
  assert.equal(strip(main.calls.status.at(-1)[1]), "high/medium · agents 1/4 · advisor 1/7 · jev 2↑1");
  assert.equal(main.calls.widget.length, 0, "widget tắt mặc định");
  // RPC: widget dạng mảng chữ, chỉ gửi lại khi đổi.
  await commands.get("agent-tree").handler("", main.ctx);
  const [key, lines] = main.calls.widget.at(-1);
  assert.equal(key, "agent-tree");
  assert.ok(Array.isArray(lines));
  assert.match(strip(lines[0]), /^main {6}claude-opus-5-5 · high · 1M/u);
  assert.ok(lines.map(strip).some((line) => /23:49:28 explorer bắt đầu · Tìm chỗ gọi API$/u.test(line)));
  const sent = main.calls.widget.length;
  handlers.get("turn_end")({}, main.ctx);
  assert.equal(main.calls.widget.length, sent, "không đổi thì không gửi lại");
  clockNow += 12_000;
  pi.events.emit("subagents:completed", { id: "e1", type: "explorer", description: "Tìm chỗ gọi API", durationMs: 12_000 });
  assert.ok(main.calls.widget.at(-1)[1].map(strip).some((line) => /23:49:40 explorer xong \(12s\)/u.test(line)));
  assert.equal(strip(main.calls.status.at(-1)[1]), "high/medium · agents 0/4 · advisor 1/7 · jev 2↑1");
  await commands.get("agent-tree").handler("off", main.ctx);
  assert.deepEqual(main.calls.widget.at(-1), ["agent-tree", undefined]);
  await commands.get("agent-tree").handler("bogus", main.ctx);
  assert.deepEqual(main.calls.notify.at(-1), ["Cách dùng: /agent-tree [on|off]", "warning"]);
  assert.deepEqual(commands.get("agent-tree").getArgumentCompletions("o").map((item) => item.value), ["on", "off"]);
  // TUI: component vẽ theo độ rộng terminal, sự kiện mới chỉ yêu cầu vẽ lại.
  const tui = fakeCtx(dir, { mode: "tui" });
  await commands.get("agent-tree").handler("on", tui.ctx);
  const factory = tui.calls.widget.at(-1)[1];
  assert.equal(typeof factory, "function");
  let renders = 0;
  const component = factory({ requestRender: () => renders++ }, { fg: (_color, text) => text });
  const rendered = component.render(50);
  assert.ok(rendered.length > 4 && rendered.every((line) => [...line].length <= 50));
  assert.match(rendered[0], /^main claude-opus-5-5 · high · 1M/u);
  pi.events.emit("subagents:started", { id: "w1", type: "worker" });
  assert.equal(renders, 1);
  assert.match(component.render(90).join("\n"), /opus-5-5\/medium: worker ◐/u);
  // Phiên mới: số liệu về 0.
  handlers.get("session_start")({ reason: "new" }, tui.ctx);
  assert.equal(strip(tui.calls.status.at(-1)[1]), "high/medium · agents 0/4 · advisor 0/7");
  // Cấu hình đổi trong phiên (/advisor-off, /agents → Settings): lần cập nhật kế tiếp đọc lại file.
  fs.writeFileSync(path.join(dir, "advisor.json"), JSON.stringify({ ...TREE_FILES["advisor.json"], alwaysOn: false }));
  fs.writeFileSync(path.join(dir, "subagents.json"), JSON.stringify({ maxConcurrent: 3 }));
  handlers.get("turn_end")({}, tui.ctx);
  assert.equal(strip(tui.calls.status.at(-1)[1]), "high/medium · agents 0/3 · advisor off");
  // Agent con / print: không có UI thì không làm gì.
  const child = fakeCtx(dir, { hasUI: false });
  handlers.get("session_start")({ reason: "startup" }, child.ctx);
  handlers.get("turn_end")({}, child.ctx);
  assert.deepEqual(child.calls, { status: [], widget: [], notify: [] });
  // Context cũ ném lỗi: bỏ qua.
  const stale = fakeCtx(dir);
  stale.ctx.ui.setStatus = () => { throw new Error("stale"); };
  assert.doesNotThrow(() => handlers.get("turn_end")({}, stale.ctx));
  assert.doesNotThrow(() => pi.events.emit("subagents:failed", { id: "w1", type: "worker", status: "error" }));
});
