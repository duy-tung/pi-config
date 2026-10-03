import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, getPackageDir, parseFrontmatter, type ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { classifyWithFallback, type ClassifierResult, type Complete, type ScreenOutcome } from "./lib/classifier.ts";
import { JEV_MODEL, loadConfig, MODES, nextMode, parseMode, type PermissionMode, readState, saveClassifier, writeState } from "./lib/config.ts";
import { evaluate, JEV_PRICE_PER_MTOK, JEV_TUNING, type JevAccess, JevError, resolveAccess } from "./lib/jev.ts";
import { parsePermissionsArgs, permissionsCompletions } from "./lib/command.ts";
import { answerOf, MANUAL_CHOICES, type ManualAnswer, manualApproval, manualTitle } from "./lib/manual.ts";
import * as text from "./lib/messages.ts";
import { type CallFacts, decide, describeCall, filterDeniedGrep, type PolicyContext, SAFE_TOOLS, type ToolCall } from "./lib/policy.ts";
import { resolveToolPath, temporaryRoots } from "./lib/paths.ts";
import { judgeProbe, PROBE_QUESTIONS, PROBE_WARNING, probeChunks, probeState, shouldProbe } from "./lib/probe.ts";
import { buildSystemPrompt, DEFAULT_ALLOW, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, DEFAULT_SOFT_DENY, resolveSlots } from "./lib/prompt.ts";
import { buildRuleSet, isPathRule } from "./lib/rules.ts";
import {
  describeVerdict, executedScripts, judgeScreen, localPackageFacts, packageScripts, type ScreenAction, type ScreenEnvironment,
  screenable, screenQuestions, screenState, type ScreenVerdict,
} from "./lib/screen.ts";
import { analyzeShell, type ShellAnalysis } from "./lib/shell.ts";
import { callKey, LIMITS, PermissionState } from "./lib/state.ts";
import { agentIsUngated, isChild, linkChild, registerRoot, rootFor, type RootHandle, unlinkChild, unregisterRoot } from "./lib/subagents.ts";
import { buildTranscript, ENTRY_TYPE, humanMessages, type SessionEntryLike, textOf } from "./lib/transcript.ts";

const WIDGET = "pi-auto-mode";
/** Dòng mode dưới ô nhập (và tiêu đề /permissions). */
const MODE_LABELS: Record<PermissionMode, string> = {
  manual: "⏸ manual mode on", auto: "⏵⏵ auto mode on", bypass: "⏵⏵ bypass permissions on",
};
const MODE_COLORS = { manual: "accent", auto: "warning", bypass: "error" } as const;
const DESTRUCTIVE_GIT = /\b(?:rm|rmdir|rimraf|git\s+(?:reset|checkout|restore|clean|stash|push|commit|add|rebase|branch\s+-[dD]))\b|\s-delete\b/u;

function ownDirectory(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

function run(command: string, args: string[], cwd: string, timeout = 2_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout, maxBuffer: 256 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

export default function piAutoMode(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let config = loadConfig(agentDir);
  if (!config.enabled) return;
  const selfDir = ownDirectory();
  let state = new PermissionState();

  let mode: PermissionMode = "auto";
  let sessionId = "";
  let child = false;
  let contextFiles: { path: string; content: string }[] = [];
  let facts: string[] = [];
  let systemPrompt: { key: string; text: string } | undefined;
  let warnedModel = false;
  /** Model phân loại không dùng được (hết quota...) → dùng model của phiên tới hết phiên (như Claude Code). */
  let demoted = false;
  let pendingRelayed: string[] = [];
  const ownMessages = new Set<string>();
  /** Remote git lúc mở phiên ("origin git@github.com:org/repo.git"), cho state của Jev. */
  let remotes: string[] = [];

  // Jev (System One của TypeSafe): giai đoạn 1 và probe prompt injection, khi có API key; undefined khi tắt.
  let jevAccess: JevAccess | undefined;
  /** Lý do tắt Jev tới hết phiên (key bị từ chối, API trả lỗi hoặc dữ liệu lạ). */
  let jevOff: string | undefined;
  let jevWarned = false;
  /** Lỗi tạm thời liên tiếp của Jev. */
  let jevStreak = 0;
  let jevStats = { calls: 0, inputTokens: 0, flagged: 0, cleared: 0, failures: 0, probes: 0, injections: 0 };
  /** Tool có kết quả trông như prompt injection kể từ tin nhắn gần nhất của người dùng. */
  let injectionSuspect: string | undefined;
  let lastScreen: ScreenVerdict | undefined;

  pi.registerFlag("permission-mode", {
    type: "string", description: "Permission mode at startup: manual, auto or bypass (Claude Code's default and bypassPermissions also work)",
  });
  pi.registerFlag("dangerously-skip-permissions", { type: "boolean", description: "Start in bypass permissions mode (no permission checks)" });

  const currentMode = (): PermissionMode => (child ? rootFor(sessionId)?.mode() ?? "auto" : mode);

  const notify = (ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info") => {
    if (ctx?.hasUI) ctx.ui.notify(message, type);
  };

  // Một widget duy nhất đọc mode khi vẽ, để dòng mode giữ nguyên vị trí ngay dưới ô nhập.
  let widgetTui: { requestRender?: () => void } | undefined;

  function installWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || child) return;
    ctx.ui.setWidget(WIDGET, (tui, theme) => {
      widgetTui = tui as { requestRender?: () => void };
      return {
        render: () => [`${theme.fg(MODE_COLORS[mode], MODE_LABELS[mode])}${theme.fg("dim", " (shift+tab to cycle)")}`],
        invalidate() {},
      };
    }, { placement: "belowEditor" });
  }

  function setMode(next: PermissionMode): void {
    mode = next;
    widgetTui?.requestRender?.();
    log({ event: "mode", mode: next });
  }

  /** Bypass bị tắt bởi settings hoặc vì chạy bằng root (như Claude Code); trả lý do. */
  function bypassBlocked(): string | undefined {
    if (config.disableBypass) return "Bypass permissions mode is disabled by settings";
    if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1") return "Bypass permissions mode cannot be used with root/sudo privileges";
    return undefined;
  }

  /** Điều kiện vào bypass (như Claude Code): không bị tắt, không chạy bằng root, đã đồng ý cảnh báo. decline: nhãn nút từ chối. */
  async function canEnterBypass(ctx: ExtensionContext, startup: boolean, decline: string): Promise<boolean> {
    const blocked = bypassBlocked();
    if (blocked) {
      notify(ctx, blocked, "warning");
      return false;
    }
    const persisted = readState(config.stateDir);
    if (persisted.bypassAccepted) return true;
    if (!ctx.hasUI) return startup;
    const choice = await ctx.ui.select(text.BYPASS_WARNING, [decline, "Yes, I accept"]);
    if (choice !== "Yes, I accept") return false;
    writeState(config.stateDir, { ...readState(config.stateDir), bypassAccepted: true });
    return true;
  }

  /** Đổi sang mode được chọn (vào bypass phải qua canEnterBypass); trả true khi đã đổi. */
  async function switchMode(ctx: ExtensionContext, next: PermissionMode): Promise<boolean> {
    if (child || next === mode) return false;
    if (next === "bypass" && !await canEnterBypass(ctx, false, `No, keep ${mode} mode`)) return false;
    setMode(next);
    return true;
  }

  /** Shift+Tab: manual → auto → bypass → manual. Bypass bị tắt thì bỏ qua; từ chối cảnh báo thì sang manual. */
  async function cycle(ctx: ExtensionContext): Promise<void> {
    if (child) return;
    const next = nextMode(mode);
    if (next !== "bypass") {
      setMode(next);
      return;
    }
    if (bypassBlocked()) {
      setMode("manual");
      return;
    }
    setMode(await canEnterBypass(ctx, false, "No, switch to manual mode") ? "bypass" : "manual");
  }

  function log(entry: Record<string, unknown>): void {
    if (!config.log) return;
    try {
      fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(config.stateDir, "decisions.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), session: sessionId, ...entry })}\n`, { mode: 0o600 });
    } catch {
      /* nhật ký là tùy chọn */
    }
  }

  // ---------------------------------------------------------------------------
  // Chính sách
  // ---------------------------------------------------------------------------

  /** Luật permission; manual dùng cả luật allow chạy code tùy ý (như mode default của Claude Code), auto bỏ chúng. */
  function rules() {
    const set = buildRuleSet(config.allow, config.ask, config.deny);
    return currentMode() === "manual" ? { ...set, allow: [...set.allow, ...set.stripped] } : set;
  }

  function selfPaths(): string[] {
    return [
      path.join(agentDir, "settings.json"), path.join(agentDir, "keybindings.json"), path.join(agentDir, "extensions"),
      // Server MCP stdio trong mcp.json là lệnh chạy ở lần mở phiên sau.
      path.join(agentDir, "mcp.json"),
      config.stateDir, ...(selfDir ? [selfDir] : []),
    ];
  }

  function roots(cwd: string): string[] {
    const extra = config.additionalDirectories.map((dir) => resolveToolPath(dir, cwd)).filter((dir): dir is string => !!dir);
    return [...new Set([path.resolve(cwd), ...extra, ...temporaryRoots()])];
  }

  /** Nơi đọc không cần bộ phân loại: workspace, skill đã cấu hình, tài liệu Pi, agent dir. */
  function readRoots(cwd: string): string[] {
    const docs: string[] = [];
    try {
      docs.push(getPackageDir());
    } catch {
      /* không xác định được thư mục package */
    }
    return [...roots(cwd), ...config.skills.map((dir) => resolveToolPath(dir, agentDir)).filter((dir): dir is string => !!dir), ...docs, agentDir];
  }

  function policyContext(ctx: ExtensionContext): PolicyContext {
    return {
      mode: currentMode(), cwd: ctx.cwd, roots: roots(ctx.cwd), readRoots: readRoots(ctx.cwd), rules: rules(), selfPaths: selfPaths(),
      agentIsUngated: (input) => agentIsUngated(input, { cwd: ctx.cwd, agentDir, parse: (source) => parseFrontmatter(source).frontmatter }),
      tempRoots: temporaryRoots(), gitGuard: config.gitGuard,
    };
  }

  // ---------------------------------------------------------------------------
  // Hỏi người dùng (luật ask, rm vào đường dẫn quan trọng khi bypass, chạm giới hạn chặn)
  // ---------------------------------------------------------------------------

  /** Hỏi người dùng (child hỏi qua UI của phiên gốc); undefined khi không ai trả lời được. */
  function chooser(ctx: ExtensionContext): ((title: string, options: string[]) => Promise<string | undefined>) | undefined {
    if (child) {
      const root = rootFor(sessionId);
      return root?.ask ? (title, options) => root.ask!(title, options) : undefined;
    }
    return ctx.hasUI ? (title, options) => ctx.ui.select(title, options) : undefined;
  }

  async function askUser(ctx: ExtensionContext, title: string): Promise<boolean | undefined> {
    const choose = chooser(ctx);
    if (!choose) return undefined;
    return (await choose(title, [MANUAL_CHOICES.once, MANUAL_CHOICES.deny])) === MANUAL_CHOICES.once;
  }

  /** Lời gọi được cho phép tới hết phiên (manual): child dùng chung tập của phiên gốc. */
  function sessionApprovals(): Set<string> {
    return (child ? rootFor(sessionId)?.sessionApprovals() : undefined) ?? state.sessionApprovals;
  }

  // ---------------------------------------------------------------------------
  // Bộ phân loại
  // ---------------------------------------------------------------------------

  function resolveModel(ctx: ExtensionContext, spec: string | undefined) {
    if (spec) {
      const slash = spec.indexOf("/");
      const found = slash > 0 ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
      if (found && ctx.modelRegistry.hasConfiguredAuth(found)) return found;
      if (!warnedModel) {
        warnedModel = true;
        notify(ctx, `Auto mode classifier model ${spec} is unavailable; using the session model instead.`, "warning");
      }
    }
    return ctx.model;
  }

  async function loadFacts(cwd: string): Promise<void> {
    const lines = [`Working directory: ${cwd}`, `Platform: ${process.platform}`];
    const top = (await run("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
    let found: string[] = [];
    if (top) {
      found = [...new Set((await run("git", ["remote", "-v"], cwd)).split("\n").map((line) => line.replace(/\s+\((?:fetch|push)\)$/u, "").trim()).filter(Boolean))];
      const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      lines.push(`Trusted repository: ${top}${branch ? ` (branch ${branch} at session start)` : ""}`);
      lines.push(found.length ? `Trusted remotes (at session start): ${found.join("; ")}` : "The trusted repository has no remotes.");
    } else {
      lines.push("The working directory is not a git repository, so there is no trusted repository or remote.");
    }
    facts = lines;
    remotes = found.map((line) => line.replace(/\s+/gu, " "));
    systemPrompt = undefined;
  }

  function promptText(): string {
    const slots = resolveSlots(config, facts);
    const key = JSON.stringify(slots);
    if (systemPrompt?.key !== key) systemPrompt = { key, text: buildSystemPrompt(slots) };
    return systemPrompt.text;
  }

  function instructionsBlock(): string | undefined {
    if (!contextFiles.length) return undefined;
    let budget = 8_000;
    const parts: string[] = [];
    for (const file of contextFiles) {
      if (budget <= 0) break;
      const content = file.content.length > budget ? `${file.content.slice(0, budget)}\n…[truncated]` : file.content;
      budget -= content.length;
      parts.push(`## ${file.path}\n${content}`);
    }
    return `<user_instructions>\n${parts.join("\n\n")}\n</user_instructions>`;
  }

  /** Hai giai đoạn dùng cùng model để giai đoạn 2 dùng lại cache của giai đoạn 1. */
  function makeComplete(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>, cacheKey: string): Complete {
    return async (request, options) => {
      const content = [...request.blocks, request.suffix].map((value) => ({ type: "text" as const, text: value }));
      const stream = ctx.modelRegistry.streamSimple(model, {
        systemPrompt: request.systemPrompt,
        messages: [{ role: "user", content, timestamp: Date.now() }],
      }, {
        maxTokens: options.maxTokens, signal: options.signal, sessionId: cacheKey, cacheRetention: "short",
        ...(options.reasoning && options.reasoning !== "off" ? { reasoning: options.reasoning as never } : {}),
      });
      const message = await stream.result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage || `classifier request ${message.stopReason}`);
      }
      return message.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("");
    };
  }

  // ---------------------------------------------------------------------------
  // Jev (System One): giai đoạn 1 và probe prompt injection
  // ---------------------------------------------------------------------------

  /** Có key và Jev chưa bị tắt trong phiên. */
  const jevReady = () => config.jev.enabled && jevAccess?.status === "ready" && !jevOff;

  function jevEnvironment(cwd: string): ScreenEnvironment {
    return {
      workingDirectory: cwd, homeDirectory: os.homedir(), tempDirectories: temporaryRoots(), trustedRemotes: remotes,
      trusted: config.environment.filter((item) => item !== "$defaults"),
    };
  }

  function recordUsage(inputTokens: number): void {
    jevStats.calls++;
    jevStats.inputTokens += inputTokens;
    jevStreak = 0;
  }

  /**
   * Lỗi tạm thời: lần này dùng LLM; 3 lần liên tiếp thì tắt Jev tới hết phiên (không để mỗi lệnh chờ Jev đang sập).
   * Lỗi khác (key bị từ chối, API trả lỗi hoặc dữ liệu lạ): tắt Jev tới hết phiên ngay.
   */
  function jevFailure(ctx: ExtensionContext, error: unknown, purpose: "screen" | "probe"): ScreenOutcome {
    const failure = error instanceof JevError ? error : new JevError("network", error instanceof Error ? error.message : String(error));
    if (failure.kind === "aborted") return { kind: "unavailable", reason: "the turn was interrupted", aborted: true };
    jevStats.failures++;
    log({ event: "jev-error", purpose, kind: failure.kind, status: failure.status });
    const off = !failure.transient ? failure.message : ++jevStreak >= 3 ? `${jevStreak} failures in a row, last: ${failure.message}` : undefined;
    if (off) {
      if (!jevOff) notify(ctx, `Jev is unavailable (${off}); auto mode uses its LLM classifier for the rest of this session.`, "warning");
      jevOff = off;
    } else if (purpose === "screen" && !jevWarned) {
      jevWarned = true;
      notify(ctx, `Jev did not answer (${failure.message}); the LLM classifier checked this action instead.`, "warning");
    }
    return { kind: "unavailable", reason: failure.message };
  }

  async function runScreen(ctx: ExtensionContext, call: ToolCall, notes: string[], analysis: ShellAnalysis | undefined): Promise<ScreenOutcome> {
    const access = jevAccess;
    if (access?.status !== "ready") return { kind: "unavailable", reason: access?.status === "unavailable" ? access.message : "no Jev API key" };
    const command = typeof call.input.command === "string" ? call.input.command : "";
    // Lớp chính sách đã phân tích lệnh của bash/bg_run; powershell và tool khác có `command` thì phân tích ở đây.
    const commands = !command ? [] : analysis && call.toolName !== "powershell" ? analysis.commands : analyzeShell(command).commands;
    const action: ScreenAction = {
      toolName: call.toolName, input: call.input, notes: [...notes, ...localPackageFacts(commands, ctx.cwd)],
      scripts: executedScripts(commands, ctx.cwd, roots(ctx.cwd)),
      packageScripts: packageScripts(commands, ctx.cwd),
    };
    try {
      const result = await evaluate(access, { model: config.jev.model, state: screenState(action, jevEnvironment(ctx.cwd)), questions: screenQuestions() },
        { signal: ctx.signal, timeoutMs: JEV_TUNING.timeoutMs });
      recordUsage(result.inputTokens);
      const verdict = judgeScreen(result.answers);
      lastScreen = verdict;
      if (verdict.flagged) jevStats.flagged++;
      else jevStats.cleared++;
      log({
        event: "screen", tool: call.toolName, model: result.model, ms: result.ms, flagged: verdict.flagged,
        hazards: verdict.hazards.map((item) => `${item.id}:${item.p.toFixed(2)}`), riskTail: Number(verdict.riskTail.toFixed(3)),
      });
      return { kind: verdict.flagged ? "flag" : "clear" };
    } catch (error) {
      return jevFailure(ctx, error, "screen");
    }
  }

  /**
   * Giai đoạn 1 bằng Jev cho hành động thuộc phạm vi của Jev. Lớp chính sách đã thấy rủi ro (xoá vào đường dẫn
   * quan trọng, ghi file được bảo vệ) hoặc vừa đọc nội dung nghi prompt injection (tới tin nhắn tiếp theo của
   * người dùng) thì coi như bị gắn cờ: thẳng tới giai đoạn 2.
   */
  function makeScreen(
    ctx: ExtensionContext, call: ToolCall, notes: string[], escalate: boolean, analysis: ShellAnalysis | undefined,
  ): (() => Promise<ScreenOutcome>) | undefined {
    if (!jevReady() || !screenable(call.toolName)) return undefined;
    if (escalate || injectionSuspect) return async () => ({ kind: "flag" });
    let memo: Promise<ScreenOutcome> | undefined;
    return () => (memo ??= runScreen(ctx, call, notes, analysis));
  }

  function jevLabel(): string {
    if (!config.jev.enabled) return "off (autoMode.jev is false)";
    if (jevOff) return `off for this session (${jevOff})`;
    if (jevAccess?.status === "unavailable") return `unavailable (${jevAccess.message})`;
    if (jevAccess?.status !== "ready") return "no API key — set TYPESAFE_API_KEY";
    return `${config.jev.model} (key from TYPESAFE_API_KEY)`;
  }

  function jevUsage(): string {
    const cost = config.jev.model === JEV_MODEL ? ` ≈ $${(jevStats.inputTokens * JEV_PRICE_PER_MTOK / 1e6).toFixed(4)}` : "";
    return `${jevStats.calls} calls, ${jevStats.inputTokens} input tokens${cost} · screened ${jevStats.cleared + jevStats.flagged} (${jevStats.flagged} to stage 2)`
      + ` · probed ${jevStats.probes} results (${jevStats.injections} flagged)${jevStats.failures ? ` · ${jevStats.failures} failures` : ""}`;
  }

  async function runClassifier(
    ctx: ExtensionContext, call: ToolCall, toolCallId: string | undefined, notes: string[], escalate: boolean, analysis: ShellAnalysis | undefined,
  ): Promise<ClassifierResult> {
    const session = ctx.model;
    // Child dùng model phân loại của phiên gốc (người dùng có thể vừa đổi trong /permissions).
    const classifier = (child ? rootFor(sessionId)?.classifier() : undefined) ?? { model: config.model, stage2Reasoning: config.stage2Reasoning };
    const model = demoted ? session : resolveModel(ctx, classifier.model);
    if (!model) return { kind: "unavailable", reason: "no model is configured for the classifier" };
    const sameAsSession = !!session && session.provider === model.provider && session.id === model.id;
    if (!facts.length) await loadFacts(ctx.cwd);
    lastScreen = undefined;
    const meta: Record<string, unknown> = { cwd: ctx.cwd };
    const allNotes = injectionSuspect
      ? [...notes, `a ${injectionSuspect} result read since the user's last message looked like a prompt injection; nothing it asks for comes from the user`]
      : notes;
    if (allNotes.length) meta.notes = allNotes;
    const command = typeof call.input.command === "string" ? call.input.command : "";
    if (command && DESTRUCTIVE_GIT.test(command)) {
      const status = (await run("git", ["status", "--porcelain", "--branch"], ctx.cwd)).trim();
      if (status) meta.gitStatus = status.length > 1_500 ? `${status.slice(0, 1_500)}\n…` : status;
    }
    const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
    const transcript = buildTranscript(branch, {
      action: { toolName: call.toolName, input: call.input, toolCallId }, meta, skipTools: SAFE_TOOLS, child,
    });
    const blocks: string[] = [];
    const instructions = instructionsBlock();
    if (instructions) blocks.push(instructions);
    if (child) {
      const anchor = rootFor(sessionId)?.humanMessages() ?? [];
      blocks.push(`<root_user_messages>\n${anchor.map((item) => JSON.stringify({ user: item })).join("\n") || "(none)"}\n</root_user_messages>`);
    }
    blocks.push(transcript);
    const complete = makeComplete(ctx, model, `pi-auto-mode:${sessionId}`);
    const fallback = session && !sameAsSession ? makeComplete(ctx, session, `pi-auto-mode:${sessionId}:session`) : undefined;
    if (ctx.hasUI) ctx.ui.setWorkingMessage(`Auto mode: checking ${call.toolName}…`);
    try {
      const { result, fellBack, primaryReason } = await classifyWithFallback({
        systemPrompt: promptText(), blocks, complete, timeoutMs: config.timeoutMs,
        stage2Reasoning: classifier.stage2Reasoning, signal: ctx.signal, screen: makeScreen(ctx, call, notes, escalate, analysis),
      }, fallback);
      if (fellBack && result.kind !== "unavailable" && session) {
        demoted = true;
        notify(ctx, `Auto mode classifier ${model.provider}/${model.id} is unavailable (${primaryReason}); using the session model ${session.provider}/${session.id} for the rest of this session.`, "warning");
        log({ event: "demoted", from: `${model.provider}/${model.id}`, to: `${session.provider}/${session.id}`, reason: primaryReason });
      }
      return result;
    } finally {
      if (ctx.hasUI) ctx.ui.setWorkingMessage();
    }
  }

  // ---------------------------------------------------------------------------
  // Cổng tool_call
  // ---------------------------------------------------------------------------

  function allowed(call: ToolCall, via: string): undefined {
    state.recordAllowed();
    log({ event: "allow", tool: call.toolName, via });
    return undefined;
  }

  async function gate(ctx: ExtensionContext, call: ToolCall, toolCallId?: string): Promise<{ block: true; reason: string } | undefined> {
    const pc = policyContext(ctx);
    const facts: CallFacts = describeCall(call, pc);
    const decision = decide(call, pc, facts);
    const key = callKey(call.toolName, call.input);
    if (decision.kind === "allow") {
      return allowed(call, decision.via);
    }
    if (decision.kind === "deny") {
      state.recordDenied({ toolName: call.toolName, summary: facts.summary, reason: decision.reason, rule: decision.rule, key }, false);
      notify(ctx, `${call.toolName} denied by rule ${decision.rule ?? ""}`.trim(), "warning");
      log({ event: "deny", tool: call.toolName, rule: decision.rule });
      return { block: true, reason: decision.message ?? text.ruleDenial(decision.reason) };
    }
    if (decision.kind === "ask") {
      const approved = await askUser(ctx, `Allow ${call.toolName}: ${facts.summary}?\n\n${decision.reason}`);
      log({ event: "ask", tool: call.toolName, approved });
      if (approved) return allowed(call, "user");
      return { block: true, reason: approved === false ? text.USER_DENIED : text.NO_APPROVER };
    }
    // Duyệt một lần từ /permissions: bỏ qua bộ phân loại, luật deny vẫn đã áp dụng ở trên.
    if (state.consumeApproval(key)) {
      return allowed(call, "user approval");
    }
    // Manual: hỏi người dùng thay cho bộ phân loại (không gọi model nào).
    if (currentMode() === "manual") {
      const choose = chooser(ctx);
      const options = [MANUAL_CHOICES.once, MANUAL_CHOICES.session, MANUAL_CHOICES.deny];
      const result = await manualApproval({
        key, title: manualTitle(call.toolName, facts.summary, decision.notes), approvals: sessionApprovals(),
        ask: choose ? async (title): Promise<ManualAnswer> => answerOf(await choose(title, options)) : undefined,
      });
      log({ event: "manual", tool: call.toolName, result: result.kind === "allow" ? result.via : result.declined ? "declined" : "no approver" });
      if (result.kind === "allow") return allowed(call, result.via);
      if (result.declined) state.recordDenied({ toolName: call.toolName, summary: facts.summary, reason: "Declined by you", key }, false);
      return { block: true, reason: result.reason };
    }
    const result = await runClassifier(ctx, call, toolCallId, decision.notes, !!decision.escalate, facts.analysis);
    if (result.kind === "allow") return allowed(call, result.screen === "jev" ? "jev" : `classifier stage ${result.stage}`);
    if (result.kind === "unavailable") {
      log({ event: "unavailable", tool: call.toolName, reason: result.reason });
      if (result.aborted) return { block: true, reason: "Operation aborted" };
      notify(ctx, `Auto mode could not check ${call.toolName}: ${result.reason}`, "warning");
      return { block: true, reason: text.unavailable(result.reason) };
    }
    const label = result.rule ? `[${result.rule}] ${result.reason}` : result.reason;
    const limit = state.recordDenied({ toolName: call.toolName, summary: facts.summary, reason: result.reason, rule: result.rule, key }, !result.fallback);
    log({ event: "block", tool: call.toolName, rule: result.rule, stage: result.stage, reason: result.reason });
    notify(ctx, `${call.toolName} denied by auto mode · ${label.length > 80 ? `${label.slice(0, 79)}…` : label} · /permissions`, "warning");
    if (limit) {
      const count = limit === "total" ? LIMITS.total : LIMITS.consecutive;
      const approved = await askUser(ctx, `${text.limitReason(limit, count, label)}\n\nAllow ${call.toolName}: ${facts.summary}?`);
      state.resetLimit(limit);
      if (approved) {
        return allowed(call, "user after denial limit");
      }
    }
    return { block: true, reason: text.classifierDenial(result.rule, result.reason) };
  }

  pi.on("tool_call", async (event, ctx) => {
    // Pi 0.99: lời gọi lồng (codemode, ctx.executeTool) cũng phát tool_call, có parentToolCallId và id "<cha>/<n>" không
    // có trong transcript; mỗi lời gọi được duyệt riêng như lời gọi của model.
    if (event.parentToolCallId) log({ event: "nested", tool: event.toolName, parent: event.parentToolCallId });
    return gate(ctx, { toolName: event.toolName, input: event.input as Record<string, unknown> }, event.toolCallId);
  });

  // Luật deny đường dẫn: tool grep của Pi được tìm cả thư mục, dòng thuộc file bị deny bị bỏ khỏi kết quả (cả auto và bypass).
  type ToolResultContent = NonNullable<ToolResultEventResult["content"]>[number];
  function denyFilteredContent(event: { toolName: string; input: unknown; content: ToolResultContent[] }, ctx: ExtensionContext): ToolResultContent[] {
    if (event.toolName !== "grep") return event.content;
    const pc = policyContext(ctx);
    if (!pc.rules.deny.some((rule) => !rule.negate && isPathRule(rule))) return event.content;
    const input = event.input as Record<string, unknown>;
    const searchPath = resolveToolPath(input.path, ctx.cwd, pc.home ?? os.homedir()) ?? ctx.cwd;
    let removed = 0;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const filtered = filterDeniedGrep(part.text, searchPath, pc);
      removed += filtered.removed;
      return { ...part, text: filtered.text };
    });
    if (!removed) return event.content;
    log({ event: "filter", tool: "grep", removed });
    return [...content, { type: "text" as const, text: `[pi-auto-mode] ${removed} line(s) from files denied by path rules were left out.` }];
  }

  // Lớp đầu vào: kết quả mang nội dung bên ngoài trông như lệnh cho AI thì kèm cảnh báo cho agent (không chặn).
  pi.on("tool_result", async (event, ctx) => {
    const content = denyFilteredContent(event, ctx);
    const changed = content !== event.content ? { content } : undefined;
    if (currentMode() !== "auto" || !jevReady()) return changed;
    if (!shouldProbe(event.toolName, event.input as Record<string, unknown>)) return changed;
    const body = textOf(content);
    if (body.trim().length < 100) return changed;
    const access = jevAccess;
    if (access?.status !== "ready") return changed;
    const chunks = probeChunks(body);
    const started = Date.now();
    try {
      // Mỗi đoạn một request, gửi song song; một request lỗi thì bỏ qua lần quét này (probe chỉ cảnh báo).
      const results = await Promise.all(chunks.map((chunk) => evaluate(access, { model: config.jev.model, state: probeState(event.toolName, chunk), questions: PROBE_QUESTIONS },
        { signal: ctx.signal, timeoutMs: JEV_TUNING.timeoutMs })));
      for (const result of results) recordUsage(result.inputTokens);
      jevStats.probes++;
      const verdict = judgeProbe(results.map((result) => result.answers));
      log({
        event: "probe", tool: event.toolName, ms: Date.now() - started, flagged: verdict.flagged, chunks: chunks.length,
        directed: Number(verdict.directed.toFixed(3)), hijack: Number(verdict.hijack.toFixed(3)),
      });
      if (!verdict.flagged) return changed;
      jevStats.injections++;
      injectionSuspect = event.toolName;
      notify(ctx, `Auto mode: the ${event.toolName} result may contain a prompt injection; Pi was told to treat it as data.`, "warning");
      return { content: [...content, { type: "text" as const, text: PROBE_WARNING }] };
    } catch (error) {
      jevFailure(ctx, error, "probe");
      return changed;
    }
  });

  // ---------------------------------------------------------------------------
  // Nguồn gốc tin nhắn: extension gửi thay người dùng thì không phải ý định của người dùng
  // ---------------------------------------------------------------------------

  pi.on("input", (event) => {
    if (event.source !== "extension") {
      // Người dùng lên tiếng: ý định mới, bỏ cờ prompt injection của lượt trước.
      injectionSuspect = undefined;
      return;
    }
    if (ownMessages.delete(event.text)) return;
    pendingRelayed.push(event.text);
    if (pendingRelayed.length > 20) pendingRelayed = pendingRelayed.slice(-20);
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown; timestamp?: number };
    if (message.role !== "user" || !pendingRelayed.length) return;
    const body = textOf(message.content).trim();
    const index = pendingRelayed.findIndex((item) => {
      const sent = item.trim();
      return sent === body || (sent.length > 20 && (body.startsWith(sent) || sent.startsWith(body)));
    });
    if (index < 0) return;
    pendingRelayed.splice(index, 1);
    if (typeof message.timestamp === "number") pi.appendEntry(ENTRY_TYPE, { kind: "relayed", timestamp: message.timestamp });
  });

  // ---------------------------------------------------------------------------
  // Vòng đời phiên, subagent, system prompt
  // ---------------------------------------------------------------------------

  pi.events.on("subagents:child:session-created", (payload: unknown) => {
    const identity = payload as { sessionId?: string; parentSessionId?: string };
    if (identity?.sessionId) linkChild(identity.sessionId, identity.parentSessionId);
  });
  pi.events.on("subagents:child:disposed", (payload: unknown) => {
    const identity = payload as { sessionId?: string };
    if (identity?.sessionId) unlinkChild(identity.sessionId);
  });

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions as { contextFiles?: { path: string; content: string }[]; sections?: Record<string, string> };
    contextFiles = options.contextFiles ?? [];
    options.sections ??= {};
    options.sections.permission_mode = text.modeInstructions(currentMode());
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(agentDir);
    sessionId = ctx.sessionManager.getSessionId();
    child = isChild(sessionId);
    state = new PermissionState();
    pendingRelayed = [];
    demoted = false;
    facts = [];
    remotes = [];
    systemPrompt = undefined;
    jevOff = undefined;
    jevWarned = false;
    jevStreak = 0;
    jevStats ={ calls: 0, inputTokens: 0, flagged: 0, cleared: 0, failures: 0, probes: 0, injections: 0 };
    injectionSuspect = undefined;
    lastScreen = undefined;
    jevAccess = config.jev.enabled ? resolveAccess(process.env) : undefined;
    void loadFacts(ctx.cwd);
    if (child) return;
    const handle: RootHandle = {
      sessionId,
      mode: () => mode,
      humanMessages: () => humanMessages(ctx.sessionManager.getBranch() as SessionEntryLike[]),
      ask: ctx.hasUI ? (title: string, options: string[]) => ctx.ui.select(`[subagent] ${title}`, options) : undefined,
      sessionApprovals: () => state.sessionApprovals,
      classifier: () => ({ model: config.model, stage2Reasoning: config.stage2Reasoning }),
    };
    registerRoot(handle);
    // Không bao giờ khôi phục bypass từ phiên cũ; chỉ cờ dòng lệnh hoặc settings người dùng.
    const flagBypass = pi.getFlag("dangerously-skip-permissions") === true;
    const wanted = flagBypass ? "bypass" : parseMode(pi.getFlag("permission-mode")) ?? config.defaultMode;
    setMode(wanted === "manual" ? "manual" : "auto");
    installWidget(ctx);
    if (wanted === "bypass") {
      void canEnterBypass(ctx, true, "No, stay in auto mode").then((ok) => {
        if (ok) setMode("bypass");
      });
    } else if (wanted === "auto" && ctx.hasUI && ctx.mode === "tui") {
      const persisted = readState(config.stateDir);
      if (!persisted.autoNoticeShown) {
        notify(ctx, text.AUTO_NOTICE, "info");
        writeState(config.stateDir, { ...persisted, autoNoticeShown: true });
      }
    }
    // Một lần cho mỗi bản cài: chưa có key Jev (hoặc không đọc được) thì giai đoạn 1 vẫn là LLM.
    if (ctx.hasUI && ctx.mode === "tui" && jevAccess && jevAccess.status !== "ready") {
      const persisted = readState(config.stateDir);
      if (!persisted.jevNoticeShown) {
        notify(ctx, jevAccess.status === "missing" ? text.JEV_NOTICE : `${text.JEV_NOTICE}\n\nNow: ${jevAccess.message}`, "info");
        writeState(config.stateDir, { ...persisted, jevNoticeShown: true });
      }
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!child) {
      unregisterRoot(sessionId);
      if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
      widgetTui = undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // Phím tắt và lệnh
  // ---------------------------------------------------------------------------

  // Shift+Tab như Claude Code; bộ cài chuyển mức thinking của Pi sang Alt+T. Nếu keybindings.json vẫn gán
  // Shift+Tab cho thinking, Pi bỏ phím này của extension (kèm chẩn đoán) và mode đổi bằng /permissions.
  pi.registerShortcut("shift+tab" as never, { description: "Switch permission mode (manual → auto → bypass)", handler: (ctx) => cycle(ctx) });

  function modelLabel(): string {
    const llm = `${config.model ?? "session model"} · ${config.stage2Reasoning}`;
    return jevReady() ? `Jev ${config.jev.model} → ${llm}` : llm;
  }

  /** Trạng thái của cổng (mode, bộ phân loại, Jev, số lần chặn, luật): tiêu đề menu Classifier và /permissions không UI. */
  function statusLines(): string[] {
    const set = rules();
    return [
      `Mode: ${currentMode()}${child ? " (inherited from the parent session)" : ""}`,
      `Classifier (auto mode): ${modelLabel()} · timeout ${Math.round(config.timeoutMs / 1000)}s${demoted ? " · using the session model for this session" : ""}`,
      `Jev (System One): ${jevLabel()}${jevStats.calls || jevStats.failures ? `\n  ${jevUsage()}` : ""}`,
      ...(injectionSuspect ? [`Possible prompt injection in a ${injectionSuspect} result since your last message: actions go straight to careful review`] : []),
      `Denials: ${state.consecutive} in a row, ${state.total} this session (limits ${LIMITS.consecutive}/${LIMITS.total})`,
      `Rules: ${set.allow.length} allow, ${set.ask.length} ask, ${set.deny.length} deny${set.stripped.length && currentMode() !== "manual" ? `, ${set.stripped.length} ignored in auto mode` : ""}`,
    ];
  }

  /** Chạy thử quyết định cho một lệnh bash; chỉ auto mode gọi bộ phân loại (có thể tốn token). */
  async function testCommand(ctx: ExtensionContext, command: string): Promise<void> {
    const call = { toolName: "bash", input: { command } };
    const pc = policyContext(ctx);
    const facts = describeCall(call, pc);
    const decision = decide(call, pc, facts);
    if (decision.kind !== "classify") {
      notify(ctx, `Decision without classifier: ${decision.kind}${"via" in decision ? ` (${decision.via})` : ""}${"reason" in decision ? ` — ${decision.reason}` : ""}`, "info");
      return;
    }
    const notes = decision.notes.length ? ` Note: ${decision.notes.join("; ")}.` : "";
    if (currentMode() !== "auto") {
      notify(ctx, `${currentMode() === "manual" ? "Manual mode: Pi would ask you before running this" : "Bypass mode: this runs without a check"} (no classifier call).${notes}`, "info");
      return;
    }
    notify(ctx, "Asking the classifier…", "info");
    const result = await runClassifier(ctx, call, undefined, decision.notes, !!decision.escalate, facts.analysis);
    const summary = result.kind === "allow" ? `allow (${result.screen === "jev" ? "Jev" : `stage ${result.stage}`})`
      : result.kind === "block" ? `block (stage ${result.stage}) — ${result.rule ? `[${result.rule}] ` : ""}${result.reason}`
        : `unavailable — ${result.reason}`;
    const screened = lastScreen ? `Jev: ${describeVerdict(lastScreen)}\n` : "";
    notify(ctx, `${screened}Classifier: ${summary}`, result.kind === "allow" ? "info" : "warning");
  }

  /** Chọn model phân loại trong các model đã đăng nhập, rồi mức suy luận; lưu vào settings.json và áp ngay. */
  async function changeClassifier(ctx: ExtensionContext): Promise<void> {
    const ref = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
    const models = ctx.modelRegistry.getAvailable().sort((a, b) => ref(a).localeCompare(ref(b)));
    if (!models.length) {
      ctx.ui.notify("No logged-in model is available for the classifier; use /login first.", "warning");
      return;
    }
    const current = (value: string, active: boolean) => (active ? `${value} (current)` : value);
    const labels = models.map((model) => current(ref(model), ref(model) === config.model));
    const picked = await ctx.ui.select("Classifier model (auto mode stage 2, and stage 1 without Jev)", labels);
    const model = picked ? models[labels.indexOf(picked)] : undefined;
    if (!model) return;
    const supported = getSupportedThinkingLevels(model) as string[];
    const levels = supported.length ? supported : ["off"];
    const levelLabels = levels.map((level) => current(level, level === config.stage2Reasoning));
    const chosen = await ctx.ui.select(`Classifier thinking (${ref(model)})`, levelLabels);
    const level = chosen ? levels[levelLabels.indexOf(chosen)] : undefined;
    if (!level) return;
    try {
      saveClassifier(config.source, ref(model), level);
    } catch (error) {
      ctx.ui.notify(`Could not save the classifier model to ${config.source}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    // Áp ngay cho phiên này (và child, qua registry); model mới được thử lại dù model cũ đã bị thay bằng model của phiên.
    config = { ...config, model: ref(model), stage2Reasoning: level };
    demoted = false;
    warnedModel = false;
    log({ event: "classifier", model: ref(model), reasoning: level });
    ctx.ui.notify(`Classifier: ${ref(model)} · ${level} (saved to ${config.source})`, "info");
  }

  async function showRules(ctx: ExtensionContext): Promise<void> {
    const set = buildRuleSet(config.allow, config.ask, config.deny);
    const choice = await ctx.ui.select("Rules", [
      `Your rules: ${set.allow.length + set.stripped.length} allow, ${set.ask.length} ask, ${set.deny.length} deny`,
      "Built-in classifier rules (auto mode defaults)",
    ]);
    if (!choice) return;
    if (choice.startsWith("Your rules")) {
      const list = (items: { raw: string }[]) => (items.length ? items.map((rule) => `  ${rule.raw}`).join("\n") : "  (none)");
      const body = [
        `Allow:\n${list(set.allow)}`, `Ask:\n${list(set.ask)}`, `Deny:\n${list(set.deny)}`,
        ...(set.stripped.length ? [`Allow rules ignored in auto mode (they would bypass the classifier; manual mode uses them):\n${list(set.stripped)}`] : []),
        `Settings: ${config.source}`,
      ].join("\n\n");
      await ctx.ui.editor("Permission rules (read-only view)", body);
      return;
    }
    const body = [
      "# Environment", ...DEFAULT_ENVIRONMENT.map((item) => `- ${item}`), "",
      "# HARD rules", ...DEFAULT_HARD_DENY.map((item) => `- ${item}`), "",
      "# SOFT rules", ...DEFAULT_SOFT_DENY.map((item) => `- ${item}`), "",
      "# ALLOW exceptions", ...DEFAULT_ALLOW.map((item) => `- ${item}`), "",
      "Customize in settings.json → autoMode.environment / hard_deny / soft_deny / allow; include \"$defaults\" to keep these.",
    ].join("\n");
    await ctx.ui.editor("Auto mode classifier rules (read-only view)", body);
  }

  async function recentlyDenied(ctx: ExtensionContext): Promise<void> {
    if (!state.recent.length) {
      ctx.ui.notify("No recent denials. Actions denied by auto mode, rules or you will appear here.", "info");
      return;
    }
    const labels = state.recent.map((record) => `${record.approved ? "✓" : "✗"} ${record.toolName} · ${record.summary} — ${record.rule ? `[${record.rule}] ` : ""}${record.reason}`);
    const picked = await ctx.ui.select("Recently denied — pick one to approve for a single retry", labels);
    const record = picked ? state.recent[labels.indexOf(picked)] : undefined;
    if (!record || record.approved) return;
    const confirm = await ctx.ui.select(`Approve ${record.toolName}: ${record.summary}?\nPi will be told it may retry this exact action once.`, ["Approve and retry", "Cancel"]);
    if (confirm !== "Approve and retry") return;
    state.approve(record.key);
    const message = text.approvalGranted(record.summary);
    ownMessages.add(message);
    pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  // Một menu cho mọi thứ của cổng permission (thay /auto-mode cũ): mode, bộ phân loại, lệnh bị chặn, luật, chạy thử.
  pi.registerCommand("permissions", {
    description: "Permission mode, classifier model, recently denied actions, rules and dry runs: /permissions [test <command>]",
    getArgumentCompletions: (prefix) => permissionsCompletions(prefix),
    handler: async (args, ctx) => {
      const parsed = parsePermissionsArgs(args);
      if (parsed.kind === "usage") {
        notify(ctx, parsed.message, "warning");
        return;
      }
      if (parsed.kind === "test") {
        await testCommand(ctx, parsed.command);
        return;
      }
      // Không có UI (print/JSON): in trạng thái như /auto-mode status cũ.
      if (!ctx.hasUI) {
        ctx.ui.notify(statusLines().join("\n"), "info");
        return;
      }
      const options = [
        `Mode: ${currentMode()} — change…`,
        `Classifier: ${modelLabel()}…`,
        `Recently denied (${state.recent.length})`,
        "Rules…",
        "Test a command…",
      ];
      const choice = await ctx.ui.select(`Permissions · ${MODE_LABELS[currentMode()]}`, options);
      if (!choice) return;
      switch (options.indexOf(choice)) {
        case 0: {
          if (child) return;
          const labels = MODES.map((item) => `${MODE_LABELS[item]}${item === currentMode() ? " (current)" : ""}`);
          const picked = await ctx.ui.select("Permission mode (Shift+Tab cycles manual → auto → bypass)", labels);
          if (picked) await switchMode(ctx, MODES[labels.indexOf(picked)]);
          return;
        }
        case 1: {
          const picked = await ctx.ui.select(statusLines().join("\n"), ["Change classifier model…"]);
          if (picked) await changeClassifier(ctx);
          return;
        }
        case 2:
          await recentlyDenied(ctx);
          return;
        case 3:
          await showRules(ctx);
          return;
        case 4: {
          const command = (await ctx.ui.input("Test a command (dry run of the permission decision)", "bash command"))?.trim();
          if (command) await testCommand(ctx, command);
          return;
        }
      }
    },
  });
}
