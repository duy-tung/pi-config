#!/usr/bin/env node
// Chạy bộ case tests/auto-mode-eval/cases.json qua bộ phân loại của pi-auto-mode với model thật (tốn lượt gọi model).
// Model đi qua ModelRuntime của runtime Pi đã cài, đọc auth.json của Pi; Claude OAuth được shaping bằng pi-anthropic-auth
// như request của Pi. Cách dùng: node scripts/eval-auto-mode.mjs [--model provider/id] [--reasoning low] [--concurrency 4] [--only <tên>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classify } from "../assets/extensions/pi-auto-mode/lib/classifier.ts";
import { completionRequest, completionText } from "../assets/extensions/pi-auto-mode/lib/completion.ts";
import { buildSystemPrompt, resolveSlots, userInstructions } from "../assets/extensions/pi-auto-mode/lib/prompt.ts";
import { decide, SAFE_TOOLS } from "../assets/extensions/pi-auto-mode/lib/policy.ts";
import { buildRuleSet } from "../assets/extensions/pi-auto-mode/lib/rules.ts";
import { buildTranscript } from "../assets/extensions/pi-auto-mode/lib/transcript.ts";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const agentDir = flag("agent-dir", path.join(os.homedir(), ".pi", "agent"));
const modules = flag("runtime", path.join(os.homedir(), ".local", "share", "pi-platform", "runtimes", "current", "node_modules"));
const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
const [provider, ...rest] = flag("model", settings.autoMode?.model ?? "anthropic/claude-sonnet-5-5").split("/");
const reasoning = flag("reasoning", settings.autoMode?.stage2Reasoning ?? "low");
const concurrency = Math.max(1, Number(flag("concurrency", "4")));
const only = flag("only");

// getAgentDir() của Pi và extension đọc biến này; --agent-dir phải có hiệu lực với chúng.
process.env.PI_CODING_AGENT_DIR = agentDir;
const load = (relative) => import(pathToFileURL(path.join(modules, relative)).href);
const sdk = await load("@earendil-works/pi-coding-agent/dist/index.js");
const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), refreshOnCreate: false });
await runtime.refresh({ allowNetwork: false });
if (provider === "anthropic") {
  const { createJiti } = await load("@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js");
  const shaping = await createJiti(import.meta.url, { moduleCache: false, interopDefault: true })
    .import(path.join(modules, "@gotgenes", "pi-anthropic-auth", "src", "index.ts"), { default: true });
  await shaping({ registerProvider: (id, config) => runtime.registerProvider(id, config), unregisterProvider: (id) => runtime.unregisterProvider(id), on: () => {}, registerCommand: () => {} });
}
const model = runtime.getModel(provider, rest.join("/"));
if (!model) throw new Error(`model ${provider}/${rest.join("/")} không có trong catalog của Pi`);
if (!runtime.hasConfiguredAuth(provider)) throw new Error(`chưa đăng nhập ${provider}; chạy pi → /login`);

// Cùng ngữ cảnh giả với test tất định: repo tin cậy có remote, đường dẫn ngoài /home.
const cwd = "/srv/dev/project";
const facts = [`Working directory: ${cwd}`, `Platform: ${process.platform}`, `Trusted repository: ${cwd} (branch main at session start)`, "Trusted remotes (at session start): origin git@github.com:example/project.git"];
const systemPrompt = buildSystemPrompt(resolveSlots({ environment: ["$defaults"], hardDeny: ["$defaults"], softDeny: ["$defaults"], allowRules: ["$defaults"], deny: [] }, facts));
const context = { mode: "auto", cwd, home: "/srv/dev", roots: [cwd], rules: buildRuleSet([], [], []), selfPaths: [] };
// Như extension: AGENTS.md toàn cục (bản trong repo) đi kèm làm chỉ dẫn thường trực.
const instructions = userInstructions([{ path: "AGENTS.md", content: fs.readFileSync(new URL("../assets/AGENTS.md", import.meta.url), "utf8") }]);
const runtimeVersion = JSON.parse(fs.readFileSync(path.join(modules, "@earendil-works/pi-coding-agent/package.json"), "utf8")).version;

// Cùng request với extension và pi-agent (lib/completion.ts): mức suy luận, giới hạn token, dấu cache.
const complete = async (request, options) => {
  const built = completionRequest(model, request, options, "pi-config-eval");
  return completionText(await runtime.completeSimple(model, built.context, built.options));
};

function entries(item) {
  let time = 1;
  const list = item.user.map((text) => ({ type: "message", message: { role: "user", content: text, timestamp: time++ } }));
  item.history.forEach((step, index) => list.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `h${index}`, name: step.tool, arguments: step.input }] } }));
  list.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "action", name: item.action.tool, arguments: item.action.input }] } });
  return list;
}

async function run(item) {
  // Case do luật hay lối đi nhanh quyết định không tới model; test tất định đã kiểm nhãn của chúng.
  const decision = decide({ toolName: item.action.tool, input: item.action.input }, context);
  if (decision.kind !== "classify") return { name: item.name, expect: item.expect, got: decision.kind === "allow" ? "allow" : "block", via: decision.kind, ms: 0 };
  const transcript = buildTranscript(entries(item), { action: { toolName: item.action.tool, input: item.action.input, toolCallId: "action" }, meta: { cwd, ...(decision.notes.length ? { notes: decision.notes } : {}), ...item.meta }, skipTools: SAFE_TOOLS });
  const started = Date.now();
  const result = await classify({ systemPrompt, blocks: [instructions, transcript], complete, timeoutMs: 60_000, stage2Reasoning: reasoning });
  const ms = Date.now() - started;
  if (result.kind === "unavailable") return { name: item.name, expect: item.expect, got: "error", via: result.reason, ms };
  return { name: item.name, expect: item.expect, got: result.kind, via: `stage ${result.stage}${result.kind === "block" && result.rule ? ` ${result.rule}` : ""}${result.fallback ? " fallback" : ""}`, ms };
}

const { cases } = JSON.parse(fs.readFileSync(new URL("../tests/auto-mode-eval/cases.json", import.meta.url), "utf8"));
const queue = cases.filter((item) => !only || item.name === only);
const results = [];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) results.push(await run(item));
}));

const order = new Map(cases.map((item, index) => [item.name, index]));
results.sort((a, b) => order.get(a.name) - order.get(b.name));
for (const row of results) console.log(`${row.got === row.expect ? "ok  " : "MISS"} ${row.expect.padEnd(5)} → ${row.got.padEnd(5)} ${String(row.ms).padStart(6)} ms  ${row.via}  ${row.name}`);
const count = (predicate) => results.filter(predicate).length;
const timed = results.filter((row) => row.ms > 0 && row.got !== "error").map((row) => row.ms).sort((a, b) => a - b);
const pct = (p) => (timed.length ? timed[Math.min(timed.length - 1, Math.floor(p * timed.length))] : 0);
const summary = {
  model: `${provider}/${rest.join("/")}`, reasoning, pi: runtimeVersion, concurrency, cases: results.length,
  dangerousLeaked: `${count((row) => row.expect === "block" && row.got === "allow")}/${count((row) => row.expect === "block")}`,
  benignBlocked: `${count((row) => row.expect === "allow" && row.got !== "allow")}/${count((row) => row.expect === "allow")}`,
  errors: count((row) => row.got === "error"),
  toModel: count((row) => row.ms > 0), stage2: count((row) => row.via.startsWith("stage 2")),
  p50ms: pct(0.5), p90ms: pct(0.9),
};
console.log(JSON.stringify(summary));
process.exitCode = results.some((row) => row.got !== row.expect) ? 1 : 0;
