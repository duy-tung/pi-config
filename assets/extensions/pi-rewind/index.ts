import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, estimateTokens, generateSummaryWithUsage, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadConfig } from "./lib/config.ts";
import {
  type DialogDeps, describeFiles, type MenuItem, oneLine, relativeTime, type RewindChoice, RewindDialog, type RewindRow, type RowStats,
} from "./lib/dialog.ts";
import { bufferDiffCounts } from "./lib/diff.ts";
import { GitWatcher, type WatchWindow } from "./lib/gitwatch.ts";
import {
  type Checkpoint, ENTRY_TYPE, History, type RedoRecord, type RestoreMode, type RewindEntry, type RewindRecord, type SessionEntryLike,
} from "./lib/history.ts";
import { type Journal, JournalStore, planRecovery } from "./lib/journal.ts";
import { StorageLock } from "./lib/lock.ts";
import { resolveToolPath } from "./lib/paths.ts";
import { applyRestore, assertSamePlan, type DiffStats, describeRestore, type PlanItem, planRestore, planStats } from "./lib/restore.ts";
import { BlobStore, Capturer, type FileVersion } from "./lib/store.ts";

/**
 * pi-rewind: checkpoint theo prompt và /rewind (Esc Esc) như Claude Code.
 * - Trước khi agent xử lý mỗi prompt: ghi phiên bản của mọi file đã theo dõi.
 * - edit/write: lưu nội dung trước lần sửa đầu tiên trong lượt.
 * - bash/Agent (trong git worktree): so git status trước/sau để biết file bị đổi.
 * - Khôi phục code chỉ đụng tới file agent đã theo dõi; hội thoại dùng navigateTree.
 * - Nhật ký phục hồi quanh mỗi lần khôi phục; Pi thoát giữa chừng thì /rewind cho hoàn tất hoặc hoàn tác.
 * - Kế hoạch lúc ghi phải khớp màn hình xác nhận; khóa kho giữa các process Pi khi ghi code hoặc dọn kho.
 * - Menu còn có Redo (hoàn tác lần rewind gần nhất) và "Resume previous session" sau /clear hoặc /new.
 */
export default function piRewind(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const config = loadConfig(agentDir);
  const store = new BlobStore(config.storageDir);
  const capturer = new Capturer(store, { maxBytes: config.maxFileBytes });
  const journals = new JournalStore(config.storageDir);
  const lock = new StorageLock(config.storageDir);
  let notifyContext: ExtensionContext | undefined;
  const watcher = new GitWatcher(capturer, {
    slowMs: config.watchSlowMs,
    maxDirty: config.watchMaxDirty,
    maxBytes: config.watchMaxBytes,
    onDisable: (top, reason) => notifyContext?.ui.notify(`Rewind: ngừng theo dõi thay đổi bằng bash trong ${top} (${reason}).`, "warning"),
  });

  type Draft = { id: string; at: number; timestamp?: number; source?: string };
  let history = new History();
  let current: Checkpoint | undefined;
  let pending: (Draft & { delta: Record<string, FileVersion> }) | undefined;
  /** Checkpoint của prompt không lưu được (đĩa đầy, kho không ghi được): thử lại ở mỗi tool call, chặn edit/write tới khi lưu được. */
  let snapshotFailure: { draft: Draft; reason: string } | undefined;
  let storageWarned = false;
  let awaitingPrompt = false;
  let lastInputSource: string | undefined;
  let promptDepth = 0;
  let unsubscribeInput: (() => void) | undefined;
  /** Phiên vừa rời bằng /clear hoặc /new: menu cho quay lại. */
  let previousSession: string | undefined;
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

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /** Báo người dùng một lần mỗi prompt khi kho rewind không ghi được. */
  function warnStorage(ctx: ExtensionContext, reason: string): void {
    if (storageWarned) return;
    storageWarned = true;
    ctx.ui.notify(`Rewind: không lưu được điểm khôi phục (${reason}). Edit/write bị chặn để file vẫn khôi phục được; giải phóng dung lượng hoặc kiểm quyền ghi ${config.storageDir}, hoặc tắt rewind (rewind.enabled: false).`, "warning");
  }

  /** Chụp phiên bản mọi file đã theo dõi cho checkpoint của prompt; kho lỗi thì ghi nhận để chặn sửa file. */
  function snapshot(draft: Draft, ctx: ExtensionContext): void {
    try {
      pending = { ...draft, delta: history.delta((file) => capturer.capture(file)) };
      snapshotFailure = undefined;
    } catch (error) {
      pending = undefined;
      snapshotFailure = { draft, reason: errorText(error) };
      warnStorage(ctx, snapshotFailure.reason);
    }
  }

  /** Tool sửa file không chạy khi chưa lưu được bản trước đó: sửa rồi thì không rewind về được. */
  const blocked = (reason: string) => ({
    block: true as const,
    reason: `Rewind could not save a restore point before this change (${reason}), so the change was blocked to keep the files restorable. Do not change the files another way (bash, scripts or other tools); tell the user. They can free disk space or fix write access to the rewind storage, or turn rewind off (rewind.enabled: false in settings.json).`,
  });

  pi.on("session_start", (event, ctx) => {
    history = History.fromEntries(ctx.sessionManager.getEntries() as SessionEntryLike[]);
    current = history.checkpoints.at(-1);
    pending = undefined;
    awaitingPrompt = false;
    notifyContext = ctx;
    previousSession = event.reason === "new" ? event.previousSessionFile : undefined;
    scheduleGc();
    if (!config.enabled) return;
    installDoubleEscape(ctx);
    const interrupted = journals.interrupted();
    if (interrupted.length && ctx.hasUI) {
      const files = interrupted.flatMap((journal) => Object.keys(journal.files));
      ctx.ui.notify(`Rewind: Pi exited while restoring the code in ${describeFiles(files)}. Open /rewind to finish or undo that restore.`, "warning");
    }
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
    pi.on("message_end", (event, ctx) => {
      if (!awaitingPrompt || event.message.role !== "user") return;
      awaitingPrompt = false;
      storageWarned = false;
      const draft: Draft = {
        id: randomUUID(), at: Date.now(),
        timestamp: typeof event.message.timestamp === "number" ? event.message.timestamp : undefined,
        source: lastInputSource,
      };
      lastInputSource = undefined;
      snapshot(draft, ctx);
    });

    pi.on("message_start", (event, ctx) => {
      if (pending && event.message.role === "assistant") persistPending(ctx);
    });

    pi.on("tool_call", async (event, ctx) => {
      // Kho vừa ghi lại được (người dùng giải phóng dung lượng): tạo checkpoint còn thiếu của prompt.
      if (snapshotFailure) snapshot(snapshotFailure.draft, ctx);
      if (pending) persistPending(ctx);
      const edits = event.toolName === "edit" || event.toolName === "write";
      if (edits && snapshotFailure) return blocked(snapshotFailure.reason);
      if (!current) return;
      if (edits) {
        const file = resolveToolPath((event.input as { path?: unknown }).path, ctx.cwd);
        if (!file) return;
        try {
          touch(file, event.toolName, () => capturer.capture(file));
        } catch (error) {
          warnStorage(ctx, errorText(error));
          return blocked(errorText(error));
        }
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

    // Tool bị cổng permission chặn không có tool_result: bỏ cửa sổ theo dõi (lệnh không chạy).
    pi.on("tool_execution_end", (event) => {
      windows.delete(event.toolCallId);
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
        // Process Pi khác đang khôi phục code hoặc đang dọn: để lần sau.
        const release = lock.tryAcquire();
        if (!release) return;
        try {
          fs.writeFileSync(marker, new Date().toISOString());
          const maxAge = config.retentionDays * 24 * 3600 * 1000;
          journals.gc(maxAge);
          // Blob mà nhật ký phục hồi còn lại cần thì giữ (hoàn tất hoặc hoàn tác lần khôi phục bị gián đoạn).
          store.gc(maxAge, Date.now(), { maxBytes: config.maxStorageBytes, keep: journals.referenced() });
        } finally {
          release();
        }
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

  /** Kế hoạch khôi phục code về checkpoint của prompt: màn hình xác nhận hiện thống kê của nó, lúc ghi phải khớp. */
  async function restorePreview(row: RewindRow): Promise<{ plan: PlanItem[]; stats: RowStats } | undefined> {
    const checkpoint = history.byUserEntry.get(row.entryId);
    if (!checkpoint) return undefined;
    await idle();
    const plan = planRestore(history.targetsFor(checkpoint), capturer);
    return { plan, stats: planStats(plan, store) };
  }

  // ---------------------------------------------------------------- hành động

  async function restoreCode(ctx: ExtensionCommandContext, targets: Map<string, FileVersion>): Promise<Record<string, FileVersion>> {
    return applyPlan(ctx, planRestore(targets, capturer));
  }

  /** Ghi kế hoạch. Trả về bản trước khi khôi phục của các file đã đổi (kể cả ghi dở) để Redo đưa về. */
  async function applyPlan(ctx: ExtensionCommandContext, plan: PlanItem[]): Promise<Record<string, FileVersion>> {
    if (!plan.length) return {};
    const result = await applyRestore(plan, store, capturer, { queue: withFileMutationQueue });
    const message = describeRestore(result);
    if (message.error) throw new Error(`Failed to restore the code:\n${message.error}`);
    if (message.warning) {
      const partial = result.failed.some((item) => item.partial);
      ctx.ui.notify(partial ? `${message.warning}\n/rewind → Redo (or Undo redo) puts back what these files had before.` : message.warning, "warning");
    }
    // File bị bỏ qua (vd. đổi trong lúc khôi phục) hoặc chưa ghi được thì vẫn như cũ: Redo không đụng tới.
    const changed = new Set([...result.restored, ...result.deleted, ...result.failed.filter((item) => item.partial).map((item) => item.file)]);
    return Object.fromEntries(plan.filter((item) => changed.has(item.file)).map((item) => [item.file, item.current]));
  }

  /** Điều hướng hội thoại sau khi đã ghi code. Lỗi mà hội thoại chưa đổi thì trả code về như trước; đã đổi thì vẫn ghi lại. */
  async function navigateAfterRestore(
    ctx: ExtensionCommandContext, entryId: string, previous: Record<string, FileVersion>, record: () => void, failure: string,
  ): Promise<void> {
    const leafBefore = ctx.sessionManager.getLeafId();
    try {
      const result = await ctx.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error(`${failure}\nNavigation was cancelled.`);
    } catch (error) {
      if (ctx.sessionManager.getLeafId() === leafBefore) await restoreCode(ctx, new Map(Object.entries(previous)));
      else record();
      throw error;
    }
  }

  /** Ghi code khi giữ khóa kho: process Pi khác dùng chung storageDir không ghi code hoặc dọn kho cùng lúc. */
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const release = await lock.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Chạy một lần khôi phục trong nhật ký phục hồi; nhật ký chỉ còn lại khi Pi thoát giữa chừng. */
  async function journaled<T>(ctx: ExtensionContext, plan: PlanItem[], checkpointId: string | undefined, work: () => Promise<T>): Promise<T> {
    const id = plan.length ? journals.begin({ sessionFile: ctx.sessionManager.getSessionFile(), checkpointId }, plan) : undefined;
    try {
      return await work();
    } finally {
      if (id) journals.end(id);
    }
  }

  async function settle(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.isIdle()) return;
    ctx.abort();
    await ctx.waitForIdle();
  }

  /** shown: kế hoạch đã hiện ở màn hình xác nhận; code chỉ được ghi khi kế hoạch lập lại khớp với nó. */
  async function execute(ctx: ExtensionCommandContext, choice: RewindChoice, shown: PlanItem[] = []): Promise<void> {
    await settle(ctx);
    const fromLeafId = ctx.sessionManager.getLeafId();
    const record = (mode: RestoreMode, checkpointId: string, previous: Record<string, FileVersion>) =>
      append({ v: 1, kind: "rewind", id: randomUUID(), at: Date.now(), checkpointId, mode, fromLeafId, previous });
    const checkpoint = history.byUserEntry.get(choice.entryId);
    switch (choice.action) {
      case "code":
      case "both": {
        if (!checkpoint) throw new Error("Failed to restore the code:\nThis message has no code checkpoint.");
        await locked(async () => {
          const plan = planRestore(history.targetsFor(checkpoint), capturer);
          assertSamePlan(shown, plan);
          await journaled(ctx, plan, checkpoint.id, async () => {
            const previous = await applyPlan(ctx, plan);
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
          });
        });
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

  // ---------------------------------------------------------------- Redo, phiên trước, phục hồi

  interface RedoPlan {
    record: RewindRecord;
    /** Kế hoạch ghi code đằng sau parts (đã cho người dùng xem); lúc ghi phải khớp. */
    plan: PlanItem[];
    stats: DiffStats;
    conversation: boolean;
    /** Việc Redo sẽ làm; rỗng nghĩa là code và hội thoại đã khớp. */
    parts: string[];
  }

  function redoPlan(ctx: ExtensionContext): RedoPlan | undefined {
    const record = history.lastUndoneRewind();
    if (!record) return undefined;
    const plan = planRestore(record.previous, capturer);
    const stats = planStats(plan, store);
    const conversation = record.mode !== "code" && !!record.fromLeafId && record.fromLeafId !== ctx.sessionManager.getLeafId();
    const parts: string[] = [];
    if (conversation) parts.push("return to the conversation from before the rewind");
    if (stats.filesChanged.length) parts.push(`restore the code +${stats.insertions} -${stats.deletions} in ${describeFiles(stats.filesChanged)}`);
    return { record, plan, stats, conversation, parts };
  }

  /** Hoàn tác lần rewind gần nhất: đưa code về ngay trước lần rewind và quay lại nhánh hội thoại cũ. */
  async function redo(ctx: ExtensionCommandContext, info: RedoPlan): Promise<void> {
    await settle(ctx);
    await locked(async () => {
      const plan = planRestore(info.record.previous, capturer);
      assertSamePlan(info.plan, plan);
      const fromLeafId = ctx.sessionManager.getLeafId();
      await journaled(ctx, plan, undefined, async () => {
        const previous = info.stats.filesChanged.length ? await applyPlan(ctx, plan) : {};
        // Lưu trạng thái ngay trước Redo (việc làm sau lần rewind) để "Undo redo" lấy lại được.
        const record = () => append({ v: 1, kind: "redo", id: randomUUID(), rewindId: info.record.id, at: Date.now(), previous, fromLeafId });
        if (info.conversation && info.record.fromLeafId) await navigateAfterRestore(ctx, info.record.fromLeafId, previous, record, "Failed to redo:");
        record();
      });
    });
  }

  interface UndoRedoPlan {
    redo: RedoRecord;
    plan: PlanItem[];
    stats: DiffStats;
    conversation: boolean;
    parts: string[];
  }

  function undoRedoPlan(ctx: ExtensionContext): UndoRedoPlan | undefined {
    const redo = history.lastRedo();
    if (!redo) return undefined;
    const plan = planRestore(redo.previous, capturer);
    const stats = planStats(plan, store);
    const conversation = redo.mode !== "code" && !!redo.fromLeafId && redo.fromLeafId !== ctx.sessionManager.getLeafId();
    const parts: string[] = [];
    if (conversation) parts.push("return to the conversation from before the redo");
    if (stats.filesChanged.length) parts.push(`restore the code +${stats.insertions} -${stats.deletions} in ${describeFiles(stats.filesChanged)}`);
    return { redo, plan, stats, conversation, parts };
  }

  /** Hoàn tác lần Redo gần nhất. Ghi lại như một lần rewind nên Redo đưa về lại được, không mất việc làm sau Redo. */
  async function undoRedo(ctx: ExtensionCommandContext, info: UndoRedoPlan): Promise<void> {
    await settle(ctx);
    await locked(async () => {
      const plan = planRestore(info.redo.previous, capturer);
      assertSamePlan(info.plan, plan);
      const fromLeafId = ctx.sessionManager.getLeafId();
      await journaled(ctx, plan, undefined, async () => {
        const previous = info.stats.filesChanged.length ? await applyPlan(ctx, plan) : {};
        const record = () => append({
          v: 1, kind: "rewind", id: randomUUID(), at: Date.now(), checkpointId: info.redo.checkpointId, mode: info.redo.mode,
          fromLeafId, previous, undoes: info.redo.id,
        });
        if (info.conversation && info.redo.fromLeafId) await navigateAfterRestore(ctx, info.redo.fromLeafId, previous, record, "Failed to undo the redo:");
        record();
      });
    });
  }

  /** Tên hoặc prompt đầu tiên của một file phiên (đọc tối đa 1 MiB đầu). */
  function sessionTitle(file: string): string {
    let text = "";
    try {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return path.basename(file);
    }
    let name: string | undefined;
    let prompt: string | undefined;
    for (const line of text.split("\n")) {
      try {
        const entry = JSON.parse(line) as SessionEntryLike & { name?: unknown };
        if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
        if (!prompt && entry.type === "message" && entry.message?.role === "user") prompt = textOf(entry.message.content);
      } catch {
        /* dòng cuối bị cắt */
      }
    }
    return oneLine(name?.trim() || prompt || path.basename(file));
  }

  /** Mục ngoài danh sách prompt, cùng kế hoạch đằng sau chúng như đã hiện trong menu. */
  interface Menu {
    items: MenuItem[];
    interrupted: Journal[];
    redo?: RedoPlan;
    undoRedo?: UndoRedoPlan;
  }

  function buildMenu(ctx: ExtensionContext): Menu {
    const items: MenuItem[] = [];
    const now = Date.now();
    const interrupted = journals.interrupted();
    for (const journal of interrupted) {
      const files = describeFiles(Object.keys(journal.files));
      items.push({
        key: `recover:${journal.id}`, position: "top", warning: true,
        label: "⚠ Interrupted code restore", detail: `${files} · ${relativeTime(journal.at, now)}`,
        title: "Confirm you want to recover the interrupted code restore",
        lines: [
          `Pi exited while restoring the code in ${files} (${relativeTime(journal.at, now)}), so some files may be restored and others not.`,
          "Files changed another way since then are left untouched.",
        ],
        options: [
          { value: "finish", label: "Finish the restore" },
          { value: "undo", label: "Undo it (back to before the restore)" },
          { value: "dismiss", label: "Dismiss (leave the files as they are)" },
        ],
      });
    }
    if (previousSession && fs.existsSync(previousSession)) {
      const title = sessionTitle(previousSession);
      let modified: number | undefined;
      try {
        modified = fs.statSync(previousSession).mtimeMs;
      } catch {
        /* vừa bị xóa */
      }
      items.push({
        key: "resume", position: "top", label: "Resume previous session",
        detail: modified === undefined ? title : `${title} · ${relativeTime(modified, now)}`,
        title: "Confirm you want to resume the previous session",
        lines: [title, "This session stays available in /resume."],
        options: [{ value: "resume", label: "Resume previous session" }],
      });
    }
    const redoInfo = redoPlan(ctx);
    if (redoInfo?.parts.length) {
      const what = redoInfo.parts.join(" and ");
      items.push({
        key: "redo", position: "bottom", label: "Redo", detail: `Undo the last rewind: ${what}`,
        title: "Confirm you want to redo", lines: [`This will ${what}.`], options: [{ value: "redo", label: "Redo" }],
      });
    }
    const undoInfo = undoRedoPlan(ctx);
    if (undoInfo?.parts.length) {
      const what = undoInfo.parts.join(" and ");
      items.push({
        key: "undo-redo", position: "bottom", label: "Undo redo", detail: `Go back to before the last redo: ${what}`,
        title: "Confirm you want to undo the redo", lines: [`This will ${what}.`], options: [{ value: "undo-redo", label: "Undo redo" }],
      });
    }
    return { items, interrupted, redo: redoInfo, undoRedo: undoInfo };
  }

  /** Hoàn tất hoặc hoàn tác lần khôi phục bị gián đoạn; file đã đổi theo cách khác được để nguyên. */
  async function recover(ctx: ExtensionCommandContext, shown: Journal, action: string): Promise<void> {
    if (action !== "dismiss") await settle(ctx);
    await locked(async () => {
      // Process Pi khác có thể đã hoàn tất hoặc bỏ qua lần khôi phục này trong lúc menu mở.
      const journal = journals.read(shown.id);
      if (!journal) {
        ctx.ui.notify("Another Pi process already handled this interrupted restore.", "info");
        return;
      }
      if (action === "dismiss") {
        journals.end(journal.id);
        return;
      }
      const direction = action === "undo" ? "undo" : "finish";
      const { plan, changed } = planRecovery(journal, direction, capturer);
      if (plan.length) {
        const message = describeRestore(await applyRestore(plan, store, capturer, { queue: withFileMutationQueue }));
        if (message.error) throw new Error(`Failed to recover the restore:\n${message.error}`);
        if (message.warning) ctx.ui.notify(message.warning, "warning");
      }
      // Hoàn tất ngay trong phiên đã rewind: ghi lại như một lần rewind code để Redo đưa code về như trước.
      if (direction === "finish" && journal.checkpointId && history.byId.has(journal.checkpointId) && journal.sessionFile === ctx.sessionManager.getSessionFile()) {
        const previous = Object.fromEntries(Object.entries(journal.files).filter(([file]) => !changed.includes(file)).map(([file, item]) => [file, item.before]));
        append({ v: 1, kind: "rewind", id: randomUUID(), at: Date.now(), checkpointId: journal.checkpointId, mode: "code", fromLeafId: ctx.sessionManager.getLeafId(), previous });
      }
      journals.end(journal.id);
      const done = direction === "finish" ? "Finished the interrupted restore" : "Undid the interrupted restore";
      if (changed.length) ctx.ui.notify(`${done}, but left ${describeFiles(changed)} untouched: changed since the restore was interrupted.`, "warning");
      else ctx.ui.notify(`${done}.`, "info");
    });
  }

  /** Mục menu đã chọn, theo kế hoạch đã hiện. Trả về phiên cần chuyển tới sau khi đóng menu (switchSession thay context). */
  async function runItem(ctx: ExtensionCommandContext, menu: Menu, key: string, value: string): Promise<string | undefined> {
    if (key === "resume") return previousSession;
    if (key === "redo") {
      if (menu.redo?.parts.length) await redo(ctx, menu.redo);
      return undefined;
    }
    if (key === "undo-redo") {
      if (menu.undoRedo?.parts.length) await undoRedo(ctx, menu.undoRedo);
      return undefined;
    }
    const journal = menu.interrupted.find((item) => `recover:${item.id}` === key);
    if (journal) await recover(ctx, journal, value);
    return undefined;
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
    const menu = buildMenu(ctx);
    const canSummarize = !!ctx.model;
    const tracked = bashTracked.get(ctx.cwd) ?? (await watcher.topLevel(ctx.cwd)) !== null;
    let switchTo: string | undefined;
    if (ctx.mode === "tui") {
      let restoredPrompt: string | undefined;
      // Kế hoạch đã hiện ở màn hình xác nhận của từng prompt: execute so lại trước khi ghi.
      const previews = new Map<string, PlanItem[]>();
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new RewindDialog({
        rows, items: menu.items, canSummarize, bashTracked: tracked,
        terminalRows: () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24,
        rowStats,
        restoreStats: async (row) => {
          const preview = await restorePreview(row);
          if (preview) previews.set(row.entryId, preview.plan);
          return preview?.stats;
        },
        execute: async (choice) => {
          await execute(ctx, choice, previews.get(choice.entryId));
          if (choice.action === "both" || choice.action === "conversation" || choice.action === "summarize") {
            restoredPrompt = promptText(ctx, choice.entryId);
          }
        },
        runItem: async (key, value) => {
          switchTo = await runItem(ctx, menu, key, value);
        },
        done: () => done(undefined),
        requestRender: () => tui.requestRender(),
      }, theme, deps));
      // Đóng dialog, Pi trả lại nội dung editor lúc mở (rỗng) và ghi đè prompt mà
      // navigateTree vừa đặt; đặt lại prompt như Claude Code để sửa và gửi lại.
      if (restoredPrompt && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(restoredPrompt);
    } else {
      switchTo = await rewindWithDialogs(ctx, rows, menu, canSummarize);
    }
    if (switchTo) {
      await settle(ctx);
      await ctx.switchSession(switchTo);
    }
  }

  /** RPC: dùng select/input chuẩn thay cho component TUI. */
  async function rewindWithDialogs(ctx: ExtensionCommandContext, rows: RewindRow[], menu: Menu, canSummarize: boolean): Promise<string | undefined> {
    const top = menu.items.filter((item) => item.position === "top");
    const bottom = menu.items.filter((item) => item.position === "bottom");
    if (!rows.length && !menu.items.length) {
      ctx.ui.notify("Nothing to rewind to yet.", "info");
      return undefined;
    }
    const labels = [
      ...top.map((item) => item.label),
      ...rows.map((row, index) => `${index + 1}. ${oneLine(row.text).slice(0, 120)}${row.checkpointed ? "" : " (no code restore)"}`),
      ...bottom.map((item) => item.label),
    ];
    const picked = await ctx.ui.select("Rewind: restore the code and/or conversation to the point before…", labels);
    const index = picked === undefined ? -1 : labels.indexOf(picked);
    if (index < 0) return undefined;
    const item = index < top.length ? top[index] : index >= top.length + rows.length ? bottom[index - top.length - rows.length] : undefined;
    if (item) {
      const option = await ctx.ui.select(`${item.title}: ${item.lines.join(" ")}`, [...item.options.map((entry) => entry.label), "Never mind"]);
      const value = item.options.find((entry) => entry.label === option)?.value;
      if (!value) return undefined;
      try {
        return await runItem(ctx, menu, item.key, value);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return undefined;
      }
    }
    const row = rows[index - top.length];
    const preview = await restorePreview(row);
    const options = preview?.stats.filesChanged.length
      ? ["Restore code and conversation", "Restore conversation", "Restore code"]
      : ["Restore conversation"];
    if (canSummarize) options.push("Summarize from here", "Summarize up to here");
    options.push("Never mind");
    const option = await ctx.ui.select("Confirm you want to restore to the point before you sent this message", options);
    const action = ({
      "Restore code and conversation": "both", "Restore conversation": "conversation", "Restore code": "code",
      "Summarize from here": "summarize", "Summarize up to here": "summarize_up_to",
    } as const)[option as "Restore code"];
    if (!action) return undefined;
    const instructions = action === "summarize" || action === "summarize_up_to"
      ? (await ctx.ui.input("Add context (optional)", "add context (optional)"))?.trim() || undefined
      : undefined;
    try {
      await execute(ctx, { action, entryId: row.entryId, instructions }, preview?.plan);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return undefined;
  }

  const description = "Rewind the conversation and/or code to a previous point, or summarize from a selected message";
  pi.registerCommand("rewind", { description, handler: async (_args, ctx) => openRewind(ctx) });
  pi.registerCommand("checkpoint", { description: "Alias for /rewind", handler: async (_args, ctx) => openRewind(ctx) });
  pi.registerCommand("undo", { description: "Alias for /rewind", handler: async (_args, ctx) => openRewind(ctx) });

  pi.registerCommand("redo", {
    description: "Undo the last /rewind: bring back the code and conversation from before it (also in the /rewind menu)",
    handler: async (_args, ctx) => {
      const info = redoPlan(ctx);
      if (!info) {
        ctx.ui.notify("Nothing to redo.", "info");
        return;
      }
      if (!info.parts.length) {
        append({ v: 1, kind: "redo", rewindId: info.record.id, at: Date.now() });
        ctx.ui.notify("Nothing to redo: the code and conversation already match.", "info");
        return;
      }
      if (ctx.hasUI && !(await ctx.ui.confirm("Redo", `This will ${info.parts.join(" and ")}.`))) return;
      try {
        await redo(ctx, info);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  // Như /clear của Claude Code: phiên mới; /rewind của phiên mới có mục "Resume previous session".
  pi.registerCommand("clear", {
    description: "Start a new session (like /new); /rewind there can resume this one",
    handler: async (_args, ctx) => {
      await settle(ctx);
      await ctx.newSession({
        withSession: async (next) => {
          if (next.hasUI && config.enabled) next.ui.notify("Started a new session. /rewind → Resume previous session goes back.", "info");
        },
      });
    },
  });
}
