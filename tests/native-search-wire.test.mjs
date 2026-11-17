import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { anthropicFetchEvents, anthropicSearchEvents, sse } from "./search-fixtures.mjs";

// web_search của pi-web-access (đã vá, có provider anthropic) trên runtime đã cài: Claude → Anthropic web_search
// qua pi-anthropic-auth; không có provider dự phòng, model khác không tìm được. fetch_content tải thẳng trang đích. fetch/DNS giả, không gọi mạng.
const root = process.env.PI_CONFIG_TEST_ROOT;
test("web_search chỉ dùng native search của Claude; fetch_content tải thẳng, lỗi thì dùng web_fetch của Claude", { skip: !root, timeout: 120000 }, async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-search-")));
  const agentDir = path.join(temp, "agent");
  fs.mkdirSync(agentDir);
  const modules = path.join(root, "runtimes", "current", "node_modules");
  const installed = JSON.parse(fs.readFileSync(path.join(root, "install-state.json"), "utf8")).agentDir;
  const web = JSON.parse(fs.readFileSync(path.join(installed, "web-search.json"), "utf8"));
  fs.writeFileSync(path.join(agentDir, "web-search.json"), JSON.stringify(web));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["@gotgenes/pi-anthropic-auth", "pi-web-access"].map((name) => path.join(modules, name)),
    skills: [], quietStartup: true, cacheWarming: "off", compaction: { enabled: false },
  }));
  const expires = Date.now() + 3600000;
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "sk-ant-oat01-fixture", refresh: "fixture-refresh", expires },
    "opencode-go": { type: "api_key", key: "synthetic-wire-fixture" },
  }));

  const saved = { fetch: globalThis.fetch, lookup: dns.promises.lookup, agentDir: process.env.PI_CODING_AGENT_DIR };
  const requests = [];
  let anthropicStatus = 200, fetchResult = "text";
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const text = typeof init.body === "string" ? init.body : input instanceof Request ? await input.text() : "";
    requests.push({ url, headers, body: text ? JSON.parse(text) : undefined });
    const stream = (body) => new Response(body, { headers: { "content-type": "text/event-stream" } });
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      if (anthropicStatus === 400) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Web search is not enabled for this organization" } }, { status: 400 });
      const body = text ? JSON.parse(text) : {};
      if (body.tools?.some((tool) => tool.name === "web_fetch")) return stream(sse(anthropicFetchEvents({ result: fetchResult })));
      return stream(sse(anthropicSearchEvents()));
    }
    // Trang đích của fetch_content: HTML thường.
    // Trang chặn máy này: tải thẳng lỗi 403.
    if (url.origin === "https://docs.example" && url.pathname.startsWith("/blocked")) return new Response("Forbidden", { status: 403 });
    if (url.origin === "https://docs.example") {
      const body = `<!doctype html><html><head><title>Pi guide</title></head><body><main><article><h1>Pi guide</h1>${"<p>Pi reads files, runs commands and edits code in your project.</p>".repeat(12)}</article></main></body></html>`;
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("unexpected fixture request", { status: 599 });
  };
  // SSRF guard của pi-web-access phân giải DNS trước khi tải trang đích; trả địa chỉ công khai giả.
  dns.promises.lookup = async (hostname, options) => {
    if (hostname !== "docs.example") throw new Error(`Unexpected DNS lookup: ${hostname}`);
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
    // Pi làm mới ảnh chụp auth khi mở phiên; không có bước này thì hasConfiguredAuth luôn false và fetchModel bị bỏ qua.
    await runtime.refresh({ allowNetwork: false });
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
    assert.match(tool.description, /^Search the web for sources or answers\./u);
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
    assert.deepEqual(claude.body.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_callers: ["direct"] }]);
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
    // pi-anthropic-auth >= 3.3.2 giữ system message effort theo lượt; Pi đặt nó theo reasoning "low" của request phụ.
    assert.deepEqual(requests[0].body.messages.at(-1), { role: "system", content: [], output_config: { effort: "low" } });
    // Tổ chức tắt web search (400): không có provider dự phòng, lỗi được báo lại và không host nào khác bị gọi.
    anthropicStatus = 400;
    text = await search("anthropic", "claude-sonnet-5");
    assert.deepEqual(requests.map((request) => request.url.origin + request.url.pathname), ["https://api.anthropic.com/v1/messages"]);
    assert.match(text, /Configured search routing exhausted:/u, text);
    assert.match(text, /anthropic \[unsupported\]: .*web search unavailable for this account/u, text);
    anthropicStatus = 200;

    // Model không phải Claude chính thức: không có provider nào dùng được, không request nào được gửi.
    text = await search("opencode-go", "glm-5.3-flash");
    assert.deepEqual(requests.map((request) => request.url.href), []);
    assert.match(text, /Configured search routing exhausted:\n  - anthropic: unavailable/u, text);

    // fetch_content: tải thẳng trang đích rồi trích nội dung tại chỗ; tải được thì không host nào khác được gọi.
    const fetchTool = session.extensionRunner.getToolDefinition("fetch_content");
    assert.ok(fetchTool, "pi-web-access phải đăng ký fetch_content");
    requests.length = 0;
    const fetched = await fetchTool.execute("wire", { url: "https://docs.example/guide" }, new AbortController().signal, undefined, session.extensionRunner.createContext());
    text = fetched.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.deepEqual(requests.map((request) => request.url.href), ["https://docs.example/guide"]);
    assert.match(text, /Pi reads files, runs commands and edits code in your project\./u);

    const fetchPage = async (url) => {
      requests.length = 0;
      const result = await fetchTool.execute("wire", { url }, new AbortController().signal, undefined, session.extensionRunner.createContext());
      return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    };
    const hosts = () => requests.map((request) => request.url.origin + request.url.pathname);
    // Tải thẳng lỗi (403) trong phiên không phải Claude: fetchModel đã cấu hình và có auth Anthropic nên web_fetch vẫn chạy.
    text = await fetchPage("https://docs.example/blocked-glm");
    assert.deepEqual([...new Set(hosts())], ["https://docs.example/blocked-glm", "https://api.anthropic.com/v1/messages"], text);
    assert.equal(requests.find((request) => request.url.hostname === "api.anthropic.com").body.model, "claude-haiku-5-5");
    assert.match(text, /Pi guide fetched by Anthropic\./u, text);
    // Tải thẳng lỗi, phiên Claude: web_fetch của Anthropic tải trang bằng model fetchModel (Haiku 5.5), gọi thẳng, một lần.
    await session.setModel(runtime.getModel("anthropic", "claude-sonnet-5"));
    text = await fetchPage("https://docs.example/blocked");
    assert.deepEqual([...new Set(hosts())], ["https://docs.example/blocked", "https://api.anthropic.com/v1/messages"], text);
    const native = requests.find((request) => request.url.hostname === "api.anthropic.com");
    assert.deepEqual(native.body.tools, [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 1, max_content_tokens: 50000, allowed_callers: ["direct"] }]);
    assert.equal(native.body.model, "claude-haiku-5-5");
    assert.match(native.body.system[0].text, /^x-anthropic-billing-header:/u);
    assert.match(JSON.stringify(native.body.messages), /Fetch this URL: https:\/\/docs\.example\/blocked/u);
    assert.match(text, /Pi guide fetched by Anthropic\./u, text);
    // Anthropic cũng từ chối URL (lỗi nằm trong block, HTTP 200): lỗi của cả hai đường được báo lại.
    fetchResult = "url_not_allowed";
    text = await fetchPage("https://docs.example/blocked-twice");
    assert.match(text, /Anthropic web fetch failed: Anthropic web fetch error: url_not_allowed/u, text);
    fetchResult = "text";
    assert.doesNotMatch(text, /<article>|<p>/u, "nội dung đã được trích khỏi HTML");
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
