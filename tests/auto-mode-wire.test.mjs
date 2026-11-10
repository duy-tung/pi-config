import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { classify } from "../assets/extensions/pi-auto-mode/lib/classifier.ts";
import { completionRequest, completionText } from "../assets/extensions/pi-auto-mode/lib/completion.ts";
import { sse } from "./search-fixtures.mjs";

// Bộ phân loại với Sonnet 5.5 qua Claude OAuth (pi-ai và pi-anthropic-auth của bản cài, fetch giả, không gọi mạng):
// - Sonnet 5.5 không tắt được suy luận; giai đoạn 1 gửi mức thấp nhất (low), không để pi-ai mặc định effort "high";
// - dấu cache nằm ở khối transcript, câu dặn của giai đoạn đứng sau dấu, nên giai đoạn 2 đọc lại cache giai đoạn 1 vừa ghi.
const root = process.env.PI_CONFIG_TEST_ROOT;
const reply = (text) => [
  { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
];

test("bộ phân loại qua Claude OAuth: effort thấp nhất ở giai đoạn 1, hai giai đoạn chung tiền tố tới dấu cache ở transcript", { skip: !root, timeout: 120000 }, async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-mode-wire-")));
  const agentDir = path.join(temp, "agent");
  fs.mkdirSync(agentDir);
  const modules = path.join(root, "runtimes", "current", "node_modules");
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "sk-ant-oat01-fixture", refresh: "fixture-refresh", expires: Date.now() + 3600000 },
  }));
  const saved = { fetch: globalThis.fetch, agentDir: process.env.PI_CODING_AGENT_DIR };
  const bodies = [];
  const answers = ["<block>yes</block>", "<block>no</block>"];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.anthropic.com" || url.pathname !== "/v1/messages") return new Response("unexpected fixture request", { status: 599 });
    bodies.push(JSON.parse(typeof init.body === "string" ? init.body : await input.text()));
    return new Response(sse(reply(answers.shift() ?? "")), { headers: { "content-type": "text/event-stream" } });
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const load = (relative) => import(pathToFileURL(path.join(modules, relative)).href);
    const sdk = await load("@earendil-works/pi-coding-agent/dist/index.js");
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
    const { createJiti } = await load("@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js");
    const shaping = await createJiti(import.meta.url, { moduleCache: false, interopDefault: true })
      .import(path.join(modules, "@gotgenes", "pi-anthropic-auth", "src", "index.ts"), { default: true });
    await shaping({ registerProvider: (id, config) => runtime.registerProvider(id, config), unregisterProvider: (id) => runtime.unregisterProvider(id), on: () => {}, registerCommand: () => {} });
    const model = runtime.getModel("anthropic", "claude-sonnet-5-5");
    const complete = async (request, options) => {
      const built = completionRequest(model, request, options, "pi-auto-mode:wire");
      return completionText(await runtime.completeSimple(model, built.context, built.options));
    };
    const blocks = ["<user_instructions>\n## AGENTS.md\nfixture\n</user_instructions>", "<transcript>\n{\"user\":\"push\"}\n{\"bash\":\"git push --force\"}\n</transcript>"];
    assert.deepEqual(await classify({ systemPrompt: "SYSTEM", blocks, complete, timeoutMs: 30_000, stage2Reasoning: "low" }), { kind: "allow", stage: 2 });
    assert.equal(bodies.length, 2);
    const userOf = (body) => body.messages.findLast((message) => message.role === "user");
    for (const [index, body] of bodies.entries()) {
      const stage = `giai đoạn ${index + 1}`;
      assert.match(body.system[0].text, /^x-anthropic-billing-header:/u, "Request phải qua shaping OAuth");
      assert.equal(body.thinking.type, "adaptive", stage);
      assert.deepEqual(body.messages.at(-1).output_config, { effort: "low" }, stage);
      const user = userOf(body);
      assert.deepEqual(user.content.map((part) => part.text.slice(0, 7)), ["<user_i", "<transc", `Stage ${index + 1}`], stage);
      assert.deepEqual(user.content.map((part) => !!part.cache_control), [false, true, false], stage);
    }
    assert.equal(bodies[0].max_tokens, 1024);
    const prefix = (body) => JSON.stringify({ system: body.system, user: userOf(body).content.slice(0, 2) });
    assert.equal(prefix(bodies[0]), prefix(bodies[1]), "Hai giai đoạn giống nhau tới hết khối có dấu cache");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
