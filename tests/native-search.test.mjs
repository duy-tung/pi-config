import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrompt, buildWebSearchTool, SearchStreamCollector, searchError, searchReasoning, searchWithAnthropic,
  shapeSearchPayload, supportsNativeSearch, toSearchResponse,
} from "../assets/extensions/native-web-search/lib/anthropic.ts";
import { anthropicSearchEvents, sse } from "./search-fixtures.mjs";

const claude = { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5", baseUrl: "https://api.anthropic.com", thinkingLevelMap: { xhigh: "xhigh" } };
const stream = (text) => new Response(text).body;

test("native search chỉ nhận Claude trên endpoint Anthropic chính thức", () => {
  assert.equal(supportsNativeSearch(claude), true);
  assert.equal(supportsNativeSearch({ ...claude, baseUrl: "https://gateway.example/anthropic" }), false);
  assert.equal(supportsNativeSearch({ ...claude, baseUrl: "http://api.anthropic.com" }), false);
  assert.equal(supportsNativeSearch({ ...claude, provider: "opencode-go" }), false);
  assert.equal(supportsNativeSearch({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra", baseUrl: "https://chatgpt.com/backend-api" }), false);
  assert.equal(supportsNativeSearch(undefined), false);
});

test("request dùng web_search_20250305, lọc domain và prompt tìm kiếm riêng", () => {
  assert.deepEqual(buildWebSearchTool(), { type: "web_search_20250305", name: "web_search", max_uses: 5 });
  assert.deepEqual(buildWebSearchTool({ domainFilter: ["https://Docs.Example.com/path", "-spam.example", "bad"] }).allowed_domains, ["docs.example.com"]);
  const blocked = buildWebSearchTool({ domainFilter: ["-spam.example", "-spam.example"] });
  assert.deepEqual(blocked.blocked_domains, ["spam.example"]);
  assert.equal(blocked.allowed_domains, undefined);
  const { systemPrompt, prompt } = buildPrompt("latest pi release", { recencyFilter: "week", numResults: 50 });
  assert.equal(prompt, "Search the web for: latest pi release");
  assert.match(systemPrompt, /^Use the web_search tool/u);
  assert.match(systemPrompt, /past week/u);
  assert.match(systemPrompt, /around 20 distinct sources/u);
  const payload = shapeSearchPayload({ model: "claude-sonnet-5", tools: [{ name: "web_search", type: "old" }, { name: "read" }] }, buildWebSearchTool());
  assert.deepEqual(payload.tools.map((tool) => tool.type ?? tool.name), ["read", "web_search_20250305"]);
  assert.equal(payload.output_config, undefined);
  assert.deepEqual(shapeSearchPayload({ output_config: { effort: "high" } }, buildWebSearchTool()).output_config, { effort: "low" });
  assert.equal(shapeSearchPayload("raw", buildWebSearchTool()), "raw");
  assert.equal(searchReasoning(claude), undefined);
  assert.equal(searchReasoning({ ...claude, thinkingLevelMap: { off: null } }), "low");
});

test("gom SSE: bỏ lời mở đầu, nguồn được trích dẫn đứng trước", async () => {
  const collector = new SearchStreamCollector();
  await collector.consume(stream(sse(anthropicSearchEvents()).replaceAll("\n", "\r\n")));
  const summary = collector.summary();
  assert.equal(summary.searched, true);
  assert.equal(summary.answer, "Pi is a minimal coding agent with extensions.");
  assert.deepEqual(summary.queries, ["pi coding agent"]);
  assert.deepEqual(summary.results, [
    { url: "https://code.example/pi", title: "Pi source", snippet: "Pi is a minimal coding agent." },
    { url: "https://pi.example/docs", title: "Pi docs", snippet: "" },
  ]);
  const response = toSearchResponse(summary, { rawStopReason: "pause_turn" }, { numResults: 1 });
  assert.equal(response.provider, "anthropic");
  assert.equal(response.results.length, 1);
  assert.match(response.answer, /results may be incomplete/u);
});

test("lỗi được diễn đạt để routing pi-web-access chọn fallback đúng", () => {
  assert.throws(() => toSearchResponse({ searched: false, answer: "no search", results: [], queries: [], errors: [] }, {}), /no web_search_call/u);
  assert.throws(() => toSearchResponse({ searched: true, answer: "", results: [], queries: [], errors: ["too_many_requests"] }, {}), /rate limit/u);
  assert.throws(() => toSearchResponse({ searched: true, answer: "", results: [], queries: [], errors: ["unavailable"] }, {}), /temporarily unavailable/u);
  assert.match(searchError('429 {"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}', 429, false, false).message, /^Anthropic web search API error 429: Slow down$/u);
  assert.match(searchError('400 {"type":"error","error":{"message":"Web search is not enabled for this organization"}}', 400, false, false).message, /error 400: web search unavailable/u);
  assert.match(searchError("fetch failed", undefined, false, false).message, /network error/u);
  assert.match(searchError("Connection error.", undefined, false, false).message, /network error/u);
  assert.match(searchError("Provider is not configured: anthropic", undefined, false, false).message, /^Anthropic web search failed: Provider is not configured/u);
  assert.match(searchError("Overloaded", 200, false, false).message, /temporarily unavailable/u);
  assert.equal(searchError("aborted", undefined, true, false).name, "AbortError");
  assert.match(searchError("aborted", undefined, false, true).message, /timed out/u);
});

test("searchWithAnthropic: payload qua transport của Pi, fetch được tách để đọc nguồn", async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(sse(anthropicSearchEvents()), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const registry = {
      streamSimple(model, context, options) {
        return {
          async result() {
            assert.equal(model, claude);
            assert.equal(context.messages[0].content, "Search the web for: pi");
            assert.equal(options.reasoning, undefined);
            assert.equal(options.cacheRetention, "none");
            const payload = options.onPayload({ model: model.id, messages: [], stream: true });
            const response = await options.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(payload) });
            await response.text(); // Pi đọc nhánh còn lại.
            return { stopReason: "stop", content: [{ type: "text", text: "fallback" }] };
          },
        };
      },
    };
    const result = await searchWithAnthropic("pi", { domainFilter: ["pi.example"] }, { model: claude, modelRegistry: registry });
    assert.deepEqual(calls[0].body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5, allowed_domains: ["pi.example"] }]);
    assert.equal(result.answer, "Pi is a minimal coding agent with extensions.");
    assert.equal(result.results[0].url, "https://code.example/pi");
    const failing = { streamSimple: (_model, _context, options) => ({ async result() {
      await options.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
      return { stopReason: "error", errorMessage: '429 {"type":"error","error":{"message":"Rate limited"}}' };
    } }) };
    globalThis.fetch = async () => new Response("{}", { status: 429 });
    await assert.rejects(searchWithAnthropic("pi", {}, { model: claude, modelRegistry: failing }), /API error 429: Rate limited/u);
    await assert.rejects(searchWithAnthropic("pi", {}, { model: { ...claude, provider: "openai" }, modelRegistry: failing }), /not an official Claude model/u);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
