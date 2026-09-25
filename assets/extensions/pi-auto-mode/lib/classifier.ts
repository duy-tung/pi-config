import { parseVerdict, STAGE1_SUFFIX, STAGE2_SUFFIX } from "./prompt.ts";

/**
 * Bộ phân loại hai giai đoạn (theo Claude Code auto mode):
 * - Giai đoạn 1: sàng lọc nhanh, nghiêng về gắn cờ. Mặc định là Jev (System One: xác suất cho từng loại rủi ro,
 *   code so ngưỡng); không có Jev thì là LLM với cùng prompt, không suy luận, vài token.
 * - Giai đoạn 2: chỉ khi giai đoạn 1 gắn cờ; LLM có suy luận, xét ngoại lệ và ủy quyền của người dùng.
 * Mọi lỗi đều chặn (fail closed); lỗi không phải phán quyết nên không tính vào giới hạn.
 */

export interface CompletionRequest {
  systemPrompt: string;
  /** Các khối nội dung user (hướng dẫn của người dùng, transcript); giống nhau ở hai giai đoạn. */
  blocks: string[];
  suffix: string;
}

export interface CompletionOptions {
  stage: 1 | 2;
  reasoning?: string;
  maxTokens: number;
  signal: AbortSignal;
}

export type Complete = (request: CompletionRequest, options: CompletionOptions) => Promise<string>;

/** Kết quả giai đoạn 1 bằng Jev. unavailable → giai đoạn 1 chạy bằng LLM như khi không có Jev. */
export type ScreenOutcome =
  | { kind: "clear" }
  | { kind: "flag" }
  | { kind: "unavailable"; reason: string; aborted?: boolean };

export type ClassifierResult =
  | { kind: "allow"; stage: 1 | 2; screen?: "jev" }
  /** fallback: chặn vì giai đoạn 2 không hoàn tất (không phải phán quyết đầy đủ, không tính giới hạn). */
  | { kind: "block"; stage: 1 | 2; rule?: string; reason: string; fallback?: boolean }
  | { kind: "unavailable"; reason: string; aborted?: boolean };

export interface ClassifyOptions {
  systemPrompt: string;
  blocks: string[];
  complete: Complete;
  timeoutMs: number;
  stage2Reasoning?: string;
  signal?: AbortSignal;
  /** Giai đoạn 1 bằng Jev. Được gọi lại khi đổi sang model dự phòng, nên bên gọi tự nhớ kết quả. */
  screen?: () => Promise<ScreenOutcome>;
}

const TRANSIENT = /\b(?:429|5\d\d|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|overloaded|rate limit|temporarily unavailable|fetch failed)\b/iu;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attempt(
  options: ClassifyOptions, stage: 1 | 2, suffix: string, maxTokens: number, reasoning: string | undefined,
): Promise<{ text?: string; error?: string; aborted?: boolean }> {
  const signals = [AbortSignal.timeout(options.timeoutMs)];
  if (options.signal) signals.push(options.signal);
  for (let round = 0; round < 2; round++) {
    const signal = AbortSignal.any(signals);
    try {
      const text = await options.complete(
        { systemPrompt: options.systemPrompt, blocks: options.blocks, suffix },
        { stage, reasoning, maxTokens, signal },
      );
      return { text };
    } catch (error) {
      if (options.signal?.aborted) return { error: "the turn was interrupted", aborted: true };
      const text = message(error);
      if (signal.aborted) return { error: `the classifier did not answer within ${Math.round(options.timeoutMs / 1000)}s` };
      if (round === 0 && TRANSIENT.test(text)) continue;
      return { error: text };
    }
  }
  return { error: "the classifier request failed" };
}

/** Lỗi cho thấy model phân loại không dùng được lúc này (hết quota, rate limit, không có model). */
const MODEL_UNAVAILABLE = /usage limit|quota|rate limit|\b429\b|overloaded|capacity|not found|does not exist|unsupported model|not available|unauthorized|\b401\b|\b403\b/iu;

export function modelUnavailable(result: ClassifierResult): boolean {
  return result.kind === "unavailable" && !result.aborted && MODEL_UNAVAILABLE.test(result.reason);
}

/**
 * Như Claude Code: model phân loại không dùng được thì chuyển sang model dự phòng
 * (model của phiên). Không có dự phòng hoặc dự phòng cũng lỗi thì vẫn chặn.
 */
export async function classifyWithFallback(
  options: ClassifyOptions, fallback: Complete | undefined,
): Promise<{ result: ClassifierResult; fellBack: boolean; primaryReason?: string }> {
  const result = await classify(options);
  if (!fallback || !modelUnavailable(result)) return { result, fellBack: false };
  const primaryReason = result.kind === "unavailable" ? result.reason : undefined;
  return { result: await classify({ ...options, complete: fallback }), fellBack: true, primaryReason };
}

/**
 * Giai đoạn 2 cho hành động giai đoạn 1 đã gắn cờ (hoặc trả lời không đọc được). Không có phán quyết: model không
 * dùng được → unavailable (để chuyển model dự phòng); lỗi khác → chặn theo cờ của giai đoạn 1.
 */
async function review(options: ClassifyOptions, flagged: { rule?: string; reason: string } | undefined): Promise<ClassifierResult> {
  let failure: string | undefined;
  for (let round = 0; round < 2; round++) {
    const second = await attempt(options, 2, STAGE2_SUFFIX, 4096, options.stage2Reasoning);
    if (second.aborted) return { kind: "unavailable", reason: second.error ?? "interrupted", aborted: true };
    const verdict = second.text !== undefined ? parseVerdict(second.text) : undefined;
    if (verdict) {
      return verdict.block
        ? { kind: "block", stage: 2, rule: verdict.rule, reason: verdict.reason ?? "Blocked by the auto mode classifier" }
        : { kind: "allow", stage: 2 };
    }
    if (second.error !== undefined) {
      failure = second.error;
      break;
    }
  }
  if (failure && MODEL_UNAVAILABLE.test(failure)) return { kind: "unavailable", reason: failure };
  if (!flagged) return { kind: "unavailable", reason: "the classifier returned no readable verdict" };
  return { kind: "block", stage: 1, rule: flagged.rule, fallback: true, reason: flagged.reason };
}

export async function classify(options: ClassifyOptions): Promise<ClassifierResult> {
  if (options.screen) {
    const screened = await options.screen();
    if (screened.kind === "clear") return { kind: "allow", stage: 1, screen: "jev" };
    if (screened.kind === "flag") return review(options, { reason: "The System One screen flagged this action and the careful review could not complete" });
    if (screened.aborted) return { kind: "unavailable", reason: screened.reason, aborted: true };
  }
  const first = await attempt(options, 1, STAGE1_SUFFIX, 48, "off");
  if (first.aborted) return { kind: "unavailable", reason: first.error ?? "interrupted", aborted: true };
  const stage1 = first.text !== undefined ? parseVerdict(first.text) : undefined;
  if (stage1 && !stage1.block) return { kind: "allow", stage: 1 };
  if (first.error !== undefined && stage1 === undefined) {
    // Giai đoạn 1 lỗi hẳn: vẫn thử giai đoạn 2 một lần trước khi báo không khả dụng.
    const retry = await attempt(options, 2, STAGE2_SUFFIX, 4096, options.stage2Reasoning);
    if (retry.aborted) return { kind: "unavailable", reason: retry.error ?? "interrupted", aborted: true };
    const verdict = retry.text !== undefined ? parseVerdict(retry.text) : undefined;
    if (!verdict) return { kind: "unavailable", reason: retry.error ?? first.error ?? "the classifier returned no verdict" };
    return verdict.block
      ? { kind: "block", stage: 2, rule: verdict.rule, reason: verdict.reason ?? "Blocked by the auto mode classifier" }
      : { kind: "allow", stage: 2 };
  }
  // Giai đoạn 1 gắn cờ (hoặc trả lời không đọc được): giai đoạn 2; không có phán quyết cẩn thận thì chặn theo cờ.
  return review(options, stage1?.block
    ? { rule: stage1.rule, reason: "The fast screen flagged this action and the careful review could not complete" }
    : undefined);
}
