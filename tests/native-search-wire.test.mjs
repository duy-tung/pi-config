import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { anthropicSearchEvents, codexSearchEvents, sse } from "./search-fixtures.mjs";

// web_search của pi-web-access (đã vá, có provider anthropic) trên runtime đã cài: Claude → Anthropic web_search
// qua pi-anthropic-auth, Codex → hosted web_search, GLM → Exa rồi Firecrawl. fetch/DNS giả, không gọi mạng.
const root = process.env.PI_CONFIG_TEST_ROOT;
test("web_search dùng native search theo model hiện tại, GLM dùng Exa rồi Firecrawl", { skip: !root, timeout: 120000 }, async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-search-")));
  const agentDir = path.join(temp, "agent");
  fs.mkdirSync(agentDir);
  const modules = path.join(root, "runtimes", "current", "node_modules");
  const installed = JSON.parse(fs.readFileSync(path.join(root, "profiles.json"), "utf8")).main.agentDir;
  const web = JSON.parse(fs.readFileSync(path.join(installed, "web-search.json"), "utf8"));
  web.firecrawlApiKey = "fixture-firecrawl-key"; // Không chạy credential helper của máy.
  fs.writeFileSync(path.join(agentDir, "web-search.json"), JSON.stringify(web));
  fs.copyFileSync(path.join(installed, "models.json"), path.join(agentDir, "models.json"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["@gotgenes/pi-anthropic-auth", "pi-web-access"].map((name) => path.join(modules, name)),
    skills: [], quietStartup: true, cacheWarming: "off", compaction: { enabled: false },
  }));
  const jwt = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
  const expires = Date.now() + 3600000;
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "sk-ant-oat01-fixture", refresh: "fixture-refresh", expires },
    "openai-codex": { type: "oauth", access: jwt, refresh: "fixture-refresh", expires },
    "opencode-go": { type: "api_key", key: "synthetic-wire-fixture" },
  }));

  const saved = { fetch: globalThis.fetch, lookup: dns.promises.lookup, agentDir: process.env.PI_CODING_AGENT_DIR };
  const requests = [];
  let exaStatus = 200, anthropicStatus = 200;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const text = typeof init.body === "string" ? init.body : input instanceof Request ? await input.text() : "";
    requests.push({ url, headers, body: text ? JSON.parse(text) : undefined });
    const stream = (body) => new Response(body, { headers: { "content-type": "text/event-stream" } });
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      if (anthropicStatus === 400) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Web search is not enabled for this organization" } }, { status: 400 });
      return stream(sse(anthropicSearchEvents()));
    }
    if (url.href === "https://chatgpt.com/backend-api/codex/responses") return stream(sse(codexSearchEvents("gpt-6-astra")));
    // Exa không có key: JSON-RPC tới endpoint MCP miễn phí của Exa.
    if (url.origin === "https://mcp.exa.ai" && url.pathname === "/mcp") {
      if (exaStatus !== 200) return new Response("fixture unavailable", { status: exaStatus });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text",
        text: "Title: Exa result\nURL: https://exa.example/pi\nText: From Exa\n" }] } });
    }
    if (url.href === "https://api.firecrawl.dev/v2/search") {
      return Response.json({ success: true, data: { web: [{ url: "https://firecrawl.example/pi", title: "Firecrawl result", description: "From Firecrawl" }] } });
    }
    return new Response("unexpected fixture request", { status: 599 });
  };
  // SSRF guard của pi-web-access phân giải DNS trước khi gọi Firecrawl; trả địa chỉ công khai giả.
  dns.promises.lookup = async (hostname, options) => {
    if (hostname !== "api.firecrawl.dev") throw new Error(`Unexpected DNS lookup: ${hostname}`);
    const address = { address: "104.18.20.1", family: 4 };
    return options?.all ? [address] : address;
  };
  syncBuiltinESMExports();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
    const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const { session } = await sdk.createAgentSession({ cwd: temp, agentDir, resourceLoader: loader, modelRuntime: runtime, sessionManager: sdk.SessionManager.inMemory(temp) });
    const errors = [];
    const noop = () => {};
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error), uiContext: {
      setStatus: noop, setWorkingMessage: noop, setWidget: noop, setFooter: noop, setHeader: noop, setTitle: noop, notify: noop,
      select: async () => undefined, confirm: async () => false, input: async () => undefined, custom: async () => undefined,
      onTerminalInput: () => noop, getToolsExpanded: () => false, setToolsExpanded: noop, getEditorText: () => "", setEditorText: noop, pasteToEditor: noop,
      theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, italic: (text) => text, dim: (text) => text },
    } });
    const tool = session.extensionRunner.getToolDefinition("web_search");
    assert.ok(tool, "pi-web-access phải đăng ký web_search");
    assert.match(tool.description, /^Search the web with OpenAI, Anthropic, Exa, Firecrawl\./u);
    const search = async (provider, id) => {
      requests.length = 0;
      await session.setModel(runtime.getModel(provider, id));
      const result = await tool.execute("wire", { query: "pi coding agent", numResults: 2 }, new AbortController().signal, undefined, session.extensionRunner.createContext());
      return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    };

    let text = await search("anthropic", "claude-sonnet-5");
    assert.equal(requests.length, 1, JSON.stringify(requests.map((request) => request.url.href)));
    const [claude] = requests;
    assert.equal(claude.headers.get("authorization"), "Bearer sk-ant-oat01-fixture");
    assert.match(claude.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/u);
    assert.deepEqual(claude.body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
    assert.equal(claude.body.model, "claude-sonnet-5");
    assert.match(claude.body.system[0].text, /^x-anthropic-billing-header:/u, "pi-anthropic-auth phải shape request phụ");
    assert.match(JSON.stringify(claude.body.messages), /Search the web for: pi coding agent/u);
    assert.match(text, /\*\*Provider:\*\* anthropic/u);
    assert.match(text, /Pi is a minimal coding agent with extensions\./u);
    assert.match(text, /https:\/\/code\.example\/pi/u);
    // Model không tắt được thinking: tìm kiếm với effort thấp, shaping OAuth vẫn giữ effort.
    await search("anthropic", "claude-opus-5-5");
    assert.equal(requests[0].body.thinking.type, "adaptive");
    assert.equal(requests[0].body.output_config.effort, "low");
    // Tổ chức tắt web search (400): bộ phân loại coi là unsupported và chuyển sang Exa.
    anthropicStatus = 400;
    text = await search("anthropic", "claude-sonnet-5");
    assert.deepEqual(requests.map((request) => request.url.origin + request.url.pathname), ["https://api.anthropic.com/v1/messages", "https://mcp.exa.ai/mcp"]);
    assert.match(text, /\*\*Provider:\*\* exa/u);
    anthropicStatus = 200;

    text = await search("openai-codex", "gpt-6-astra");
    assert.equal(requests.length, 1, JSON.stringify(requests.map((request) => request.url.href)));
    const [codex] = requests;
    assert.equal(codex.body.model, "gpt-6-astra");
    assert.deepEqual(codex.body.tools, [{ type: "web_search" }]);
    assert.equal(codex.headers.get("chatgpt-account-id"), "fixture-account");
    assert.match(text, /\*\*Provider:\*\* openai/u);
    assert.match(text, /https:\/\/code\.example\/pi/u);

    text = await search("opencode-go", "glm-5.3-flash");
    assert.deepEqual(requests.map((request) => request.url.origin + request.url.pathname), ["https://mcp.exa.ai/mcp"]);
    assert.equal(requests[0].headers.get("authorization"), null);
    assert.equal(requests[0].body.method, "tools/call");
    assert.match(JSON.stringify(requests[0].body.params.arguments), /pi coding agent/u);
    assert.match(text, /\*\*Provider:\*\* exa/u);
    assert.match(text, /https:\/\/exa\.example\/pi/u);

    // Exa lỗi tạm thời (5xx) thì chuyển sang Firecrawl.
    exaStatus = 503;
    text = await search("opencode-go", "glm-5.3-flash");
    assert.deepEqual(requests.map((request) => request.url.origin + request.url.pathname), ["https://mcp.exa.ai/mcp", "https://api.firecrawl.dev/v2/search"]);
    assert.equal(requests[1].headers.get("authorization"), "Bearer fixture-firecrawl-key");
    assert.match(text, /\*\*Provider:\*\* firecrawl/u);
    assert.deepEqual(errors, []);
    session.dispose();
  } finally {
    globalThis.fetch = saved.fetch;
    dns.promises.lookup = saved.lookup;
    syncBuiltinESMExports();
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
