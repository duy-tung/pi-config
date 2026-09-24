import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { anthropicSearchEvents, sse } from "./search-fixtures.mjs";

// Opus 5.5 qua gói Pro/Max: Pi gửi effort theo lượt bằng system message rỗng, pi-anthropic-auth bỏ
// message đó; bản vá phải đưa đúng mức /thinking của phiên vào output_config. fetch giả, không gọi mạng.
const root = process.env.PI_CONFIG_TEST_ROOT;
test("Opus 5.5 qua OAuth gửi đúng mức thinking của phiên", { skip: !root, timeout: 120000 }, async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-effort-")));
  const agentDir = path.join(temp, "agent");
  fs.mkdirSync(agentDir);
  const modules = path.join(root, "runtimes", "current", "node_modules");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [path.join(modules, "@gotgenes", "pi-anthropic-auth")], extensions: [], skills: [],
    quietStartup: true, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
  }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "sk-ant-oat01-fixture", refresh: "fixture-refresh", expires: Date.now() + 3600000 },
  }));
  const saved = { fetch: globalThis.fetch, agentDir: process.env.PI_CODING_AGENT_DIR };
  const bodies = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.anthropic.com" || url.pathname !== "/v1/messages") return new Response("unexpected fixture request", { status: 599 });
    bodies.push(JSON.parse(typeof init.body === "string" ? init.body : await input.text()));
    return new Response(sse(anthropicSearchEvents({ model: "claude-opus-5-5" })), { headers: { "content-type": "text/event-stream" } });
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
    const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
    const { session } = await sdk.createAgentSession({ cwd: temp, agentDir, resourceLoader: loader, modelRuntime: runtime, sessionManager: sdk.SessionManager.inMemory(temp) });
    const errors = [];
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
    await session.setModel(runtime.getModel("anthropic", "claude-opus-5-5"));
    for (const level of ["medium", "max", "high"]) {
      session.setThinkingLevel(level);
      bodies.length = 0;
      await session.prompt(`Effort fixture ${level}`);
      assert.equal(bodies.length, 1);
      const [body] = bodies;
      assert.match(body.system[0].text, /^x-anthropic-billing-header:/u, "Request phải qua shaping OAuth");
      assert.equal(body.thinking.type, "adaptive");
      assert.equal(body.output_config.effort, level);
      assert.ok(!body.messages.some((message) => message.role === "system" && Array.isArray(message.content) && message.content.length === 0));
    }
    assert.deepEqual(errors, []);
    session.dispose();
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
