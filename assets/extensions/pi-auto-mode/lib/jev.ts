import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Client tối giản cho System One API của TypeSafe (model Jev): POST state + câu hỏi có kiểu, nhận xác suất.
 * Không dùng SDK để extension không phụ thuộc module ngoài runtime Pi; mọi câu trả lời được kiểm kiểu
 * trước khi dùng (sai khoá, sai kiểu, xác suất ngoài [0, 1] đều là lỗi) và mọi lỗi đều do bên gọi xử lý.
 */

export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-1.13.0";
/** Giá jev-1.13.0 theo docs.typesafe.ai/models: USD cho 1 triệu token đầu vào; đầu ra miễn phí. */
export const JEV_PRICE_PER_MTOK = 0.042;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface NoulQuestion { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
export interface ChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export interface ScoreQuestion { type: "score"; instructions: string; criteria: string[] }
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  /** probabilities theo mức 0..n-1. */
  | { type: "score"; score: number; confidence: number; probabilities: number[] };

export interface JevResult {
  model: string;
  answers: Record<string, Answer>;
  inputTokens: number;
  ms: number;
}

export interface JevEndpoint { href: string; origin: string; path: string }

export type JevAccess =
  | { status: "ready"; endpoint: JevEndpoint; apiKey: string; source: "environment" | "keyring" }
  | { status: "missing"; endpoint: JevEndpoint }
  | { status: "unavailable"; message: string };

/**
 * Kho key của pi-mcp-adapter (`pi-mcp-adapter key set systemone`): biến môi trường rồi keyring của hệ điều hành,
 * mỗi endpoint một key. Dùng chung để một key phục vụ cả MCP semantic search và auto mode.
 */
export interface KeyStore {
  resolveJevCredential(env: NodeJS.ProcessEnv, endpoint: JevEndpoint):
    | { status: "present"; source: "environment" | "keyring"; apiKey: string }
    | { status: "missing" }
    | { status: "unavailable"; message: string };
}

export type JevErrorKind =
  | "auth" | "payment" | "endpoint" | "invalid_request" | "invalid_response"
  | "rate_limit" | "overloaded" | "server" | "timeout" | "network" | "aborted";

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;
  constructor(kind: JevErrorKind, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    this.status = status;
  }

  /** Lỗi tạm thời: thử lại được, không tắt Jev cho cả phiên. */
  get transient(): boolean {
    return ["rate_limit", "overloaded", "server", "timeout", "network"].includes(this.kind);
  }
}

/** Như pi-mcp-adapter: chỉ HTTPS, không credential, query hay fragment trong URL, phải có path. */
export function parseEndpoint(raw: string): JevEndpoint {
  if (!raw.trim() || raw.length > 512 || /[\u0000-\u0020\u007f]/u.test(raw)) throw new Error("SYSTEMONE_ENDPOINT must be a URL without spaces");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SYSTEMONE_ENDPOINT must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new Error("SYSTEMONE_ENDPOINT must use https");
  if (url.username || url.password || url.search || url.hash) throw new Error("SYSTEMONE_ENDPOINT must not contain credentials, a query or a fragment");
  if (url.pathname === "" || url.pathname === "/") throw new Error("SYSTEMONE_ENDPOINT must include a path such as /v1/systemone");
  return { href: `${url.origin}${url.pathname}`, origin: url.origin, path: url.pathname };
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Đọc kho key của pi-mcp-adapter trong node_modules của runtime; không có thì chỉ dùng biến môi trường. */
export async function loadKeyStore(nodeModules: string | undefined): Promise<KeyStore | undefined> {
  if (!nodeModules) return undefined;
  const file = path.join(nodeModules, "pi-mcp-adapter", "dist", "jev-key-store.js");
  if (!fs.existsSync(file)) return undefined;
  try {
    const module = await import(pathToFileURL(file).href) as Partial<KeyStore>;
    return typeof module.resolveJevCredential === "function" ? { resolveJevCredential: module.resolveJevCredential } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Endpoint: SYSTEMONE_ENDPOINT hoặc TypeSafe. Key: SYSTEMONE_API_KEY (mọi endpoint), TYPESAFE_API_KEY
 * (chỉ endpoint TypeSafe, không bao giờ gửi đi nơi khác), rồi keyring qua pi-mcp-adapter.
 * SYSTEMONE_ENDPOINT sai thì không dùng Jev (không lặng lẽ gửi dữ liệu về endpoint mặc định).
 */
export function resolveAccess(env: NodeJS.ProcessEnv, store?: KeyStore): JevAccess {
  let endpoint: JevEndpoint;
  try {
    endpoint = parseEndpoint(Object.hasOwn(env, "SYSTEMONE_ENDPOINT") ? String(env.SYSTEMONE_ENDPOINT) : JEV_DEFAULT_ENDPOINT);
  } catch (error) {
    return { status: "unavailable", message: error instanceof Error ? error.message : "SYSTEMONE_ENDPOINT is invalid" };
  }
  if (Object.hasOwn(env, "SYSTEMONE_API_KEY")) {
    return validKey(env.SYSTEMONE_API_KEY)
      ? { status: "ready", endpoint, apiKey: env.SYSTEMONE_API_KEY, source: "environment" }
      : { status: "unavailable", message: "SYSTEMONE_API_KEY is set but invalid" };
  }
  if (Object.hasOwn(env, "TYPESAFE_API_KEY") && endpoint.href === JEV_DEFAULT_ENDPOINT) {
    return validKey(env.TYPESAFE_API_KEY)
      ? { status: "ready", endpoint, apiKey: env.TYPESAFE_API_KEY, source: "environment" }
      : { status: "unavailable", message: "TYPESAFE_API_KEY is set but invalid" };
  }
  if (!store) return { status: "missing", endpoint };
  let stored: ReturnType<KeyStore["resolveJevCredential"]>;
  try {
    stored = store.resolveJevCredential({}, endpoint);
  } catch (error) {
    return { status: "unavailable", message: error instanceof Error ? error.message : "the OS credential store failed" };
  }
  if (stored.status === "present" && validKey(stored.apiKey)) return { status: "ready", endpoint, apiKey: stored.apiKey, source: "keyring" };
  if (stored.status === "unavailable") return { status: "unavailable", message: stored.message };
  return { status: "missing", endpoint };
}

// ---------------------------------------------------------------------------
// Che secret trước khi gửi cho bên thứ ba
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{20,}/gu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\bfc-[a-f0-9]{24,}\b/gu,
  /\bnpm_[A-Za-z0-9]{30,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gu,
  /(:\/\/[^\s:/@]+:)[^\s@/]{4,}@/gu,
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"'&]{8,}/giu,
];

/** Thay giá trị giống secret bằng [REDACTED]; giữ phần tên (vd `API_KEY=`) để câu hỏi vẫn thấy có secret. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix?: unknown) => (typeof prefix === "string" && match.startsWith(prefix)
      ? `${prefix}${/^(Bearer|Basic)$/u.test(prefix) ? " " : ""}[REDACTED]${prefix.startsWith("://") ? "@" : ""}`
      : "[REDACTED]"));
  }
  return result;
}

/** Che secret trong mọi chuỗi của một giá trị JSON. */
export function redactJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]));
  return value;
}

// ---------------------------------------------------------------------------
// Gọi API và kiểm câu trả lời
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevError("invalid_response", `Jev returned an invalid ${label}`);
  }
  return value;
}

/** Kiểm câu trả lời theo đúng bộ câu hỏi đã gửi: đủ khoá, đúng kiểu, xác suất hợp lệ. Trường thừa được bỏ qua. */
export function parseAnswers(body: unknown, questions: Record<string, Question>): { model: string; answers: Record<string, Answer>; inputTokens: number } {
  const response = record(body);
  const answers = record(response?.answers);
  if (!response || !answers) throw new JevError("invalid_response", "Jev returned no answers");
  const names = Object.keys(questions);
  if (Object.keys(answers).length !== names.length || names.some((name) => !Object.hasOwn(answers, name))) {
    throw new JevError("invalid_response", "Jev answers do not match the questions");
  }
  const parsed: Record<string, Answer> = {};
  for (const name of names) {
    const question = questions[name];
    const answer = record(answers[name]);
    if (!answer || answer.type !== question.type) throw new JevError("invalid_response", `Jev answer ${name} has the wrong type`);
    if (question.type === "noul") {
      parsed[name] = { type: "noul", noul: probability(answer.noul, `${name} probability`) };
    } else if (question.type === "choice") {
      const labels = Object.keys(question.criteria);
      const probabilities = record(answer.probabilities);
      if (typeof answer.choice !== "string" || !labels.includes(answer.choice) || !probabilities) {
        throw new JevError("invalid_response", `Jev answer ${name} has an invalid choice`);
      }
      parsed[name] = {
        type: "choice", choice: answer.choice, confidence: probability(answer.confidence, `${name} confidence`),
        probabilities: Object.fromEntries(labels.map((label) => [label, probability(probabilities[label], `${name} probability`)])),
      };
    } else {
      const probabilities = record(answer.probabilities);
      const levels = question.criteria.length;
      if (!probabilities || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1) {
        throw new JevError("invalid_response", `Jev answer ${name} has an invalid score`);
      }
      parsed[name] = {
        type: "score", score: answer.score, confidence: probability(answer.confidence, `${name} confidence`),
        probabilities: Array.from({ length: levels }, (_, level) => probability(probabilities[String(level)], `${name} probability`)),
      };
    }
  }
  const usage = record(response.usage);
  const inputTokens = typeof usage?.input_tokens === "number" && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  return { model: typeof response.model === "string" ? response.model.slice(0, 128) : "", answers: parsed, inputTokens };
}

function statusError(status: number, retryAfter: string | null): JevError {
  if (status === 401 || status === 403) return new JevError("auth", `Jev rejected the API key (HTTP ${status})`, status);
  if (status === 402) return new JevError("payment", "Jev requires payment for this account (HTTP 402)", status);
  if (status === 404 || status === 405 || status === 410) return new JevError("endpoint", `Jev endpoint was not found (HTTP ${status}); check SYSTEMONE_ENDPOINT`, status);
  if (status === 408) return new JevError("timeout", "Jev timed out (HTTP 408)", status);
  if (status === 429) return new JevError("rate_limit", `Jev rate limit exceeded${retryAfter ? ` (retry after ${retryAfter})` : ""}`, status);
  if (status === 529) return new JevError("overloaded", "Jev is overloaded (HTTP 529)", status);
  if (status >= 500) return new JevError("server", `Jev service error (HTTP ${status})`, status);
  // Không chép body lỗi của provider vào thông báo.
  return new JevError("invalid_request", `Jev rejected the request (HTTP ${status})`, status);
}

export interface EvaluateOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  /** Cho kiểm thử; mặc định globalThis.fetch lúc gọi. */
  fetch?: typeof fetch;
  /** Số lần thử lại khi lỗi tạm thời (mặc định 1). */
  retries?: number;
}

/** Một request System One. Thử lại một lần khi lỗi tạm thời; không theo redirect (key không bị chuyển đi nơi khác). */
export async function evaluate(
  access: Extract<JevAccess, { status: "ready" }>,
  request: { model: string; state: JsonValue; questions: Record<string, Question> },
  options: EvaluateOptions,
): Promise<JevResult> {
  const body = JSON.stringify({ model: request.model, state: request.state, questions: request.questions });
  const started = Date.now();
  const retries = options.retries ?? 1;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new JevError("aborted", "the turn was interrupted");
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let failure: JevError;
    try {
      const response = await (options.fetch ?? globalThis.fetch)(access.endpoint.href, {
        method: "POST", body, signal, redirect: "error",
        headers: { authorization: `Bearer ${access.apiKey}`, "content-type": "application/json", accept: "application/json", "user-agent": "pi-auto-mode" },
      });
      if (response.ok) {
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          throw new JevError("invalid_response", "Jev returned invalid JSON");
        }
        return { ...parseAnswers(parsed, request.questions), ms: Date.now() - started };
      }
      failure = statusError(response.status, response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      if (!failure.transient || attempt >= retries) throw failure;
      const after = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1_000, 2_000) : 400, options.signal);
      continue;
    } catch (error) {
      if (error instanceof JevError) throw error;
      if (options.signal?.aborted) throw new JevError("aborted", "the turn was interrupted");
      failure = timeout.aborted
        ? new JevError("timeout", `Jev did not answer within ${Math.round(options.timeoutMs / 1000)}s`)
        : new JevError("network", "Jev could not be reached");
      if (attempt >= retries) throw failure;
    }
    await sleep(400, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new JevError("aborted", "the turn was interrupted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JevError("aborted", "the turn was interrupted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
