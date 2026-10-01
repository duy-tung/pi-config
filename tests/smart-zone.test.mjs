import assert from "node:assert/strict";
import test from "node:test";
import smartZone from "../assets/extensions/smart-zone/index.ts";
import { budgetReport, contextFileEntries, skillEntries, skillRoot, toolSource } from "../assets/extensions/smart-zone/lib/budget.ts";
import { COMPACTION_NOTICE, crossedUp, DEFAULT_EDGE, formatTokens, parseTokens, zoneHint, zoneOf } from "../assets/extensions/smart-zone/lib/zone.ts";

test("mép smart zone: đọc 150k, 1m, số trần; giá trị sai dùng mặc định", () => {
  assert.equal(parseTokens(undefined), DEFAULT_EDGE);
  assert.equal(parseTokens("200k"), 200_000);
  assert.equal(parseTokens("1M"), 1_000_000);
  assert.equal(parseTokens(" 1.5m "), 1_500_000);
  assert.equal(parseTokens("90000"), 90_000);
  for (const bad of ["", "abc", "-5k", "0", "12x"]) assert.equal(parseTokens(bad), DEFAULT_EDGE, bad);
});

test("vùng: xanh dưới 2/3 mép, vàng tới mép, đỏ khi quá mép", () => {
  assert.equal(zoneOf(0, 150_000), "green");
  assert.equal(zoneOf(99_999, 150_000), "green");
  assert.equal(zoneOf(100_000, 150_000), "yellow");
  assert.equal(zoneOf(149_999, 150_000), "yellow");
  assert.equal(zoneOf(150_000, 150_000), "red");
  assert.deepEqual([formatTokens(950), formatTokens(42_300), formatTokens(1_000_000), formatTokens(1_500_000)], ["1k", "42k", "1M", "1.5M"]);
});

test("nhắc cho model chỉ khi vùng đi lên (xanh→vàng, vàng→đỏ), mỗi lần vượt một lần", () => {
  assert.equal(crossedUp(undefined, "green"), false);
  assert.equal(crossedUp(undefined, "yellow"), true);
  assert.equal(crossedUp("green", "red"), true);
  assert.equal(crossedUp("yellow", "red"), true);
  assert.equal(crossedUp("red", "red"), false);
  assert.equal(crossedUp("red", "yellow"), false);
  assert.equal(crossedUp("yellow", undefined), false);
  assert.match(zoneHint("red", 160_000, 150_000), /^\[smart-zone\] Context 160k\/150k: đã quá mép smart zone\..*\/skill:handoff/u);
  assert.match(zoneHint("yellow", 110_000, 150_000), /gần mép smart zone/u);
});

// Cùng định dạng Pi 0.87.1 dựng system prompt (renderProjectContext, formatSkillsForPrompt).
const skill = (name, location) => `  <skill>\n    <name>${name}</name>\n    <description>${name} description</description>\n    <location>${location}</location>\n  </skill>`;
const prompt = [
  "You are an expert coding assistant.",
  "Project-specific instructions and guidelines:",
  `<project_instructions path="/home/dev/.pi/agent/AGENTS.md">\n${"x".repeat(4000)}\n</project_instructions>`,
  `<project_instructions path="/repo/AGENTS.md">\n${"y".repeat(400)}\n</project_instructions>`,
  "The following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.",
  "<available_skills>",
  skill("tdd", "/opt/pi/assets/skills/tdd/SKILL.md"),
  skill("prove", "/opt/pi/assets/skills/prove/SKILL.md"),
  skill("firecrawl-scrape", "C:\\pi\\sources\\firecrawl-cli-source\\skills\\firecrawl-scrape\\SKILL.md"),
  "</available_skills>",
  "Current working directory: /repo",
].join("\n");

test("đọc context file và danh sách skill từ system prompt", () => {
  const files = contextFileEntries(prompt);
  assert.deepEqual(files.map((file) => file.path), ["/home/dev/.pi/agent/AGENTS.md", "/repo/AGENTS.md"]);
  assert.ok(files[0].chars > 4000);
  const skills = skillEntries(prompt);
  assert.equal(skills.skills.length, 3);
  assert.ok(skills.chars > skills.skills.reduce((sum, entry) => sum + entry.chars, 0), "gồm cả đoạn dẫn và thẻ bao");
  assert.equal(skillRoot(skills.skills[0].location), "/opt/pi/assets/skills");
  assert.equal(skillRoot(skills.skills[2].location), "C:/pi/sources/firecrawl-cli-source/skills");
  assert.deepEqual(skillEntries("không có skill"), { chars: 0, skills: [] });
});

test("nguồn tool: package trong node_modules, thư mục extension, built-in", () => {
  assert.equal(toolSource({ name: "Agent", sourceInfo: { path: "/r/node_modules/@tintinweb/pi-subagents/dist/index.js" } }), "@tintinweb/pi-subagents");
  assert.equal(toolSource({ name: "web_search", sourceInfo: { path: "C:\\r\\node_modules\\pi-web-access\\index.ts" } }), "pi-web-access");
  assert.equal(toolSource({ name: "x", sourceInfo: { path: "/r/assets/extensions/pi-rewind/index.ts" } }), "pi-rewind");
  assert.equal(toolSource({ name: "y", sourceInfo: { path: "/r/assets/extensions/rose-pine-palette.ts" } }), "rose-pine-palette");
  assert.equal(toolSource({ name: "read", sourceInfo: { source: "builtin" } }), "builtin");
  assert.equal(toolSource({ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } }), "builtin");
  assert.equal(toolSource({ name: "read" }), "built-in");
});

test("báo cáo /context-budget: từng phần, nhóm theo nguồn, chỉ tool đang bật", () => {
  const tools = [
    { name: "read", description: "Read a file", parameters: { type: "object" }, sourceInfo: { source: "builtin" } },
    { name: "Agent", description: "d".repeat(4000), parameters: { type: "object" }, sourceInfo: { path: "/r/node_modules/@tintinweb/pi-subagents/dist/index.js" } },
    { name: "fetch_content", description: "inactive", parameters: {}, sourceInfo: { path: "/r/node_modules/pi-web-access/index.ts" } },
  ];
  const report = budgetReport({
    systemPrompt: prompt, activeTools: ["read", "Agent"], tools, edge: 150_000,
    skills: [{ name: "tdd" }, { name: "work", disableModelInvocation: true }, { name: "ship", disableModelInvocation: true }],
    usage: { tokens: 42_000, contextWindow: 1_000_000 },
  });
  assert.match(report, /^System prompt ≈ 1\.3k token$/mu);
  assert.match(report, /^ {2}Context file \(2\) ≈ 1\.1k$/mu);
  assert.match(report, /^ {4}\/home\/dev\/\.pi\/agent\/AGENTS\.md ≈ 1k$/mu);
  assert.match(report, /^ {2}Danh sách skill \(3 skill model thấy; 2 skill chỉ người gọi, 0 token\) ≈ \d+$/mu);
  assert.match(report, /^ {4}\/opt\/pi\/assets\/skills ≈ \d+ \(2\)$/mu);
  assert.match(report, /^Định nghĩa tool đang bật \(2\) ≈ 1k token$/mu);
  assert.match(report, /^ {2}@tintinweb\/pi-subagents ≈ 1k \(1\): Agent$/mu);
  assert.doesNotMatch(report, /fetch_content/u);
  assert.match(report, /mép smart zone 150k · context hiện tại 42k\/1M$/mu);
});

function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const pi = {
    sendMessage: async (message, options) => { sent.push([message, options]); },
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, spec) => commands.set(name, spec),
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", description: "Read", parameters: {}, sourceInfo: { source: "builtin" } }],
  };
  return { pi, handlers, commands, sent };
}

function fakeCtx(tokens, { hasUI = true } = {}) {
  const calls = { status: [], notify: [] };
  const ctx = {
    hasUI,
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: null }),
    getSystemPrompt: () => prompt,
    getSystemPromptOptions: () => ({ skills: [{ name: "tdd" }] }),
    ui: {
      theme: { fg: (color, text) => `<${color}>${text}` },
      setStatus: (key, value) => calls.status.push([key, value]),
      notify: (message, level) => calls.notify.push([message, level]),
    },
  };
  return { ctx, calls };
}

test("extension: không hiện gì ở footer, nhắc model khi vượt mép và khi auto-compaction chạy, bỏ qua agent con", async () => {
  const { pi, handlers, commands, sent } = fakePi();
  smartZone(pi);
  const green = fakeCtx(10_000);
  handlers.get("session_start")({}, green.ctx);
  assert.deepEqual(green.calls.status, [], "không có nhãn footer");
  assert.equal(sent.length, 0, "vùng xanh không nhắc model");
  const red = fakeCtx(160_000);
  handlers.get("turn_end")({}, red.ctx);
  assert.deepEqual(red.calls.status, []);
  // Lần đầu vượt lên đỏ thì xếp một nhắc ẩn vào lượt kế tiếp; các lượt đỏ sau không nhắc lại.
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].customType, "smart-zone");
  assert.equal(sent[0][0].display, false);
  assert.match(sent[0][0].content, /đã quá mép smart zone/u);
  assert.deepEqual(sent[0][1], { deliverAs: "nextTurn" });
  handlers.get("turn_end")({}, fakeCtx(170_000).ctx);
  assert.equal(sent.length, 1);
  // Ngay sau compaction chưa có số token: chỉ báo auto-compaction.
  const compacted = fakeCtx(null);
  handlers.get("session_compact")({ reason: "threshold" }, compacted.ctx);
  assert.deepEqual(compacted.calls.status, []);
  assert.deepEqual(compacted.calls.notify, [[COMPACTION_NOTICE, "warning"]]);
  // Sau compaction context tụt về: vượt lên vàng lần nữa thì nhắc lại.
  handlers.get("turn_end")({}, fakeCtx(20_000).ctx);
  handlers.get("turn_end")({}, fakeCtx(120_000).ctx);
  assert.equal(sent.length, 2);
  assert.match(sent[1][0].content, /gần mép smart zone/u);
  const manual = fakeCtx(null);
  handlers.get("session_compact")({ reason: "manual" }, manual.ctx);
  assert.deepEqual(manual.calls.notify, []);
  const child = fakeCtx(160_000, { hasUI: false });
  handlers.get("turn_end")({}, child.ctx);
  handlers.get("session_compact")({ reason: "overflow" }, child.ctx);
  assert.deepEqual(child.calls, { status: [], notify: [] });
  assert.equal(sent.length, 2, "agent con không nhận nhắc");
  // Context cũ (sau /new) ném lỗi: bỏ qua, không làm hỏng phiên.
  const stale = fakeCtx(10_000);
  stale.ctx.ui.setStatus = () => { throw new Error("stale"); };
  assert.doesNotThrow(() => handlers.get("turn_end")({}, stale.ctx));
  // /context-budget đưa báo cáo vào hội thoại (agent đọc được ở lượt sau), không tự mở lượt mới.
  const budget = fakeCtx(42_000);
  await commands.get("context-budget").handler("", budget.ctx);
  const [report, options] = sent.at(-1);
  assert.equal(report.customType, "context-budget");
  assert.equal(report.display, true);
  assert.match(report.content, /^Context luôn-bật/u);
  assert.deepEqual(options, { triggerTurn: false });
});
