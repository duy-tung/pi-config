import type { AdvisorGate, Sources } from "./sources.ts";
import { dominantThinking } from "./sources.ts";
import type { LogEntry, Tone, TreeState } from "./state.ts";

/**
 * Chữ của footer và widget /agent-tree. Mỗi dòng là dãy đoạn {text, tone}; index.ts tô màu bằng theme, test đọc
 * chữ trơn. Độ rộng tính theo ký tự (chuỗi ở đây không có ký tự rộng), cắt bằng "…".
 */

export interface Segment {
  text: string;
  tone?: Tone;
}
export type Line = Segment[];

export interface MainInfo {
  model?: string;
  thinking?: string;
  contextWindow?: number;
}

export interface View {
  main: MainInfo;
  sources: Sources;
  state: TreeState;
}

export const GATE_LABELS: Record<AdvisorGate, string> = { plan: "trước plan", failure: "lỗi lặp", completion: "trước khi xong" };
/** Widget dạng mảng chữ của Pi hiện tối đa 10 dòng (InteractiveMode.MAX_WIDGET_LINES). */
export const MAX_LINES = 10;
export const DEFAULT_WIDTH = 90;
const LABEL_WIDTH = 10;
const LOG_LINES = 5;

/** "anthropic/claude-opus-5-5" → "claude-opus-5-5". */
export const modelId = (model: string | undefined) => model?.slice(model.lastIndexOf("/") + 1) || undefined;
/** Dạng gọn cho hàng agents: "anthropic/claude-opus-5-5" → "opus-5-5". */
export const shortModel = (model: string | undefined) => modelId(model)?.replace(/^claude-/u, "");

/** 1_000_000 → "1M", 200_000 → "200k", 1_500_000 → "1.5M". */
export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.max(1, Math.round(tokens / 1_000))}k`;
}

/** "HH:MM:SS" theo giờ máy. */
export function clock(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

export const plain = (line: Line) => line.map((segment) => segment.text).join("");

/** Cắt dòng còn width ký tự, giữ tone của từng đoạn. */
export function fitLine(line: Line, width: number): Line {
  const out: Line = [];
  let room = Math.max(1, width);
  const total = [...plain(line)].length;
  if (total <= room) return line;
  room -= 1;
  for (const segment of line) {
    if (room <= 0) break;
    const chars = [...segment.text];
    out.push({ ...segment, text: chars.slice(0, room).join("") });
    room -= Math.min(room, chars.length);
  }
  while (out.length && !out.at(-1)?.text.trimEnd()) out.pop();
  const tail = out.at(-1);
  if (tail) tail.text = tail.text.trimEnd();
  out.push({ text: "…", tone: "dim" });
  return out;
}

const advisorUsage = (view: View) => {
  const { advisor } = view.sources;
  return advisor.maxCalls === undefined ? `${view.state.advisor.calls}` : `${view.state.advisor.calls}/${advisor.maxCalls}`;
};

/**
 * Footer: "high/medium · agents 1/4 · advisor 2/7 · jev 41↑5".
 * - thinking của phiên chính / thinking phổ biến nhất của các vai subagent;
 * - subagent đang chạy / maxConcurrent;
 * - advisor: số lần đã hỏi / tối đa mỗi phiên (không giới hạn thì chỉ số lần); alwaysOn tắt thì "advisor off";
 * - jev: số quyết định qua lớp Jev ↑ số bị gắn cờ đẩy lên LLM; chưa có thì bỏ.
 */
export function statusLine(view: View): Line {
  const { sources, state, main } = view;
  const parts: Line[] = [];
  const effort = dominantThinking(sources.roles);
  parts.push([{ text: [main.thinking ?? "?", ...(effort ? [effort] : [])].join("/"), tone: "muted" }]);
  const running = state.running.size;
  parts.push([{ text: `agents ${running}/${sources.maxConcurrent}`, tone: running ? "accent" : "muted" }]);
  if (sources.advisor.alwaysOn) {
    const spent = sources.advisor.maxCalls !== undefined && state.advisor.calls >= sources.advisor.maxCalls;
    parts.push([{ text: `advisor ${advisorUsage(view)}`, tone: spent ? "warning" : "muted" }]);
  } else {
    parts.push([{ text: "advisor off", tone: "dim" }]);
  }
  const screened = state.jev.sharp + state.jev.split;
  if (screened) parts.push([{ text: `jev ${screened}↑${state.jev.split}`, tone: "muted" }]);
  return parts.flatMap((part, index) => (index ? [{ text: " · ", tone: "dim" as Tone }, ...part] : part));
}

function label(name: string, narrow: boolean): Segment {
  return { text: narrow ? `${name} ` : name.padEnd(LABEL_WIDTH), tone: "accent" };
}

const indent = (narrow: boolean): Segment => ({ text: narrow ? "  " : " ".repeat(LABEL_WIDTH) });
const sep: Segment = { text: " · ", tone: "dim" };
const join = (items: Line[]): Line => items.flatMap((item, index) => (index ? [sep, ...item] : item));

function mainLine(view: View, narrow: boolean): Line {
  const { main } = view;
  const facts: Line[] = [[{ text: modelId(main.model) ?? "chưa chọn model" }]];
  if (main.thinking) facts.push([{ text: main.thinking, tone: "muted" }]);
  if (main.contextWindow) facts.push([{ text: formatWindow(main.contextWindow), tone: "muted" }]);
  facts.push([{ text: "lập kế hoạch, quyết định", tone: "dim" }]);
  return [label("main", narrow), ...join(facts)];
}

function advisorLines(view: View, narrow: boolean): Line[] {
  const { advisor } = view.sources;
  if (!advisor.configured) return [[label("advisor", narrow), { text: "chưa cấu hình (advisor.json)", tone: "dim" }]];
  if (!advisor.alwaysOn) return [[label("advisor", narrow), { text: "tắt (alwaysOn false)", tone: "dim" }]];
  const facts: Line[] = [[{ text: modelId(advisor.model) ?? "model mặc định" }]];
  if (advisor.effort) facts.push([{ text: advisor.effort, tone: "muted" }]);
  const { last, calls, failures } = view.state.advisor;
  facts.push([{ text: calls ? `${advisorUsage(view)} lần` : `chưa gọi (${advisorUsage(view)})`, tone: "muted" }]);
  facts.push([{ text: advisor.gates.length ? advisor.gates.map((gate) => GATE_LABELS[gate]).join(", ") : "không gate", tone: "dim" }]);
  const lines: Line[] = [[label("advisor", narrow), ...join(facts)]];
  if (last) lines.push([indent(narrow), { text: "gần nhất: ", tone: "dim" }, { text: last, tone: "muted" }]);
  if (failures) lines.push([indent(narrow), { text: `${failures} lần gọi lỗi`, tone: "warning" }]);
  return lines;
}

function jevLine(view: View, narrow: boolean): Line {
  const { autoMode } = view.sources;
  const { sharp, split, llm } = view.state.jev;
  const reviewer = `${modelId(autoMode.model) ?? "model phiên"} (${autoMode.reasoning})`;
  const facts: Line[] = [];
  if (sharp + split) {
    facts.push([{ text: `${sharp + split} sàng lọc` }]);
    facts.push([{ text: `${sharp} sharp → chạy`, tone: "success" }]);
    facts.push([{ text: `${split} split → ${reviewer}`, tone: split ? "warning" : "muted" }]);
  } else {
    facts.push([{ text: autoMode.jev ? "chưa sàng lọc" : "tắt (autoMode.jev false)", tone: "dim" }]);
    facts.push([{ text: `split → ${reviewer}`, tone: "muted" }]);
  }
  if (llm) facts.push([{ text: `${llm} LLM xét`, tone: "muted" }]);
  return [label("jev", narrow), ...join(facts)];
}

/**
 * Hàng subagent, gom các vai cùng model/thinking: "opus-5-5/medium: worker ◐ explorer ○ researcher ○" (◐ đang chạy,
 * kèm số nếu nhiều; ○ rảnh); nhóm theo thứ tự vai đầu tiên của nhóm, xuống dòng theo độ rộng.
 */
function agentLines(view: View, width: number, narrow: boolean): Line[] {
  const { roles, maxConcurrent } = view.sources;
  const running = new Map<string, number>();
  for (const agent of view.state.running.values()) running.set(agent.type, (running.get(agent.type) ?? 0) + 1);
  const mark = (name: string): Line => {
    const busy = running.get(name) ?? 0;
    return [{ text: name, tone: busy ? "accent" : "text" }, busy ? { text: ` ◐${busy > 1 ? busy : ""}`, tone: "success" } : { text: " ○", tone: "dim" }];
  };
  const groups = new Map<string, string[]>();
  for (const role of roles) {
    const spec = [shortModel(role.model), role.thinking].filter(Boolean).join("/");
    groups.set(spec, [...(groups.get(spec) ?? []), role.name]);
  }
  // Agent đang chạy thuộc loại không có file vai (vd agent dựng sẵn).
  const extra = [...running.keys()].filter((type) => !roles.some((role) => role.name === type));
  if (extra.length) groups.set("", [...(groups.get("") ?? []), ...extra]);
  const items: Line[] = [...groups].map(([spec, names]) => [
    ...(spec ? [{ text: `${spec}: `, tone: "muted" as Tone }] : []),
    ...names.flatMap((name, index) => (index ? [{ text: " " }, ...mark(name)] : mark(name))),
  ]);
  const head: Line = [label("agents", narrow), { text: `${view.state.running.size}/${maxConcurrent} đang chạy`, tone: view.state.running.size ? "success" : "muted" }];
  if (!items.length) return [head];
  const lines: Line[] = [];
  let current = head;
  for (const item of items) {
    const next = [...current, sep, ...item];
    if ([...plain(next)].length > width) {
      lines.push(current);
      current = [indent(narrow), ...item];
    } else {
      current = next;
    }
  }
  lines.push(current);
  return lines;
}

function logText(entry: LogEntry): string {
  return entry.count && entry.count > 1 ? `${entry.text} · ×${entry.count}` : entry.text;
}

function logLines(view: View, narrow: boolean, room: number): Line[] {
  const entries = view.state.log.slice(-Math.max(1, room));
  if (!entries.length) return [[label("log", narrow), { text: "chưa có sự kiện", tone: "dim" }]];
  return entries.map((entry, index) => [
    index ? indent(narrow) : label("log", narrow),
    { text: `${clock(entry.at)} `, tone: "dim" },
    { text: logText(entry), tone: entry.tone ?? "text" },
  ]);
}

/**
 * Widget /agent-tree:
 *   main      claude-opus-5-5 · high · 1M · lập kế hoạch, quyết định
 *   advisor   claude-fable-5-1 · high · 2/7 lần · trước plan, lỗi lặp, trước khi xong
 *             gần nhất: <dòng đầu lời khuyên>   (và "N lần gọi lỗi" nếu có)
 *   jev       41 sàng lọc · 36 sharp → chạy · 5 split → claude-opus-5-5 (low)
 *   agents    1/4 đang chạy · opus-5-5/medium: worker ◐ explorer ○ researcher ○ debugger ○
 *             fable-5-1/high: reviewer ○ verifier ○
 *   log       23:49:28 explorer xong (12s) · 5 sự kiện gần nhất, cũ trước
 * Hẹp hơn 60 cột thì bỏ cột nhãn cố định. Tổng số dòng không quá MAX_LINES (nhật ký nhường chỗ).
 */
export function widgetLines(view: View, width = DEFAULT_WIDTH): Line[] {
  const narrow = width < 60;
  const top = [mainLine(view, narrow), ...advisorLines(view, narrow), jevLine(view, narrow), ...agentLines(view, width, narrow)];
  const room = Math.min(LOG_LINES, MAX_LINES - top.length);
  return [...top, ...logLines(view, narrow, room)].slice(0, MAX_LINES).map((line) => fitLine(line, width));
}
