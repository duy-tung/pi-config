// Fixture SSE cho native web search; không có credential thật hay dữ liệu mạng.
export const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

export function anthropicSearchEvents({ model = "claude-sonnet-5", stopReason = "end_turn" } = {}) {
  const start = (index, block) => ({ type: "content_block_start", index, content_block: block });
  const delta = (index, value) => ({ type: "content_block_delta", index, delta: value });
  const stop = (index) => ({ type: "content_block_stop", index });
  return [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    start(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "I'll search for that." }), stop(0),
    start(1, { type: "server_tool_use", id: "srvtoolu_fixture", name: "web_search", input: {} }),
    delta(1, { type: "input_json_delta", partial_json: "{\"query\":\"pi coding" }),
    delta(1, { type: "input_json_delta", partial_json: " agent\"}" }), stop(1),
    start(2, { type: "web_search_tool_result", tool_use_id: "srvtoolu_fixture", content: [
      { type: "web_search_result", url: "https://pi.example/docs", title: "Pi docs", encrypted_content: "fixture-a", page_age: "1 day" },
      { type: "web_search_result", url: "https://code.example/pi", title: "Pi source", encrypted_content: "fixture-b" },
    ] }), stop(2),
    start(3, { type: "text", text: "", citations: [] }),
    delta(3, { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://code.example/pi", title: "Pi source", cited_text: "Pi is a minimal coding agent.", encrypted_index: "fixture-c" } }),
    delta(3, { type: "text_delta", text: "Pi is a minimal coding agent" }), stop(3),
    start(4, { type: "text", text: "" }), delta(4, { type: "text_delta", text: " with extensions." }), stop(4),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 24, server_tool_use: { web_search_requests: 1 } } },
    { type: "message_stop" },
  ];
}

/** Luồng SSE của web_fetch gọi thẳng: result là trang văn bản, PDF (base64) hoặc lỗi trong block (HTTP 200). */
export function anthropicFetchEvents({ model = "claude-sonnet-5", url = "https://docs.example/guide", result = "text" } = {}) {
  const start = (index, block) => ({ type: "content_block_start", index, content_block: block });
  const delta = (index, value) => ({ type: "content_block_delta", index, delta: value });
  const stop = (index) => ({ type: "content_block_stop", index });
  const content = result === "text"
    ? { type: "web_fetch_result", url, retrieved_at: "2026-11-17T00:00:00Z", content: { type: "document", title: "Pi guide (native)", source: { type: "text", media_type: "text/plain", data: "Pi guide fetched by Anthropic.\nPi reads files and runs commands." } } }
    : result === "pdf"
      ? { type: "web_fetch_result", url, retrieved_at: "2026-11-17T00:00:00Z", content: { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } } }
      : { type: "web_fetch_tool_result_error", error_code: result };
  return [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    start(0, { type: "server_tool_use", id: "srvtoolu_fetch", name: "web_fetch", input: {} }),
    delta(0, { type: "input_json_delta", partial_json: JSON.stringify({ url }) }), stop(0),
    start(1, { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_fetch", content }), stop(1),
    start(2, { type: "text", text: "" }), delta(2, { type: "text_delta", text: "done" }), stop(2),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3, server_tool_use: { web_fetch_requests: 1 } } },
    { type: "message_stop" },
  ];
}

export const unifiedHeaders = (now = Date.now()) => ({
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.23",
  "anthropic-ratelimit-unified-5h-reset": String(Math.floor(now / 1000) + 2 * 3600 + 10 * 60),
  "anthropic-ratelimit-unified-7d-utilization": "0.41",
  "anthropic-ratelimit-unified-7d-reset": String(Math.floor(now / 1000) + 4 * 86400 + 3 * 3600),
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
});
