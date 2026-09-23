/**
 * Bản ghi cho bộ phân loại: JSON Lines, cũ trước mới sau, hành động cần xét ở cuối.
 * Chỉ giữ ý định của người dùng và lệnh của agent; bỏ lời agent và kết quả tool
 * (thiết kế "reasoning-blind" của Claude Code auto mode: agent không thuyết phục được
 * bộ phân loại, nội dung bị chèn trong kết quả tool không tới được nó).
 */

export const ENTRY_TYPE = "pi-auto-mode";

export interface SessionEntryLike {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  summary?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    toolName?: string;
    details?: unknown;
    command?: string;
    excludeFromContext?: boolean;
  };
}

export interface TranscriptOptions {
  /** Hành động cần xét (tên tool + input). */
  action: { toolName: string; input: Record<string, unknown>; toolCallId?: string };
  /** Dòng meta ngay trên hành động. */
  meta?: Record<string, unknown>;
  /** Tool chỉ đọc bị bỏ khỏi lịch sử (không liên quan tới quyết định). */
  skipTools?: Set<string>;
  /** Phiên subagent: tin nhắn user đầu tiên là nhiệm vụ do agent cha viết. */
  child?: boolean;
  /** Ngân sách ký tự cho lời gọi tool trong lịch sử (mới nhất giữ trước). */
  toolBudget?: number;
  /** Ngân sách ký tự cho tin nhắn người dùng. */
  userBudget?: number;
}

const TAG = /<\/?(?:transcript|root_user_messages|user_instructions)\b[^>]*>/giu;
const neutralize = (text: string) => text.replace(TAG, (match) => match.replace("<", "[").replace(">", "]"));

export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)} …[${text.length - limit} chars omitted]… ${text.slice(text.length - tail)}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as { type?: string; text?: string };
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

const str = (value: unknown) => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value));

/** Dạng rút gọn của input tool cho bộ phân loại. `limit` áp cho phần nội dung dài. */
export function serializeInput(toolName: string, input: Record<string, unknown>, limit: number): unknown {
  switch (toolName) {
    case "bash":
    case "bg_run":
    case "powershell":
      return clip(str(input.command), limit);
    case "write":
      return `${str(input.path)}: ${clip(str(input.content), limit)}`;
    case "edit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const share = Math.max(200, Math.floor(limit / Math.max(1, edits.length)));
      return {
        path: str(input.path),
        edits: edits.map((edit) => {
          const item = (edit ?? {}) as { oldText?: unknown; newText?: unknown };
          return { removes: clip(str(item.oldText), Math.floor(share / 3)), adds: clip(str(item.newText), share) };
        }),
      };
    }
    case "Agent":
      return `(${str(input.subagent_type) || "agent"}${input.isolated === true ? ", isolated" : ""}): ${clip(str(input.prompt), limit)}`;
    case "SubagentWorkflow":
    case "mcpScript":
      return clip(str(input.script ?? input.code ?? input.source ?? JSON.stringify(input)), limit);
    case "web_search":
      return clip(str(input.query ?? input.queries), limit);
    default: {
      const json = JSON.stringify(input) ?? "{}";
      return json.length <= limit ? input : clip(json, limit);
    }
  }
}

function line(value: Record<string, unknown>): string {
  return neutralize(JSON.stringify(value));
}

/** Câu trả lời của ask_user_question (rpiv): lấy từ details có cấu trúc, không từ văn bản. */
function answerText(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const result = details as { answers?: unknown[]; cancelled?: boolean; globalNote?: string };
  if (result.cancelled) return "(the user declined to answer)";
  const parts: string[] = [];
  for (const raw of result.answers ?? []) {
    const answer = (raw ?? {}) as { question?: string; answer?: string; selected?: string[]; notes?: string };
    const value = answer.selected?.length ? answer.selected.join(", ") : answer.answer ?? "";
    parts.push(`"${answer.question ?? ""}" = "${value}"${answer.notes ? ` (notes: ${answer.notes})` : ""}`);
  }
  if (result.globalNote) parts.push(`note: ${result.globalNote}`);
  return parts.length ? parts.join("; ") : undefined;
}

/** Dấu thời gian của tin nhắn user do extension gửi (lưu bằng custom entry của extension này). */
export function relayedTimestamps(entries: SessionEntryLike[]): Set<number> {
  const result = new Set<number>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as { kind?: string; timestamp?: number } | undefined;
    if (data?.kind === "relayed" && typeof data.timestamp === "number") result.add(data.timestamp);
  }
  return result;
}

/** Tin nhắn thật của người dùng trên nhánh (dùng làm neo ý định cho subagent). */
export function humanMessages(entries: SessionEntryLike[], limit = 12_000): string[] {
  const relayed = relayedTimestamps(entries);
  const messages: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index].message;
    if (entries[index].type !== "message" || message?.role !== "user") continue;
    if (typeof message.timestamp === "number" && relayed.has(message.timestamp)) continue;
    const text = clip(textOf(message.content), 3_000);
    if (!text.trim()) continue;
    if (used + text.length > limit) break;
    used += text.length;
    messages.unshift(text);
  }
  return messages;
}

export function buildTranscript(entries: SessionEntryLike[], options: TranscriptOptions): string {
  const skip = options.skipTools ?? new Set<string>();
  const relayed = relayedTimestamps(entries);
  const toolBudget = options.toolBudget ?? 40_000;
  const userBudget = options.userBudget ?? 40_000;
  type Item = { kind: "user" | "tool" | "other"; text: string };
  const items: Item[] = [];
  let firstUser = true;
  for (const entry of entries) {
    if (entry.type === "compaction" && typeof entry.summary === "string") {
      items.push({ kind: "other", text: line({ compaction_summary: clip(entry.summary, 3_000) }) });
      continue;
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      items.push({ kind: "other", text: line({ branch_summary: clip(entry.summary, 1_500) }) });
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = clip(textOf(message.content), 6_000);
      if (!text.trim()) continue;
      // Trong subagent, mọi tin nhắn "user" đều do agent cha viết (nhiệm vụ, steer_subagent).
      let key = "user";
      if (options.child) key = firstUser ? "delegated_task" : "parent_message";
      else if (typeof message.timestamp === "number" && relayed.has(message.timestamp)) key = "extension_message";
      firstUser = false;
      items.push({ kind: key === "user" ? "user" : "other", text: line({ [key]: text }) });
    } else if (message.role === "bashExecution" && typeof message.command === "string") {
      items.push({ kind: "user", text: line({ user_shell: clip(message.command, 2_000) }) });
    } else if (message.role === "toolResult" && message.toolName === "ask_user_question") {
      const answer = answerText(message.details);
      if (answer) items.push({ kind: "user", text: line({ user_answer: clip(answer, 3_000) }) });
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        const call = part as { type?: string; name?: string; arguments?: Record<string, unknown>; id?: string };
        if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
        // Hành động đang xét và các lời gọi sau nó trong cùng tin nhắn không thuộc lịch sử.
        if (options.action.toolCallId && call.id === options.action.toolCallId) break;
        if (skip.has(call.name)) continue;
        items.push({ kind: "tool", text: line({ [call.name]: serializeInput(call.name, call.arguments ?? {}, 1_500) }) });
      }
    }
  }

  // Giữ mọi tin nhắn người dùng trong ngân sách (mới nhất trước), lời gọi tool mới nhất trước.
  let toolUsed = 0;
  let userUsed = 0;
  let omittedTools = 0;
  const kept: boolean[] = new Array(items.length).fill(false);
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "tool") {
      if (toolUsed + item.text.length <= toolBudget) {
        toolUsed += item.text.length;
        kept[index] = true;
      } else {
        omittedTools++;
      }
    } else if (userUsed + item.text.length <= userBudget) {
      userUsed += item.text.length;
      kept[index] = true;
    }
  }
  const lines: string[] = [];
  if (omittedTools) lines.push(line({ meta: { note: `${omittedTools} older agent actions omitted` } }));
  items.forEach((item, index) => {
    if (kept[index]) lines.push(item.text);
  });
  if (options.meta && Object.keys(options.meta).length) lines.push(line({ meta: options.meta }));
  lines.push(line({ [options.action.toolName]: serializeInput(options.action.toolName, options.action.input, 20_000) }));
  return `<transcript>\n${lines.join("\n")}\n</transcript>`;
}
