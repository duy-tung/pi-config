import * as text from "./messages.ts";

/**
 * Manual mode (như mode default của Claude Code): lời gọi mà auto mode gửi bộ phân loại thì hỏi người dùng, không
 * gọi model nào. Luật deny, git guard, luật ask và lối đi nhanh vẫn do lớp chính sách quyết định như ở auto.
 * Khóa duyệt là callKey (tên tool + input đã chuẩn hóa): "Allow for this session" chỉ áp dụng cho đúng lời gọi đó.
 */

export type ManualAnswer = "once" | "session" | "deny";

export const MANUAL_CHOICES: Record<ManualAnswer, string> = {
  once: "Allow once",
  session: "Allow for this session",
  deny: "Deny",
};

/** Lựa chọn trong hộp thoại → câu trả lời; đóng hộp thoại (undefined) hoặc lựa chọn lạ là Deny. */
export function answerOf(choice: string | undefined): ManualAnswer {
  const found = (Object.keys(MANUAL_CHOICES) as ManualAnswer[]).find((answer) => MANUAL_CHOICES[answer] === choice);
  return found ?? "deny";
}

/** Câu hỏi hiện cho người dùng: lời gọi, kèm ghi chú rủi ro của lớp chính sách (nếu có). */
export function manualTitle(toolName: string, summary: string, notes: string[] = []): string {
  const unique = [...new Set(notes)];
  return `Allow ${toolName}: ${summary}?${unique.length ? `\n\nNote: ${unique.join("; ")}.` : ""}`;
}

export interface ManualRequest {
  key: string;
  title: string;
  /** Lời gọi đã được cho phép tới hết phiên. */
  approvals: Set<string>;
  /** Hỏi người dùng; undefined khi không ai trả lời được (không có UI). */
  ask?: (title: string) => Promise<ManualAnswer>;
}

export type ManualResult =
  | { kind: "allow"; via: "session approval" | "user" | "user (session)" }
  | { kind: "block"; reason: string; declined: boolean };

export async function manualApproval(request: ManualRequest): Promise<ManualResult> {
  if (request.approvals.has(request.key)) return { kind: "allow", via: "session approval" };
  if (!request.ask) return { kind: "block", reason: text.MANUAL_NO_APPROVER, declined: false };
  const answer = await request.ask(request.title);
  if (answer === "session") {
    request.approvals.add(request.key);
    return { kind: "allow", via: "user (session)" };
  }
  if (answer === "once") return { kind: "allow", via: "user" };
  return { kind: "block", reason: text.MANUAL_DECLINED, declined: true };
}
