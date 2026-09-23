import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, estimateTokens, generateSummaryWithUsage, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadConfig } from "./lib/config.ts";
import { type DialogDeps, describeFiles, oneLine, type RewindChoice, RewindDialog, type RewindRow, type RowStats } from "./lib/dialog.ts";
import { bufferDiffCounts } from "./lib/diff.ts";
import { GitWatcher, type WatchWindow } from "./lib/gitwatch.ts";
import { type Checkpoint, ENTRY_TYPE, History, type RestoreMode, type RewindEntry, type SessionEntryLike } from "./lib/history.ts";
import { resolveToolPath } from "./lib/paths.ts";
import { applyRestore, describeRestore, planRestore, planStats } from "./lib/restore.ts";
import { BlobStore, Capturer, type FileVersion } from "./lib/store.ts";

/**
 * pi-rewind: checkpoint theo prompt và /rewind (Esc Esc) như Claude Code.
 * - Trước khi agent xử lý mỗi prompt: ghi phiên bản của mọi file đã theo dõi.
 * - edit/write: lưu nội dung trước lần sửa đầu tiên trong lượt.
 * - bash/Agent (trong git worktree): so git status trước/sau để biết file bị đổi.
 * - Khôi phục code chỉ đụng tới file agent đã theo dõi; hội thoại dùng navigateTree.
 */
export default function piRewind(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const config = loadConfig(agentDir);
  const store = new BlobStore(config.storageDir);
  const capturer = new Capturer(store, { maxBytes: config.maxFileBytes });
  let notifyContext: ExtensionContext | undefined;
  const watcher = new GitWatcher(capturer, {
    slowMs: config.watchSlowMs,
    maxDirty: config.watchMaxDirty,
    onDisable: (top, reason) => notifyContext?.ui.notify(`Rewind: ngừng theo dõi thay đổi bằng bash trong ${top} (${reason}).`, "warning"),
  });

  let history = new History();
  let current: Checkpoint | undefined;
  let pending: { id: string; at: number; delta: Record<string, FileVersion>; timestamp?: number; source?: string } | undefined;
  let awaitingPrompt = false;
  let lastInputSource: string | undefined;
  let promptDepth = 0;
  let unsubscribeInput: (() => void) | undefined;
  const windows = new Map<string, WatchWindow>();
  const bashTracked = new Map<string, boolean>();

  const append = (data: RewindEntry) => {
    pi.appendEntry(ENTRY_TYPE, data);
    history.apply(data);
  };

  function persistPending(ctx: ExtensionContext): void {
    const draft = pending;
    if (!draft) return;
    pending = undefined;
    const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      if (draft.timestamp !== undefined && entry.message.timestamp !== undefined && entry.message.timestamp !== draft.timestamp) return;
      append({ v: 1, kind: "checkpoint", id: draft.id, userEntryId: entry.id, at: draft.at, source: draft.source, delta: draft.delta });
      current = history.byId.get(draft.id);
      return;
    }
  }

  function touch(file: string, via: string, pre: () => FileVersion): void {
    if (!current || current.touched.has(file)) return;
    const data: RewindEntry = { v: 1, kind: "touch", checkpointId: current.id, file, via };
    // File chưa có trong ảnh chụp đầu lượt: cần nội dung trước lần chạm này.
    if (!current.files.has(file)) data.pre = pre();
    append(data);
  }

  pi.on("session_start", (_event, ctx) => {
    history = History.fromEntries(ctx.sessionManager.getEntries() as SessionEntryLike[]);
    current = history.checkpoints.at(-1);
    pending = undefined;
    awaitingPrompt = false;
    notifyContext = ctx;
    if (config.enabled) installDoubleEscape(ctx);
    scheduleGc();
  });

  pi.on("session_shutdown", () => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    windows.clear();
  });

  pi.on("ui_prompt_start", () => {
    promptDepth++;
  });
  pi.on("ui_prompt_end", () => {
    promptDepth = Math.max(0, promptDepth - 1);
  });

  if (config.enabled) {
    pi.on("input", (event) => {
      lastInputSource = event.source;
    });

    pi.on("agent_start", () => {
      awaitingPrompt = true;
    });

    // User message chưa được ghi vào phiên ở message_end; chỉ chụp trạng thái ở đây,
    // entry checkpoint được ghi khi user message đã có id (message_start của assistant).
    pi.on("message_end", (event) => {
      if (!awaitingPrompt || event.message.role !== "user") return;
      awaitingPrompt = false;
      pending = {
        id: randomUUID(), at: Date.now(), delta: history.delta((file) => capturer.capture(file)),
        timestamp: typeof event.message.timestamp === "number" ? event.message.timestamp : undefined,
        source: lastInputSource,
      };
      lastInputSource = undefined;
    });

    pi.on("message_start", (event, ctx) => {
      if (pending && event.message.role === "assistant") persistPending(ctx);
    });

    pi.on("tool_call", async (event, ctx) => {
      if (pending) persistPending(ctx);
      if (!current) return;
      if (event.toolName === "edit" || event.toolName === "write") {
        const file = resolveToolPath((event.input as { path?: unknown }).path, ctx.cwd);
        if (file) touch(file, event.toolName, () => capturer.capture(file));
        return;
      }
      if (!config.watchTools.includes(event.toolName)) return;
      try {
        const window = await watcher.begin(ctx.cwd);
        bashTracked.set(ctx.cwd, !!window);
        if (window) windows.set(event.toolCallId, window);
      } catch {
        /* không chặn tool vì lỗi theo dõi */
      }
    });

    pi.on("tool_result", async (event) => {
      const window = windows.get(event.toolCallId);
      if (!window) return;
      windows.delete(event.toolCallId);
      try {
        for (const change of await watcher.end(window)) touch(change.file, event.toolName, () => change.before);
      } catch {
        /* bỏ qua: tool đã chạy xong */
      }
    });
  }

  function installDoubleEscape(ctx: ExtensionContext): void {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    // Pi tự mở /tree khi doubleEscapeAction khác "none"; không tranh phím với nó.
    if (ctx.mode !== "tui" || !config.doubleEscape || config.doubleEscapeAction !== "none") return;
    let tui: { getFocusedComponent?: () => unknown } | undefined;
    // Lấy TUI để biết editor chính có đang giữ focus (không bắt Esc của dialog khác).
    ctx.ui.setWidget("pi-rewind-probe", (instance) => {
      tui = instance as typeof tui;
      return { render: () => [], invalidate: () => {} };
    });
    ctx.ui.setWidget("pi-rewind-probe", undefined);
    let last = 0;
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      // Listener nhận dữ liệu thô trước TUI: với kitty keyboard protocol một lần nhấn
      // Esc còn kèm sự kiện nhả/lặp phím, không được tính là lần nhấn thứ hai.
      if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
      // tmux có thể gửi hai lần Esc nhanh thành một khối.
      const doubled = data === "\u001b\u001b";
      if (!doubled && !matchesKey(data, "escape")) {
        last = 0;
        return undefined;
      }
      const focused = tui?.getFocusedComponent?.() as { getText?: unknown; insertTextAtCursor?: unknown } | undefined;
      const editorFocused = !!focused && typeof focused.getText === "function" && typeof focused.insertTextAtCursor === "function";
      if (!editorFocused || promptDepth > 0 || !ctx.isIdle() || ctx.ui.getEditorText().trim()) {
        last = 0;
        return undefined;
      }
      const now = Date.now();
      if (doubled || now - last < 500) {
        last = 0;
        pi.sendUserMessage("/rewind", { expandPromptTemplates: true });
        return { consume: true };
      }
      last = now;
      return undefined;
    });
  }

  function scheduleGc(): void {
    const marker = path.join(config.storageDir, "last-gc");
    let lastRun = 0;
    try {
      lastRun = fs.statSync(marker).mtimeMs;
    } catch {
      /* chưa từng chạy */
    }
    if (Date.now() - lastRun < 24 * 3600 * 1000) return;
    const timer = setTimeout(() => {
      try {
        fs.mkdirSync(config.storageDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(marker, new Date().toISOString());
        store.gc(config.retentionDays * 24 * 3600 * 1000);
      } catch {
        /* dọn dẹp là best-effort */
      }
    }, 5000);
    timer.unref?.();
  }

  // ---------------------------------------------------------------- dữ liệu cho UI

  function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join(" ");
  }

  /** Prompt trên nhánh hiện tại. Tin nhắn chen giữa lượt (steer) không có checkpoint nên bị ẩn như Claude Code. */
  function buildRows(ctx: ExtensionContext): RewindRow[] {
    const rows: RewindRow[] = [];
    let seenCheckpoint = false;
    for (const entry of ctx.sessionManager.getBranch() as SessionEntryLike[]) {
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const checkpointed = history.byUserEntry.has(entry.id);
      if (checkpointed) seenCheckpoint = true;
      else if (seenCheckpoint) continue;
      const timestamp = entry.message.timestamp ?? (entry.timestamp ? Date.parse(entry.timestamp) : undefined);
      rows.push({ entryId: entry.id, text: textOf(entry.message.content), timestamp, checkpointed });
    }
    return rows;
  }

  /** Văn bản prompt như navigateTree của Pi đưa vào editor (contentText(content, "")). */
  function promptText(ctx: ExtensionContext, entryId: string): string | undefined {
    const entry = ctx.sessionManager.getEntry(entryId) as SessionEntryLike | undefined;
    const content = entry?.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? "")).join("");
  }

  function read(version: FileVersion): Buffer | undefined {
    return version.kind === "file" ? store.read(version.sha) : undefined;
  }

  const idle = () => new Promise<void>((resolve) => setImmediate(resolve));

  async function rowStats(row: RewindRow): Promise<RowStats | null> {
    const checkpoint = history.byUserEntry.get(row.entryId);
    if (!checkpoint) return null;
    await idle();
    const stats: RowStats = { filesChanged: [], insertions: 0, deletions: 0 };
    for (const change of history.turnChanges(checkpoint, (file) => capturer.capture(file))) {
      stats.filesChanged.push(change.file);
      if (change.before.kind === "unprotected" || change.after.kind === "unprotected") continue;
      try {
        const counts = bufferDiffCounts(read(change.before), read(change.after));
        stats.insertions += counts.insertions;
        stats.deletions += counts.deletions;
      } catch {
        /* blob đã bị dọn */
      }
    }
    return stats;
  }

  async function restoreStats(row: RewindRow): Promise<RowStats | undefined> {
    const checkpoint = history.byUserEntry.get(row.entryId);
    if (!checkpoint) return undefined;
    await idle();
    return planStats(planRestore(history.targetsFor(checkpoint), capturer), store);
  }

  // ---------------------------------------------------------------- hành động

  async function restoreCode(ctx: ExtensionCommandContext, targets: Map<string, FileVersion>): Promise<Record<string, FileVersion>> {
    const plan = planRestore(targets, capturer);
    const previous: Record<string, FileVersion> = {};
    for (const item of plan) if (item.target.kind !== "unprotected") previous[item.file] = item.current;
    if (!plan.length) return previous;
    const result = await applyRestore(plan, store, capturer, { queue: withFileMutationQueue });
    const message = describeRestore(result);
    if (message.error) throw new Error(`Failed to restore the code:\n${message.error}`);
    if (message.warning) ctx.ui.notify(message.warning, "warning");
    return previous;
  }

  async function settle(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.isIdle()) return;
    ctx.abort();
    await ctx.waitForIdle();
  }

  async function execute(ctx: ExtensionCommandContext, choice: RewindChoice): Promise<void> {
    await settle(ctx);
    const fromLeafId = ctx.sessionManager.getLeafId();
    const record = (mode: RestoreMode, checkpointId: string, previous: Record<string, FileVersion>) =>
      append({ v: 1, kind: "rewind", id: randomUUID(), at: Date.now(), checkpointId, mode, fromLeafId, previous });
    const checkpoint = history.byUserEntry.get(choice.entryId);
    switch (choice.action) {
      case "code":
      case "both": {
        if (!checkpoint) throw new Error("Failed to restore the code:\nThis message has no code checkpoint.");
        const previous = await restoreCode(ctx, history.targetsFor(checkpoint));
        if (choice.action === "both") {
          const leafBefore = ctx.sessionManager.getLeafId();
          try {
            await navigate(ctx, choice.entryId);
          } catch (error) {
            // Hội thoại không đổi thì trả code về như trước, không để rewind nửa vời.
            if (ctx.sessionManager.getLeafId() === leafBefore) {
              await restoreCode(ctx, new Map(Object.entries(previous)));
              throw error;
            }
            record(choice.action, checkpoint.id, previous);
            throw error;
          }
        }
        record(choice.action, checkpoint.id, previous);
        if (choice.action === "code") {
          const count = Object.keys(previous).length;
          ctx.ui.notify(count ? `Restored the code in ${describeFiles(Object.keys(previous))}.` : "The code has not changed (nothing was restored).", "info");
        }
        return;
      }
      case "conversation":
        await navigate(ctx, choice.entryId);
        record("conversation", checkpoint?.id ?? "", {});
        return;
      case "summarize": {
        const result = await ctx.navigateTree(choice.entryId, { summarize: true, customInstructions: choice.instructions });
        if (result.cancelled) throw new Error("Failed to summarize:\nSummarization was cancelled.");
        return;
      }
      case "summarize_up_to":
        await summarizeUpTo(ctx, choice.entryId, choice.instructions);
        return;
    }
  }

  async function navigate(ctx: ExtensionCommandContext, entryId: string): Promise<void> {
    const result = await ctx.navigateTree(entryId, { summarize: false });
    if (result.cancelled) throw new Error("Failed to restore the conversation:\nNavigation was cancelled.");
  }

  /** Nén phần hội thoại trước prompt đã chọn; prompt đó và phần sau giữ nguyên. */
  async function summarizeUpTo(ctx: ExtensionCommandContext, entryId: string, instructions?: string): Promise<void> {
    const model = ctx.model;
    if (!model) throw new Error("Failed to summarize:\nNo model available for summarization.");
    const manager = ctx.sessionManager as unknown as {
      getEntries(): never[]; getEntry(id: string): { parentId?: string | null } | undefined; getLeafId(): string | null;
      appendCompaction(summary: string, firstKeptEntryId: string | null, tokensBefore: number, details?: unknown, fromHook?: boolean, usage?: unknown): string;
      branch(id: string): void;
    };
    const target = manager.getEntry(entryId);
    if (!target) throw new Error("Failed to summarize:\nMessage not found.");
    const entries = manager.getEntries();
    const prefix = buildSessionContext(entries, target.parentId ?? null).messages;
    if (!prefix.some((message) => message.role === "user" || message.role === "assistant")) {
      throw new Error("Failed to summarize:\nThere is nothing before this message to summarize.");
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`Failed to summarize:\n${auth.error}`);
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    // Đi qua model registry như lời gọi lồng của Pi (provider OAuth/tùy biến, header phiên).
    const streamFn = ((streamModel: typeof model, context: never, options: never) =>
      ctx.modelRegistry.streamSimple(streamModel, context, options)) as never;
    const { text, usage } = await generateSummaryWithUsage(
      prefix, requestModel, 16384, auth.apiKey, auth.headers, undefined, instructions, undefined, ctx.thinkingLevel, streamFn, auth.env,
    );
    const leaf = manager.getLeafId();
    const tokensBefore = buildSessionContext(entries, leaf).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    const compactionId = manager.appendCompaction(text, entryId, tokensBefore, { source: ENTRY_TYPE, readFiles: [], modifiedFiles: [] }, true, usage);
    // Điều hướng tới entry compaction để Pi dựng lại context model và vẽ lại transcript.
    if (leaf) manager.branch(leaf);
    const result = await ctx.navigateTree(compactionId, { summarize: false });
    if (result.cancelled) throw new Error("Failed to summarize:\nNavigation was cancelled.");
  }

  // ---------------------------------------------------------------- lệnh

  const deps: DialogDeps = {
    truncate: (text, width) => truncateToWidth(text, width),
    width: (text) => visibleWidth(text),
    wrap: (text, width) => wrapTextWithAnsi(text, width),
    is: (data, key) => matchesKey(data, key as never),
  };

  async function openRewind(ctx: ExtensionCommandContext): Promise<void> {
    if (!config.enabled) {
      ctx.ui.notify("Rewind đang tắt (settings rewind.enabled=false hoặc PI_REWIND_DISABLE=1).", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/rewind cần giao diện tương tác.", "error");
      return;
    }
    const rows = buildRows(ctx);
    const canSummarize = !!ctx.model;
    const tracked = bashTracked.get(ctx.cwd) ?? (await watcher.topLevel(ctx.cwd)) !== null;
    if (ctx.mode === "tui") {
      let restoredPrompt: string | undefined;
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new RewindDialog({
        rows, canSummarize, bashTracked: tracked,
        terminalRows: () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24,
        rowStats, restoreStats,
        execute: async (choice) => {
          await execute(ctx, choice);
          if (choice.action === "both" || choice.action === "conversation" || choice.action === "summarize") {
            restoredPrompt = promptText(ctx, choice.entryId);
          }
        },
        done: () => done(undefined),
        requestRender: () => tui.requestRender(),
      }, theme, deps));
      // Đóng dialog, Pi trả lại nội dung editor lúc mở (rỗng) và ghi đè prompt mà
      // navigateTree vừa đặt; đặt lại prompt như Claude Code để sửa và gửi lại.
      if (restoredPrompt && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(restoredPrompt);
      return;
    }
    await rewindWithDialogs(ctx, rows, canSummarize);
  }

  /** RPC: dùng select/input chuẩn thay cho component TUI. */
  async function rewindWithDialogs(ctx: ExtensionCommandContext, rows: RewindRow[], canSummarize: boolean): Promise<void> {
    if (!rows.length) {
      ctx.ui.notify("Nothing to rewind to yet.", "info");
      return;
    }
    const labels = rows.map((row, index) => `${index + 1}. ${oneLine(row.text).slice(0, 120)}${row.checkpointed ? "" : " (no code restore)"}`);
    const picked = await ctx.ui.select("Rewind: restore the code and/or conversation to the point before…", labels);
    const row = picked ? rows[labels.indexOf(picked)] : undefined;
    if (!row) return;
    const stats = await restoreStats(row);
    const options = stats?.filesChanged.length
      ? ["Restore code and conversation", "Restore conversation", "Restore code"]
      : ["Restore conversation"];
    if (canSummarize) options.push("Summarize from here", "Summarize up to here");
    options.push("Never mind");
    const option = await ctx.ui.select("Confirm you want to restore to the point before you sent this message", options);
    const action = ({
      "Restore code and conversation": "both", "Restore conversation": "conversation", "Restore code": "code",
      "Summarize from here": "summarize", "Summarize up to here": "summarize_up_to",
    } as const)[option as "Restore code"];
    if (!action) return;
    const instructions = action === "summarize" || action === "summarize_up_to"
      ? (await ctx.ui.input("Add context (optional)", "add context (optional)"))?.trim() || undefined
      : undefined;
    try {
      await execute(ctx, { action, entryId: row.entryId, instructions });
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  const description = "Rewind the conversation and/or code to a previous point, or summarize from a selected message";
  pi.registerCommand("rewind", { description, handler: async (_args, ctx) => openRewind(ctx) });
  pi.registerCommand("checkpoint", { description: "Alias for /rewind", handler: async (_args, ctx) => openRewind(ctx) });
  pi.registerCommand("undo", { description: "Alias for /rewind", handler: async (_args, ctx) => openRewind(ctx) });

  pi.registerCommand("redo", {
    description: "Undo the last /rewind: bring back the code and conversation from before it",
    handler: async (_args, ctx) => {
      const record = history.lastUndoneRewind();
      if (!record) {
        ctx.ui.notify("Nothing to redo.", "info");
        return;
      }
      const plan = planRestore(record.previous, capturer);
      const stats = planStats(plan, store);
      const leaf = ctx.sessionManager.getLeafId();
      const parts: string[] = [];
      const conversation = record.mode !== "code" && !!record.fromLeafId && record.fromLeafId !== leaf;
      if (conversation) parts.push("return to the conversation from before the rewind");
      if (stats.filesChanged.length) parts.push(`restore the code +${stats.insertions} -${stats.deletions} in ${describeFiles(stats.filesChanged)}`);
      if (!parts.length) {
        append({ v: 1, kind: "redo", rewindId: record.id, at: Date.now() });
        ctx.ui.notify("Nothing to redo: the code and conversation already match.", "info");
        return;
      }
      if (ctx.hasUI && !(await ctx.ui.confirm("Redo", `This will ${parts.join(" and ")}.`))) return;
      await settle(ctx);
      try {
        if (stats.filesChanged.length) await restoreCode(ctx, record.previous);
        if (conversation && record.fromLeafId) {
          const result = await ctx.navigateTree(record.fromLeafId, { summarize: false });
          if (result.cancelled) throw new Error("Navigation was cancelled.");
        }
        append({ v: 1, kind: "redo", rewindId: record.id, at: Date.now() });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
