// Đánh giá bộ phân loại của pi-auto-mode bằng model thật (gọi provider, tốn quota hoặc tiền).
// Cách dùng: node scripts/auto-mode-eval.mjs [--model provider/id] [--stage2-model provider/id] [--jev | --jev-only]
//   [--root <pi-platform root>] [--agent-dir <agent dir>] [--only <chuỗi trong tên>] [--concurrency N]
// --jev: giai đoạn 1 bằng Jev như auto mode (key từ SYSTEMONE_API_KEY/TYPESAFE_API_KEY hoặc keyring của pi-mcp-adapter),
// giai đoạn 2 bằng LLM. --jev-only: chỉ Jev, không gọi LLM; rẻ, dùng để chỉnh autoMode.jev.flagAt/riskAt. Khi có Jev,
// script chạy thêm bộ lệnh hiệu chỉnh eval/screen-cases.json (khoảng 270 lệnh, dưới 2 xu Mỹ).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../assets/extensions/pi-auto-mode/lib/config.ts";
import { formatReport, formatScreenCorpus, jevEvalScreen, runEval, runScreenCorpus } from "../assets/extensions/pi-auto-mode/lib/eval.ts";
import { loadKeyStore, resolveAccess } from "../assets/extensions/pi-auto-mode/lib/jev.ts";
import { decide, SAFE_TOOLS } from "../assets/extensions/pi-auto-mode/lib/policy.ts";
import { resolveSlots } from "../assets/extensions/pi-auto-mode/lib/prompt.ts";
import { buildRuleSet } from "../assets/extensions/pi-auto-mode/lib/rules.ts";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = path.resolve(option("--root") ?? path.join(os.homedir(), ".local", "share", "pi-platform"));
const agentDir = path.resolve(option("--agent-dir") ?? path.join(os.homedir(), ".pi", "agent"));
const config = loadConfig(agentDir);
const modules = path.join(root, "runtimes", "current", "node_modules");
const jevOnly = args.includes("--jev-only");
const useJev = jevOnly || args.includes("--jev");

let screen;
if (useJev) {
  const access = resolveAccess(process.env, await loadKeyStore(modules));
  if (access.status !== "ready") {
    console.error(`Jev không dùng được: ${access.status === "missing" ? "chưa có key (đặt TYPESAFE_API_KEY hoặc pi-mcp-adapter key set systemone)" : access.message}`);
    process.exit(1);
  }
  screen = jevEvalScreen(access, config.jev);
}

let complete = async () => { throw new Error("--jev-only không gọi LLM"); };
let label = `Jev ${config.jev.model} only (stage 1)`;
if (!jevOnly) {
  const modelSpec = option("--model") ?? config.model;
  const stage2Spec = option("--stage2-model") ?? config.stage2Model ?? modelSpec;
  if (!modelSpec) throw new Error("Cần --model provider/id hoặc autoMode.model trong settings.json");
  const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  const resolve = (spec) => {
    const slash = spec.indexOf("/");
    const model = slash > 0 ? runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
    if (!model) throw new Error(`Không tìm thấy model ${spec}`);
    if (!runtime.hasConfiguredAuth(model.provider)) throw new Error(`Provider ${model.provider} chưa đăng nhập`);
    return model;
  };
  const stage1 = resolve(modelSpec);
  const stage2 = resolve(stage2Spec);
  const cacheKey = `pi-auto-mode-eval:${Date.now()}`;
  complete = async (request, options) => {
    const model = options.stage === 2 ? stage2 : stage1;
    const content = [...request.blocks, request.suffix].map((text) => ({ type: "text", text }));
    const stream = runtime.streamSimple(model, { systemPrompt: request.systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] }, {
      maxTokens: options.maxTokens, signal: options.signal, sessionId: cacheKey, cacheRetention: "short",
      ...(options.reasoning && options.reasoning !== "off" ? { reasoning: options.reasoning } : {}),
    });
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || message.stopReason);
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  };
  label = `${screen ? `Jev ${config.jev.model} → ` : ""}${modelSpec}${stage2Spec !== modelSpec ? ` + ${stage2Spec}` : ""}`;
}

const casesFile = fileURLToPath(new URL("../assets/extensions/pi-auto-mode/eval/cases.json", import.meta.url));
let cases = JSON.parse(fs.readFileSync(casesFile, "utf8")).cases;
const only = option("--only");
if (only) cases = cases.filter((item) => item.name.includes(only));

// Chỉ đo bộ phân loại và lối đi nhanh: không dùng luật allow/ask/deny của máy.
const context = { mode: "auto", cwd: "/home/dev/project", home: "/home/dev", roots: ["/home/dev/project"], rules: buildRuleSet([], [], []), selfPaths: ["/home/dev/.pi/agent/settings.json"] };
const outcomes = await runEval(cases, {
  slots: resolveSlots({ ...config, deny: [] }, []), complete, timeoutMs: config.timeoutMs, stage2Reasoning: config.stage2Reasoning,
  decide: (call) => decide(call, context), skipTools: SAFE_TOOLS, concurrency: Number(option("--concurrency") ?? (jevOnly ? 6 : 3)),
  screen, screenOnly: jevOnly,
  onProgress: (done, total) => process.stderr.write(`\r${done}/${total}`),
});
process.stderr.write("\n");
console.log(formatReport(outcomes, label, jevOnly));
// Chỉ Jev: chỉ lệnh nguy hiểm bị cho qua mới là lỗi (gắn cờ nhầm chỉ tốn một lần gọi giai đoạn 2).
let failed = outcomes.filter((item) => (jevOnly ? item.expect === "block" && item.got === "allow" : item.got !== item.expect)).length;
if (screen && !only) {
  // Bộ lệnh hiệu chỉnh giai đoạn 1: đo cả lệnh rủi ro bị bỏ lọt lẫn lệnh thường phải gọi LLM.
  const corpusFile = fileURLToPath(new URL("../assets/extensions/pi-auto-mode/eval/screen-cases.json", import.meta.url));
  const corpus = await runScreenCorpus(JSON.parse(fs.readFileSync(corpusFile, "utf8")), screen, Number(option("--concurrency") ?? 6),
    (done, total) => process.stderr.write(`\r${done}/${total}`));
  process.stderr.write("\n");
  console.log(`\n${formatScreenCorpus(corpus, `Jev ${config.jev.model}, flagAt ${config.jev.flagAt}, riskAt ${config.jev.riskAt}`)}`);
  failed += corpus.filter((item) => item.label === "flag" && item.kind === "clear").length;
}
process.exitCode = failed ? 1 : 0;
