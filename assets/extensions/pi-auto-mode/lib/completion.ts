import type { CompletionOptions, CompletionRequest } from "./classifier.ts";

/**
 * Request LLM của bộ phân loại theo dạng streamSimple/completeSimple của pi-ai. Dùng chung cho extension, pi-agent và
 * scripts/eval-auto-mode.mjs để cả ba gửi cùng một request.
 */

export interface ClassifierModel {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Mức suy luận thấp nhất model nhận: "off" khi tắt được. Model luôn suy luận (Sonnet 5.5: off và minimal là null) mà
 * không gửi mức nào thì pi-ai dùng effort "high", nên giai đoạn 1 gửi mức thấp nhất còn lại.
 */
export function lowestReasoning(model: ClassifierModel): string {
  if (!model.reasoning) return "off";
  const map = model.thinkingLevelMap ?? {};
  return LEVELS.find((level) => map[level] !== null) ?? "off";
}

type Block = Record<string, unknown> & { type?: unknown; text?: unknown; cache_control?: unknown };

/**
 * pi-ai đặt cache_control ở khối cuối của tin nhắn user cuối, tức là câu dặn của từng giai đoạn. Hai giai đoạn chỉ khác
 * nhau ở khối đó, nên dấu được chuyển sang khối ngay trước (transcript): giai đoạn 2 đọc lại phần giai đoạn 1 vừa ghi
 * vào cache. Payload không có dạng đó (provider khác) thì giữ nguyên (undefined).
 */
export function cacheBeforeSuffix(payload: unknown, suffix: string): unknown {
  const messages = (payload as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role !== "user") continue;
    const blocks = Array.isArray(message.content) ? (message.content as Block[]) : [];
    const last = blocks.at(-1);
    if (blocks.length < 2 || last?.type !== "text" || last.text !== suffix || !last.cache_control) return undefined;
    const { cache_control, ...plain } = last;
    const content = [...blocks.slice(0, -2), { ...blocks[blocks.length - 2], cache_control }, plain];
    const copy = [...messages];
    copy[index] = { ...message, content };
    return { ...(payload as object), messages: copy };
  }
  return undefined;
}

/** Context và options cho một request: một tin nhắn user gồm các khối (chỉ dẫn, transcript) rồi câu dặn của giai đoạn. */
export function completionRequest(model: ClassifierModel, request: CompletionRequest, options: CompletionOptions, cacheKey: string) {
  const reasoning = !options.reasoning || options.reasoning === "off" ? lowestReasoning(model) : options.reasoning;
  return {
    context: {
      systemPrompt: request.systemPrompt,
      messages: [{
        role: "user" as const,
        content: [...request.blocks, request.suffix].map((text) => ({ type: "text" as const, text })),
        timestamp: Date.now(),
      }],
    },
    options: {
      maxTokens: options.maxTokens, signal: options.signal, sessionId: cacheKey, cacheRetention: "short" as const,
      ...(reasoning !== "off" ? { reasoning } : {}),
      onPayload: (payload: unknown) => cacheBeforeSuffix(payload, request.suffix),
    },
  };
}

/** Văn bản trả lời; request lỗi hoặc bị huỷ thì ném lỗi (bộ phân loại chặn). */
export function completionText(message: { stopReason?: string; errorMessage?: string; content: { type: string }[] }): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `classifier request ${message.stopReason}`);
  }
  return message.content.filter((part) => part.type === "text").map((part) => (part as { type: string; text: string }).text).join("");
}
