/**
 * Trạng thái sống của cây agent trong một phiên, dựng từ sự kiện thật: vòng đời subagent (pi-subagents), lời gọi
 * ask_advisor (pi-advisor-flow) và quyết định của auto mode (pi-auto-mode). Hàm ở đây thuần: nhận payload chưa
 * kiểm tra, bỏ qua payload lạ, sửa state tại chỗ.
 */

export type Tone = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";

export interface RunningAgent {
  id: string;
  type: string;
  description?: string;
  since: number;
}

export interface LogEntry {
  at: number;
  text: string;
  tone?: Tone;
  /** Gộp các sự kiện cùng loại liền nhau (jev sharp) thành một dòng. */
  key?: string;
  count?: number;
}

export interface TreeState {
  running: Map<string, RunningAgent>;
  advisor: { calls: number; failures: number; last?: string };
  /** sharp: Jev cho qua; split: bị gắn cờ, LLM giai đoạn 2 xét; llm: bộ phân loại LLM xét khi không có Jev. */
  jev: { sharp: number; split: number; llm: number };
  log: LogEntry[];
}

/** Sự kiện auto mode phát (pi-auto-mode/lib/decision-event.ts). */
export const DECISION_EVENT = "pi-config:auto-mode-decision";
/** Sự kiện vòng đời subagent của @tintinweb/pi-subagents 0.19.0 (src/index.ts). */
export const SUBAGENT_EVENTS = ["started", "completed", "failed", "steered", "compacted"] as const;
export type SubagentEvent = (typeof SUBAGENT_EVENTS)[number];
export const ADVISOR_TOOL = "ask_advisor";
export const LOG_LIMIT = 20;

export function createState(): TreeState {
  return { running: new Map(), advisor: { calls: 0, failures: 0 }, jev: { sharp: 0, split: 0, llm: 0 }, log: [] };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Một dòng, bỏ khoảng trắng thừa, cắt còn max ký tự. */
export function clip(value: string, max: number): string {
  const line = value.replace(/\s+/gu, " ").trim();
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function pushLog(state: TreeState, entry: LogEntry): void {
  const last = state.log.at(-1);
  if (entry.key && last?.key === entry.key) {
    last.count = (last.count ?? 1) + 1;
    last.at = entry.at;
    last.text = entry.text;
    return;
  }
  state.log.push(entry);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

/** 950 → "950ms", 12_400 → "12s", 185_000 → "3m05s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Payload của subagents:started/completed/failed/steered/compacted: {id, type, description, ...}. */
export function applySubagent(state: TreeState, kind: SubagentEvent, payload: unknown, now: number): boolean {
  const data = record(payload);
  const id = str(data?.id);
  if (!data || !id) return false;
  const known = state.running.get(id);
  const type = str(data.type) ?? known?.type ?? "agent";
  const description = str(data.description) ?? known?.description;
  const about = description ? ` · ${clip(description, 48)}` : "";
  switch (kind) {
    case "started":
      state.running.set(id, { id, type, description, since: now });
      pushLog(state, { at: now, text: `${type} bắt đầu${about}`, tone: "accent" });
      return true;
    case "completed": {
      state.running.delete(id);
      const ms = typeof data.durationMs === "number" && Number.isFinite(data.durationMs) ? data.durationMs : known ? now - known.since : undefined;
      pushLog(state, { at: now, text: `${type} xong${ms !== undefined ? ` (${formatDuration(ms)})` : ""}${about}`, tone: "success" });
      return true;
    }
    case "failed": {
      state.running.delete(id);
      const status = str(data.status);
      const stopped = status === "stopped" || status === "aborted";
      const error = !stopped && str(data.error) ? `: ${clip(str(data.error) ?? "", 48)}` : "";
      pushLog(state, { at: now, text: `${type} ${stopped ? "bị dừng" : "lỗi"}${error}`, tone: stopped ? "warning" : "error" });
      return true;
    }
    case "steered":
      pushLog(state, { at: now, text: `${type} nhận chỉ dẫn thêm`, tone: "muted" });
      return true;
    case "compacted":
      pushLog(state, { at: now, text: `${type} compact context`, tone: "muted" });
      return true;
  }
}

function resultText(result: unknown): string {
  const content = record(result)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (record(part)?.type === "text" ? String(record(part)?.text ?? "") : "")).join("\n");
}

/** Dòng có nội dung đầu tiên của lời khuyên, bỏ ký hiệu markdown đầu dòng. */
export function firstLine(markdown: string): string | undefined {
  for (const raw of markdown.split(/\r?\n/u)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)*/u, "").replace(/\*\*|__|`/gu, "").trim();
    if (line) return line;
  }
  return undefined;
}

/**
 * tool_execution_end của ask_advisor. Chỉ lời gọi trả về lời khuyên (details.adviceId) được tính vào số lần đã dùng;
 * lời gọi bị bỏ qua (Jev của advisor, cùng model) không tính; lỗi được đếm riêng.
 */
export function applyAdvisor(state: TreeState, event: { isError?: boolean; result?: unknown }, now: number): boolean {
  const details = record(record(event.result)?.details);
  const body = resultText(event.result);
  if (event.isError) {
    state.advisor.failures++;
    pushLog(state, { at: now, text: `advisor lỗi${body ? `: ${clip(body, 60)}` : ""}`, tone: "error" });
    return true;
  }
  if (!str(details?.adviceId)) {
    pushLog(state, { at: now, text: "advisor bỏ qua lần gọi", tone: "muted" });
    return true;
  }
  state.advisor.calls++;
  // content = "Advisor (<model>)\n\n<markdown>"; details.text là markdown gốc.
  const advice = firstLine(str(details?.text) ?? body.replace(/^Advisor \([^)]*\)\s*/u, ""));
  if (advice) state.advisor.last = advice;
  pushLog(state, { at: now, text: `advisor: ${advice ?? "đã trả lời"}`, tone: "accent" });
  return true;
}

/**
 * pi-config:auto-mode-decision. Trả true khi số liệu hiển thị đổi. Nhật ký giữ phần đáng chú ý: sharp gộp thành một
 * dòng đếm, split kèm phán quyết, bị chặn; lệnh qua đường tất định không ghi.
 */
export function applyDecision(state: TreeState, payload: unknown, now: number): boolean {
  const data = record(payload);
  const tool = str(data?.tool);
  if (!data || !tool) return false;
  const allowed = data.allowed === true;
  const who = data.child === true ? " (subagent)" : "";
  switch (data.stage) {
    case "sharp":
      state.jev.sharp++;
      pushLog(state, { at: now, text: `jev sharp → chạy ${tool}${who}`, tone: "success", key: "jev-sharp" });
      return true;
    case "split":
      state.jev.split++;
      pushLog(state, {
        at: now, text: `jev split ${tool}${who} → ${allowed ? "cho phép" : "chặn"}${data.flaggedBy === "policy" ? " (chính sách gắn cờ)" : ""}`,
        tone: allowed ? "warning" : "error",
      });
      return true;
    case "classifier":
      state.jev.llm++;
      if (!allowed) pushLog(state, { at: now, text: `auto mode chặn ${tool}${who}`, tone: "error" });
      return true;
    case "policy":
      if (!allowed) pushLog(state, { at: now, text: `luật chặn ${tool}${who}`, tone: "error" });
      return !allowed;
    default:
      return false;
  }
}
