import * as text from "./messages.ts";

/**
 * Hộp hỏi của manual và acceptEdits (như mode default của Claude Code): lời gọi mà auto mode gửi bộ phân loại thì hỏi
 * người dùng, không gọi model nào. Luật deny, git guard, luật ask và lối đi nhanh vẫn do lớp chính sách quyết định.
 * Lựa chọn như Claude Code: Yes; Yes, and don't ask again (luật theo tiền tố lệnh hoặc domain lưu cho project; sửa file
 * thì chuyển sang acceptEdits tới hết phiên; tool khác thì nhớ đúng lời gọi tới hết phiên); Yes, and switch to auto
 * mode; No; No, and tell Pi what to do differently.
 */

export type ManualAnswer = "once" | "always" | "auto" | "deny" | "comment";

export interface ManualOption {
  answer: ManualAnswer;
  label: string;
}

export const YES = "Yes";
export const NO = "No";
export const SWITCH_TO_AUTO = "Yes, and switch to auto mode";
export const TELL_PI = "No, and tell Pi what to do differently…";

/**
 * Lựa chọn của hộp hỏi. always: nhãn của "don't ask again" (không có thì bỏ lựa chọn này, vd lệnh rủi ro); auto: có
 * lựa chọn chuyển sang auto mode; comment: có thể nhập lời nhắn khi từ chối.
 */
export function manualOptions(options: { always?: string; auto: boolean; comment: boolean }): ManualOption[] {
  return [
    { answer: "once", label: YES },
    ...(options.always ? [{ answer: "always" as const, label: options.always }] : []),
    ...(options.auto ? [{ answer: "auto" as const, label: SWITCH_TO_AUTO }] : []),
    { answer: "deny", label: NO },
    ...(options.comment ? [{ answer: "comment" as const, label: TELL_PI }] : []),
  ];
}

/** Lựa chọn trong hộp thoại → câu trả lời; đóng hộp thoại (undefined) hoặc lựa chọn lạ là No. */
export function answerOf(options: ManualOption[], choice: string | undefined): ManualAnswer {
  return options.find((option) => option.label === choice)?.answer ?? "deny";
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
  options: ManualOption[];
  /** Hỏi người dùng; undefined khi không ai trả lời được (không có UI). */
  ask?: (title: string, options: ManualOption[]) => Promise<ManualAnswer>;
  /** "don't ask again": lưu luật, chuyển sang acceptEdits hoặc nhớ lời gọi (mặc định). */
  always?: () => void | Promise<void>;
  /** Chuyển sang auto mode. */
  switchToAuto?: () => void | Promise<void>;
  /** Lời nhắn khi từ chối; undefined/rỗng thì từ chối không lời nhắn. */
  comment?: () => Promise<string | undefined>;
}

export type ManualResult =
  | { kind: "allow"; via: "session approval" | "user" | "user (always)" | "user (switched to auto)" }
  | { kind: "block"; reason: string; declined: boolean; comment?: string };

export async function manualApproval(request: ManualRequest): Promise<ManualResult> {
  if (request.approvals.has(request.key)) return { kind: "allow", via: "session approval" };
  if (!request.ask) return { kind: "block", reason: text.MANUAL_NO_APPROVER, declined: false };
  const answer = await request.ask(request.title, request.options);
  if (answer === "once") return { kind: "allow", via: "user" };
  if (answer === "always") {
    if (request.always) await request.always();
    else request.approvals.add(request.key);
    return { kind: "allow", via: "user (always)" };
  }
  if (answer === "auto") {
    await request.switchToAuto?.();
    return { kind: "allow", via: "user (switched to auto)" };
  }
  if (answer === "comment") {
    const comment = (await request.comment?.())?.trim();
    if (comment) return { kind: "block", reason: text.manualDeclinedWith(comment), declined: true, comment };
  }
  return { kind: "block", reason: text.MANUAL_DECLINED, declined: true };
}
