/**
 * Native web search của Claude: một request phụ tới Anthropic Messages API với server tool
 * web_search (web_search_20250305) theo cách WebSearch của Claude Code; prompt viết riêng.
 * Request đi qua transport Anthropic của Pi (ctx.modelRegistry.streamSimple) nên giữ auth,
 * refresh OAuth và shaping/billing header của pi-anthropic-auth. Pi bỏ qua block server tool
 * khi parse, nên body SSE được tách (tee) để đọc truy vấn, nguồn và citation.
 */

export const NATIVE_SEARCH_KEY = Symbol.for("pi-config.native-web-search");
export const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
export const MAX_SEARCHES = 5;
const MAX_RESULTS = 20;
const MAX_DOMAINS = 64;
const MAX_TOKENS = 16_384;
const SEARCH_TIMEOUT_MS = 120_000;

export interface SearchOptions {
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  provider: "anthropic";
  answer: string;
  results: SearchResult[];
}

export interface ModelLike {
  provider?: string;
  api?: string;
  id?: string;
  baseUrl?: string;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

interface AssistantMessageLike {
  stopReason?: string;
  rawStopReason?: string;
  errorMessage?: string;
  content?: Array<{ type?: string; text?: string }>;
}

export interface SearchContext {
  model?: ModelLike;
  modelRegistry: {
    streamSimple(model: ModelLike, context: unknown, options?: Record<string, unknown>): { result(): Promise<AssistantMessageLike> };
  };
}

/** Chỉ model Claude của provider anthropic trên endpoint chính thức (OAuth được pi-anthropic-auth shape). */
export function supportsNativeSearch(model: ModelLike | undefined): boolean {
  if (!model || model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
  if (!/^claude-/iu.test(model.id ?? "")) return false;
  try {
    const url = new URL(model.baseUrl ?? "");
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** Giống normalizeDomain của pi-web-access: chỉ giữ hostname hợp lệ. */
function normalizeDomain(value: string): string | undefined {
  let input = value.trim().toLowerCase();
  if (input.startsWith("-")) input = input.slice(1).trim();
  if (!input) return undefined;
  try {
    input = (input.includes("://") ? new URL(input) : new URL(`https://${input}`)).hostname;
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? "";
  }
  input = input.replace(/^\.+|\.+$/gu, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/iu.test(input) ? input : undefined;
}

export function buildWebSearchTool(options: SearchOptions = {}): Record<string, unknown> {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const raw of options.domainFilter ?? []) {
    if (typeof raw !== "string") continue;
    const domain = normalizeDomain(raw);
    const target = raw.trim().startsWith("-") ? blocked : allowed;
    if (domain && !target.includes(domain)) target.push(domain);
  }
  const tool: Record<string, unknown> = { type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: MAX_SEARCHES };
  // Anthropic từ chối request có cả hai danh sách; allowed đã giới hạn phạm vi nên được ưu tiên.
  if (allowed.length > 0) tool.allowed_domains = allowed.slice(0, MAX_DOMAINS);
  else if (blocked.length > 0) tool.blocked_domains = blocked.slice(0, MAX_DOMAINS);
  return tool;
}

const RECENCY_LABELS = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" } as const;

export function buildPrompt(query: string, options: SearchOptions = {}): { systemPrompt: string; prompt: string } {
  const lines = [
    "Use the web_search tool to research the user's query.",
    "Answer concisely using only the search results and cite the sources you use.",
  ];
  if (options.recencyFilter && RECENCY_LABELS[options.recencyFilter]) lines.push(`Prefer sources from the ${RECENCY_LABELS[options.recencyFilter]}.`);
  if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
    lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), MAX_RESULTS)} distinct sources.`);
  }
  return { systemPrompt: lines.join("\n"), prompt: `Search the web for: ${query}` };
}

function isWebSearchTool(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { name?: unknown }).name === "web_search";
}

/**
 * Thêm server tool vào payload Pi đã dựng; system, betas, thinking giữ nguyên.
 * Model có effort ở cấp request (Opus 5.x, Fable) tìm kiếm với effort thấp: pi-anthropic-auth bỏ
 * system message chỉ chứa effort, nên đặt trực tiếp output_config.effort thay cho Pi mặc định "high".
 */
export function shapeSearchPayload(payload: unknown, tool: Record<string, unknown>): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const tools = Array.isArray(record.tools) ? record.tools.filter((entry) => !isWebSearchTool(entry)) : [];
  const shaped: Record<string, unknown> = { ...record, tools: [...tools, tool] };
  const output = record.output_config;
  if (output && typeof output === "object" && !Array.isArray(output) && "effort" in output) shaped.output_config = { ...output, effort: "low" };
  return shaped;
}

/** Model không tắt được thinking (off: null) dùng effort thấp; model còn lại tắt thinking như Claude Code. */
export function searchReasoning(model: ModelLike): "low" | undefined {
  return model.thinkingLevelMap?.off === null ? "low" : undefined;
}

type Block =
  | { kind: "text"; text: string; citations: Array<{ url: string; title: string; citedText: string }> }
  | { kind: "search"; input: string }
  | { kind: "results"; results: Array<{ url: string; title: string }>; error?: string }
  | { kind: "other" };

function citationOf(value: unknown): { url: string; title: string; citedText: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url) return undefined;
  return {
    url: record.url,
    title: typeof record.title === "string" ? record.title : "",
    citedText: typeof record.cited_text === "string" ? record.cited_text : "",
  };
}

export interface SearchSummary {
  searched: boolean;
  answer: string;
  results: SearchResult[];
  queries: string[];
  errors: string[];
}

/** Gom sự kiện SSE của Anthropic thành câu trả lời, nguồn và mã lỗi của web search. */
export class SearchStreamCollector {
  private blocks = new Map<number, Block>();
  private order: Block[] = [];

  reset(): void {
    this.blocks.clear();
    this.order = [];
  }

  handle(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const data = event as { type?: string; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown> };
    if (data.type === "content_block_start" && typeof data.index === "number" && data.content_block) {
      const start = data.content_block;
      let block: Block = { kind: "other" };
      if (start.type === "text") {
        const citations = Array.isArray(start.citations) ? start.citations.map(citationOf).filter((item) => item !== undefined) : [];
        block = { kind: "text", text: typeof start.text === "string" ? start.text : "", citations };
      } else if (start.type === "server_tool_use" && start.name === "web_search") {
        block = { kind: "search", input: start.input && typeof start.input === "object" && Object.keys(start.input).length ? JSON.stringify(start.input) : "" };
      } else if (start.type === "web_search_tool_result") {
        const content = start.content;
        if (Array.isArray(content)) {
          const results = content
            .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string")
            .map((item) => ({ url: item.url as string, title: typeof item.title === "string" ? item.title : "" }));
          block = { kind: "results", results };
        } else {
          const code = content && typeof content === "object" ? (content as { error_code?: unknown }).error_code : undefined;
          block = { kind: "results", results: [], error: typeof code === "string" ? code : "unknown" };
        }
      }
      this.blocks.set(data.index, block);
      this.order.push(block);
      return;
    }
    if (data.type === "content_block_delta" && typeof data.index === "number" && data.delta) {
      const block = this.blocks.get(data.index);
      const delta = data.delta;
      if (block?.kind === "text" && delta.type === "text_delta" && typeof delta.text === "string") block.text += delta.text;
      else if (block?.kind === "text" && delta.type === "citations_delta") {
        const citation = citationOf(delta.citation);
        if (citation) block.citations.push(citation);
      } else if (block?.kind === "search" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.input += delta.partial_json;
      }
    }
  }

  /** Đọc một nhánh SSE; lỗi JSON từng sự kiện được bỏ qua, lỗi transport do Pi báo. */
  async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flush = (chunk: string) => {
      const data = chunk.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) return;
      try {
        this.handle(JSON.parse(data));
      } catch {
        // Sự kiện hỏng không làm mất phần kết quả còn lại.
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/u);
        while (boundary >= 0) {
          flush(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/u, "");
          boundary = buffer.search(/\r?\n\r?\n/u);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) flush(buffer);
    } finally {
      reader.releaseLock();
    }
  }

  summary(): SearchSummary {
    const parts = [""];
    const queries: string[] = [];
    const errors: string[] = [];
    const citations: Array<{ url: string; title: string; citedText: string }> = [];
    const found: Array<{ url: string; title: string }> = [];
    let searched = false;
    for (const block of this.order) {
      if (block.kind === "search") {
        searched = true;
        parts.push("");
        try {
          const query = (JSON.parse(block.input || "{}") as { query?: unknown }).query;
          if (typeof query === "string" && query.trim()) queries.push(query.trim());
        } catch {
          // Truy vấn chỉ để hiển thị.
        }
      } else if (block.kind === "results") {
        searched = true;
        if (block.error) errors.push(block.error);
        found.push(...block.results);
      } else if (block.kind === "text") {
        parts[parts.length - 1] += block.text;
        citations.push(...block.citations);
      }
    }
    // Phần mở đầu trước lần tìm đầu tiên ("I'll search...") không thuộc câu trả lời.
    const answer = (searched ? parts.slice(1) : parts).map((part) => part.trim()).filter(Boolean).join("\n\n");
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const add = (url: string, title: string, snippet: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      results.push({ url, title: title.trim() || url, snippet: snippet.trim() });
    };
    for (const citation of citations) add(citation.url, citation.title, citation.citedText);
    for (const result of found) add(result.url, result.title, "");
    return { searched, answer, results, queries, errors };
  }
}

function apiErrorDetail(message: string | undefined): string {
  const raw = (message ?? "").trim();
  const json = raw.indexOf("{");
  if (json >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(json)) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") return parsed.error.message.replace(/\s+/gu, " ").slice(0, 300);
    } catch {
      // Không phải JSON: dùng thông báo gốc.
    }
  }
  return raw.replace(/\s+/gu, " ").slice(0, 300) || "unknown error";
}

/**
 * Thông báo lỗi được viết để bộ phân loại routing của pi-web-access nhận đúng loại
 * (quota, transient, network, unsupported, invalid-response) và chuyển sang Firecrawl khi cấu hình cho phép.
 */
export function searchError(message: string | undefined, status: number | undefined, callerAborted: boolean, timedOut: boolean): Error {
  if (callerAborted) {
    const error = new Error("Request was aborted");
    error.name = "AbortError";
    return error;
  }
  if (timedOut) return new Error(`Anthropic web search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`);
  const detail = apiErrorDetail(message);
  if (status !== undefined && status !== 200) {
    if (status === 400 && /web.?search/iu.test(detail) && /not enabled|disabled|not available|unsupported|not supported/iu.test(detail)) {
      return new Error(`Anthropic web search API error 400: web search unavailable for this account (${detail})`);
    }
    return new Error(`Anthropic web search API error ${status}: ${detail}`);
  }
  if (status === undefined && /connection|fetch failed|network|socket|timed? ?out|econn|enotfound|etimedout/iu.test(detail)) {
    return new Error(`Anthropic web search network error: ${detail}`);
  }
  if (/overloaded|api_error|internal server/iu.test(detail)) return new Error(`Anthropic web search temporarily unavailable: ${detail}`);
  return new Error(`Anthropic web search failed: ${detail}`);
}

export function errorFromCodes(codes: string[]): Error {
  if (codes.includes("too_many_requests")) return new Error("Anthropic web search rate limit (too_many_requests)");
  if (codes.includes("unavailable")) return new Error("Anthropic web search temporarily unavailable (unavailable)");
  return new Error(`Anthropic web search invalid request (${[...new Set(codes)].join(", ")})`);
}

export function toSearchResponse(summary: SearchSummary, message: AssistantMessageLike, options: SearchOptions = {}): SearchResponse {
  if (!summary.searched) throw new Error("Anthropic web search returned no web_search_call");
  const fallbackText = (message.content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("").trim();
  let answer = summary.answer || fallbackText;
  if (!answer && summary.results.length === 0) {
    throw summary.errors.length > 0 ? errorFromCodes(summary.errors) : new Error("Anthropic web search returned no answer or sources");
  }
  if (message.rawStopReason === "pause_turn") answer += "\n\n(Search paused at the server-side iteration limit; results may be incomplete.)";
  const limit = typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0
    ? Math.min(Math.floor(options.numResults), MAX_RESULTS)
    : MAX_RESULTS;
  return { provider: "anthropic", answer: answer.trim(), results: summary.results.slice(0, limit) };
}

/** Tìm web bằng model Claude hiện tại; lỗi được ném để routing của pi-web-access quyết định fallback. */
export async function searchWithAnthropic(query: string, options: SearchOptions = {}, ctx: SearchContext): Promise<SearchResponse> {
  const model = ctx?.model;
  if (!model || !supportsNativeSearch(model)) {
    throw new Error("Anthropic web search unavailable: current model is not an official Claude model");
  }
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const collector = new SearchStreamCollector();
  const reading: Promise<void>[] = [];
  let status: number | undefined;
  const captureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await globalThis.fetch(input, init);
    status = response.status;
    if (!response.ok || !response.body) return response;
    const [forPi, forSearch] = response.body.tee();
    collector.reset();
    reading.push(collector.consume(forSearch).catch(() => {}));
    return new Response(forPi, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const { systemPrompt, prompt } = buildPrompt(query, options);
  const tool = buildWebSearchTool(options);
  const message = await ctx.modelRegistry.streamSimple(model, {
    systemPrompt,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, {
    maxTokens: MAX_TOKENS,
    reasoning: searchReasoning(model),
    signal,
    cacheRetention: "none",
    fetch: captureFetch,
    onPayload: (payload: unknown) => shapeSearchPayload(payload, tool),
  }).result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw searchError(message.errorMessage, status, options.signal?.aborted === true, timeout.aborted);
  }
  await Promise.all(reading);
  return toSearchResponse(collector.summary(), message, options);
}
