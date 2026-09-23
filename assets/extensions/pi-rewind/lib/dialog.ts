import path from "node:path";

/**
 * Hộp thoại Rewind theo bố cục của Claude Code: danh sách prompt → xác nhận với
 * các lựa chọn khôi phục. Không phụ thuộc trực tiếp Pi để kiểm thử độc lập;
 * index.ts truyền các hàm đo độ rộng/phím của pi-tui qua `deps`.
 */

export type RewindAction = "both" | "conversation" | "code" | "summarize" | "summarize_up_to" | "nevermind";

export interface RowStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface RewindRow {
  entryId: string;
  text: string;
  timestamp?: number;
  /** Có checkpoint code cho prompt này. */
  checkpointed: boolean;
}

export interface RewindChoice {
  action: Exclude<RewindAction, "nevermind">;
  entryId: string;
  instructions?: string;
}

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
}

export interface DialogDeps {
  truncate(text: string, width: number): string;
  width(text: string): number;
  wrap(text: string, width: number): string[];
  /** Kiểm phím theo tên: up, down, home, end, pageUp, pageDown, enter, escape, backspace. */
  is(data: string, key: string): boolean;
}

export interface DialogOptions {
  rows: RewindRow[];
  preselectedEntryId?: string;
  canSummarize: boolean;
  /** Theo dõi bash bằng git đang bật cho workspace này. */
  bashTracked: boolean;
  terminalRows: () => number;
  rowStats(row: RewindRow): Promise<RowStats | null>;
  /** undefined: prompt không có checkpoint nên không khôi phục code được. */
  restoreStats(row: RewindRow): Promise<RowStats | undefined>;
  execute(choice: RewindChoice): Promise<void>;
  done(): void;
  requestRender(): void;
  now?: () => number;
}

interface OptionItem {
  value: RewindAction;
  label: string;
  input?: boolean;
}

const POINTER = "❯";
const WARNING = "⚠";

export function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(timestamp).toLocaleString();
}

export function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim() || "(no prompt)";
}

export function describeFiles(files: string[]): string {
  const [first, second] = files.map((file) => path.basename(file));
  if (files.length === 1) return first;
  if (files.length === 2) return `${first} and ${second}`;
  return `${first} and ${files.length - 1} other files`;
}

export class RewindDialog {
  private readonly options: DialogOptions;
  private readonly theme: ThemeLike;
  private readonly deps: DialogDeps;
  private selected: number;
  private readonly stats = new Map<string, RowStats | null>();
  private confirming: RewindRow | undefined;
  private restore: RowStats | undefined;
  private restoreReady = false;
  private focus = 0;
  private readonly inputs = new Map<RewindAction, string>();
  private busy: RewindAction | undefined;
  private width = 80;
  private error: string | undefined;
  private disposed = false;

  constructor(options: DialogOptions, theme: ThemeLike, deps: DialogDeps) {
    this.options = options;
    this.theme = theme;
    this.deps = deps;
    this.selected = options.rows.length; // "(current)"
    for (const row of options.rows) {
      options.rowStats(row).then((value) => this.update(() => this.stats.set(row.entryId, value)), () => this.update(() => this.stats.set(row.entryId, null)));
    }
    const preselected = options.rows.find((row) => row.entryId === options.preselectedEntryId);
    if (preselected) this.openConfirm(preselected);
  }

  dispose(): void {
    this.disposed = true;
  }

  invalidate(): void {}

  private update(change: () => void): void {
    if (this.disposed) return;
    change();
    this.options.requestRender();
  }

  private get count(): number {
    return this.options.rows.length + 1;
  }

  private openConfirm(row: RewindRow): void {
    this.confirming = row;
    this.restore = undefined;
    this.restoreReady = false;
    this.focus = 0;
    this.options.restoreStats(row).then(
      (value) => this.update(() => {
        if (this.confirming !== row) return;
        this.restore = value;
        this.restoreReady = true;
      }),
      () => this.update(() => {
        this.restoreReady = true;
      }),
    );
  }

  private canRestoreCode(): boolean {
    return !!this.restore && this.restore.filesChanged.length > 0;
  }

  private items(): OptionItem[] {
    const items: OptionItem[] = this.canRestoreCode()
      ? [
        { value: "both", label: "Restore code and conversation" },
        { value: "conversation", label: "Restore conversation" },
        { value: "code", label: "Restore code" },
      ]
      : [{ value: "conversation", label: "Restore conversation" }];
    if (this.options.canSummarize) {
      items.push({ value: "summarize", label: "Summarize from here", input: true });
      items.push({ value: "summarize_up_to", label: "Summarize up to here", input: true });
    }
    items.push({ value: "nevermind", label: "Never mind" });
    return items;
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const { is } = this.deps;
    if (this.error !== undefined) {
      if (is(data, "escape")) this.options.done();
      else if (is(data, "enter")) this.update(() => {
        this.error = undefined;
        this.confirming = undefined;
      });
      return;
    }
    if (this.confirming) {
      this.handleConfirmInput(data);
      return;
    }
    if (is(data, "escape")) return this.options.done();
    if (is(data, "up")) return this.update(() => (this.selected = Math.max(0, this.selected - 1)));
    if (is(data, "down")) return this.update(() => (this.selected = Math.min(this.count - 1, this.selected + 1)));
    if (is(data, "home")) return this.update(() => (this.selected = 0));
    if (is(data, "end")) return this.update(() => (this.selected = this.count - 1));
    if (is(data, "pageUp")) return this.update(() => (this.selected = Math.max(0, this.selected - this.visibleCount())));
    if (is(data, "pageDown")) return this.update(() => (this.selected = Math.min(this.count - 1, this.selected + this.visibleCount())));
    if (is(data, "enter")) {
      const row = this.options.rows[this.selected];
      if (!row) return this.options.done(); // "(current)"
      this.update(() => this.openConfirm(row));
    }
  }

  private handleConfirmInput(data: string): void {
    const { is } = this.deps;
    const items = this.items();
    const item = items[Math.min(this.focus, items.length - 1)];
    if (is(data, "escape")) {
      if (this.options.preselectedEntryId) return this.options.done();
      return this.update(() => (this.confirming = undefined));
    }
    if (is(data, "up")) return this.update(() => (this.focus = (this.focus - 1 + items.length) % items.length));
    if (is(data, "down")) return this.update(() => (this.focus = (this.focus + 1) % items.length));
    if (is(data, "enter")) return this.choose(item);
    if (item?.input) {
      const value = this.inputs.get(item.value) ?? "";
      if (is(data, "backspace")) return this.update(() => this.inputs.set(item.value, Array.from(value).slice(0, -1).join("")));
      const text = data.replace(/\u001b\[20[01]~/gu, "");
      if (text && !text.startsWith("\u001b") && !/[\u0000-\u001f\u007f]/u.test(text)) {
        return this.update(() => this.inputs.set(item.value, value + text));
      }
      return;
    }
    if (/^[1-9]$/u.test(data)) {
      const index = Number(data) - 1;
      if (index < items.length) this.update(() => (this.focus = index));
      if (index < items.length) this.choose(items[index]);
    }
  }

  private choose(item: OptionItem | undefined): void {
    const row = this.confirming;
    if (!item || !row) return;
    if (!this.restoreReady && (item.value === "both" || item.value === "code")) return;
    if (item.value === "nevermind") {
      if (this.options.preselectedEntryId) return this.options.done();
      return this.update(() => (this.confirming = undefined));
    }
    const instructions = (this.inputs.get(item.value) ?? "").trim() || undefined;
    this.update(() => (this.busy = item.value));
    this.options.execute({ action: item.value, entryId: row.entryId, instructions }).then(
      () => {
        this.busy = undefined;
        this.options.done();
      },
      (error: unknown) => this.update(() => {
        this.busy = undefined;
        this.error = error instanceof Error ? error.message : String(error);
      }),
    );
  }

  private visibleCount(): number {
    return Math.max(2, Math.floor((this.options.terminalRows() - 12) / 3));
  }

  render(width: number): string[] {
    this.width = width;
    const t = this.theme;
    const fit = (line: string) => this.deps.truncate(line, Math.max(1, width));
    const lines: string[] = [];
    lines.push(t.fg("borderAccent", "─".repeat(Math.max(1, width))));
    lines.push(` ${t.bold(t.fg("accent", "Rewind"))}`);
    if (this.error !== undefined) {
      for (const line of this.error.split("\n")) lines.push(` ${t.fg("error", line)}`);
      lines.push("");
      lines.push(` ${t.fg("dim", "enter to go back · esc to close")}`);
    } else if (this.options.rows.length === 0) {
      lines.push(` ${t.fg("muted", "Nothing to rewind to yet.")}`);
      lines.push("");
      lines.push(` ${t.fg("dim", "esc to cancel")}`);
    } else if (this.confirming) {
      this.renderConfirm(lines, this.confirming);
    } else {
      this.renderList(lines, width);
    }
    lines.push(t.fg("borderAccent", "─".repeat(Math.max(1, width))));
    return lines.map(fit);
  }

  private statsLine(stats: RowStats): string {
    const t = this.theme;
    const count = stats.filesChanged.length;
    const label = count === 1 ? `${path.basename(stats.filesChanged[0])} ` : `${count} files changed `;
    return `${label}${t.fg("success", `+${stats.insertions}`)} ${t.fg("error", `-${stats.deletions}`)}`;
  }

  private renderList(lines: string[], width: number): void {
    const t = this.theme;
    lines.push(` ${t.fg("text", "Restore the code and/or conversation to the point before…")}`);
    lines.push("");
    const visible = this.visibleCount();
    const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), this.count - visible));
    const end = Math.min(this.count, start + visible);
    if (start > 0) lines.push(` ${t.fg("dim", `↑ ${start} more above`)}`);
    for (let index = start; index < end; index++) {
      const active = index === this.selected;
      const pointer = active ? t.bold(t.fg("accent", `${POINTER} `)) : "  ";
      const row = this.options.rows[index];
      if (!row) {
        lines.push(` ${pointer}${t.italic(active ? t.fg("accent", "(current)") : "(current)")}`);
        continue;
      }
      const text = this.deps.truncate(oneLine(row.text), Math.max(10, width - 14));
      lines.push(` ${pointer}${active ? t.fg("accent", text) : text}`);
      if (!row.checkpointed) {
        lines.push(`   ${t.fg("warning", `${WARNING} No code restore`)}`);
      } else {
        const stats = this.stats.get(row.entryId);
        if (stats === undefined) lines.push(`   ${t.fg("dim", "…")}`);
        else if (stats === null || stats.filesChanged.length === 0) lines.push(`   ${t.fg("dim", "No code changes")}`);
        else lines.push(`   ${t.fg("dim", this.statsLine(stats))}`);
      }
      lines.push("");
    }
    if (end < this.count) lines.push(` ${t.fg("dim", `↓ ${this.count - end} more below`)}`);
    lines.push(` ${t.fg("dim", "enter to continue · esc to cancel")}`);
  }

  private renderConfirm(lines: string[], row: RewindRow): void {
    const t = this.theme;
    const now = (this.options.now ?? Date.now)();
    const codeKnown = this.restoreReady && this.restore !== undefined;
    for (const line of this.deps.wrap(`Confirm you want to restore ${codeKnown ? "" : "the conversation "}to the point before you sent this message:`, Math.max(10, this.width - 2))) {
      lines.push(` ${line}`);
    }
    const message = row.text.trim() || "(no prompt)";
    const wrapped = message.slice(0, 500).split("\n").slice(0, 4).flatMap((line) => this.deps.wrap(line, Math.max(10, this.width - 4))).slice(0, 4);
    for (const line of wrapped) lines.push(` ${t.fg("dim", "│")} ${line}`);
    if (row.timestamp !== undefined && Number.isFinite(row.timestamp)) lines.push(` ${t.fg("dim", "│")} ${t.fg("dim", `(${relativeTime(row.timestamp, now)})`)}`);
    lines.push("");
    const items = this.items();
    const focus = items[Math.min(this.focus, items.length - 1)]?.value ?? "conversation";
    for (const line of this.deps.wrap(describeConversation(focus), Math.max(10, this.width - 2))) lines.push(` ${t.fg("dim", line)}`);
    const code = describeCode(focus, this.restoreReady, this.restore);
    if (code) for (const line of this.deps.wrap(code, Math.max(10, this.width - 2))) lines.push(` ${t.fg("dim", line)}`);
    lines.push("");
    if (this.busy === "summarize" || this.busy === "summarize_up_to") {
      lines.push(` ${t.fg("accent", "⠿")} Summarizing…`);
      return;
    }
    if (this.busy) {
      lines.push(` ${t.fg("accent", "⠿")} Restoring…`);
      return;
    }
    items.forEach((item, index) => {
      const active = index === Math.min(this.focus, items.length - 1);
      const pointer = active ? t.bold(t.fg("accent", `${POINTER} `)) : "  ";
      let label = `${index + 1}. ${item.label}`;
      if (item.input) {
        const value = this.inputs.get(item.value) ?? "";
        if (active) label += `: ${value || t.fg("dim", "add context (optional)")}`;
        else if (value) label += `: ${value}`;
      }
      lines.push(` ${pointer}${active ? t.fg("accent", label) : label}`);
    });
    if (this.canRestoreCode()) {
      lines.push("");
      const note = this.options.bashTracked
        ? "Rewinding does not affect files edited manually, or git-ignored files changed via bash."
        : "Rewinding does not affect files edited manually or via bash.";
      this.deps.wrap(note, Math.max(10, this.width - 3)).forEach((line, index) => {
        lines.push(` ${index === 0 ? t.fg("warning", WARNING) : " "} ${t.fg("dim", line)}`);
      });
    }
    lines.push("");
    lines.push(` ${t.fg("dim", `enter to select · esc to ${this.options.preselectedEntryId ? "cancel" : "go back"}`)}`);
  }
}

export function describeConversation(action: RewindAction): string {
  switch (action) {
    case "summarize":
      return "Messages after this point will be summarized.";
    case "summarize_up_to":
      return "Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.";
    case "both":
    case "conversation":
      return "The conversation will be forked (the current branch stays in /tree).";
    default:
      return "The conversation will be unchanged.";
  }
}

export function describeCode(action: RewindAction, ready: boolean, stats: RowStats | undefined): string | undefined {
  if (action === "summarize" || action === "summarize_up_to") return undefined;
  if (action !== "both" && action !== "code") return "The code will be unchanged.";
  if (!ready) return "Checking code changes…";
  if (!stats || stats.filesChanged.length === 0) return "The code has not changed (nothing will be restored).";
  return `The code will be restored +${stats.insertions} -${stats.deletions} in ${describeFiles(stats.filesChanged)}.`;
}
