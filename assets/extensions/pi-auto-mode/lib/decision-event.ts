import type { ClassifierResult, ScreenOutcome } from "./classifier.ts";

/**
 * Sự kiện quyết định trên pi.events cho extension khác quan sát (agent-tree đếm lớp Jev). Chỉ để quan sát: phát
 * sau khi đã quyết, không đổi quyết định, lỗi của người nghe bị bỏ qua.
 *
 * stage:
 * - policy: đường tất định (tool an toàn, chỉ đọc, luật allow/deny, git guard, bypass); via là nhánh hoặc luật;
 * - user: người dùng trả lời (luật ask, duyệt một lần từ /permissions, chạm giới hạn chặn);
 * - sharp: Jev sàng lọc và cho qua, chạy thẳng không gọi LLM;
 * - split: bị gắn cờ ở lớp Jev (Jev gắn cờ, hoặc chính sách/nghi prompt injection đẩy thẳng lên) → LLM giai đoạn 2 xét;
 *   flaggedBy cho biết ai gắn cờ;
 * - classifier: bộ phân loại LLM xét khi không có Jev (hoặc Jev lỗi tạm thời).
 * allowed: quyết định của bước đó. Chạm giới hạn chặn mà người dùng cho phép thì có thêm một sự kiện user.
 */
export const DECISION_EVENT = "pi-config:auto-mode-decision";

export type DecisionStage = "policy" | "user" | "sharp" | "split" | "classifier";

export interface DecisionEvent {
  tool: string;
  stage: DecisionStage;
  allowed: boolean;
  /** Nhánh chính sách, luật chặn, "approval", "unavailable"... */
  via?: string;
  /** Giai đoạn của bộ phân loại LLM đưa ra phán quyết. */
  classifierStage?: 1 | 2;
  /** split: Jev gắn cờ thật, hay chính sách/nghi injection gắn cờ trước khi hỏi Jev. */
  flaggedBy?: "jev" | "policy";
  /** Đuôi rủi ro của Jev (0..1) khi Jev đã trả lời. */
  score?: number;
  /** Quyết định trong phiên subagent. */
  child?: boolean;
}

/** Kết quả lớp Jev của một lời gọi, bên gọi ghi lại trong lúc phân loại. */
export interface ScreenTrace {
  outcome?: ScreenOutcome["kind"];
  /** Jev đã trả lời (không phải cờ đặt sẵn). */
  jev?: boolean;
  score?: number;
}

/** Sự kiện cho kết quả của bộ phân loại (có hoặc không có lớp Jev phía trước). */
export function classifierDecision(tool: string, result: ClassifierResult, trace: ScreenTrace): DecisionEvent {
  const allowed = result.kind === "allow";
  const detail: Pick<DecisionEvent, "classifierStage" | "via"> = result.kind === "unavailable"
    ? { via: "unavailable" }
    : { classifierStage: result.stage, ...(result.kind === "block" && result.rule ? { via: result.rule } : {}) };
  const score = typeof trace.score === "number" && Number.isFinite(trace.score) ? { score: Number(trace.score.toFixed(3)) } : {};
  if (result.kind === "allow" && result.screen === "jev") return { tool, stage: "sharp", allowed: true, ...score };
  if (trace.outcome === "flag") return { tool, stage: "split", allowed, flaggedBy: trace.jev ? "jev" : "policy", ...detail, ...score };
  return { tool, stage: "classifier", allowed, ...detail };
}
