import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { classifyWithFallback, type ClassifierResult, type Complete, type ScreenOutcome } from "./lib/classifier.ts";
import { loadConfig, parseMode, type PermissionMode, readState, writeState } from "./lib/config.ts";
import { evaluate, JEV_DEFAULT_ENDPOINT, JEV_PRICE_PER_MTOK, type JevAccess, JevError, loadKeyStore, resolveAccess } from "./lib/jev.ts";
import * as text from "./lib/messages.ts";
import { type CallFacts, decide, describeCall, type PolicyContext, SAFE_TOOLS, type ToolCall } from "./lib/policy.ts";
import { protectedReason, resolveToolPath, temporaryRoots } from "./lib/paths.ts";
import { judgeProbe, PROBE_QUESTIONS, PROBE_WARNING, probeChunks, probeState, resultText, shouldProbe } from "./lib/probe.ts";
import { buildSystemPrompt, DEFAULT_ALLOW, DEFAULT_ENVIRONMENT, DEFAULT_HARD_DENY, DEFAULT_SOFT_DENY, resolveSlots } from "./lib/prompt.ts";
import { buildRuleSet, firstMatch } from "./lib/rules.ts";
import {
  describeVerdict, executedScripts, judgeScreen, localPackageFacts, packageScripts, type ScreenAction, type ScreenEnvironment,
  screenable, screenQuestions, screenState, type ScreenVerdict,
} from "./lib/screen.ts";
import { callKey, LIMITS, PermissionState } from "./lib/state.ts";
import { isChild, linkChild, registerRoot, rootFor, type RootHandle, unlinkChild, unregisterRoot } from "./lib/subagents.ts";
import { buildTranscript, ENTRY_TYPE, humanMessages, type SessionEntryLike } from "./lib/transcript.ts";
import { type EvalCase, formatReport, formatScreenCorpus, jevEvalScreen, runEval, runScreenCorpus, type ScreenCorpus } from "./lib/eval.ts";

const WIDGET = "pi-auto-mode";
const MCP_APPROVAL_EVENT = "pi-mcp-adapter:tool-approval-request";
const DESTRUCTIVE_GIT = /\b(?:rm|rmdir|rimraf|git\s+(?:reset|checkout|restore|clean|stash|push|commit|add|rebase|branch\s+-[dD]))\b|\s-delete\b/u;

type McpRequest = {
  serverName: string;
  originalToolName: string;
  prefixedToolName: string;
  args: Record<string, unknown>;
  origin: string;
  signal?: AbortSignal;
  claim(handler: () => Promise<string> | string): boolean;
};

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

/** Frontmatter của agent tintinweb (đủ để biết agent có tải cổng permission hay không). */
function agentFrontmatter(file: string): Record<string, string> | undefined {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(line);
    if (pair) result[pair[1]] = pair[2].trim();
  }
  return result;
}

function listField(value: string | undefined): string[] | boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true" || value === "false") return value === "true";
  return value.replace(/^\[|\]$/gu, "").split(",").map((item) => item.trim().replace(/^["']|["']$/gu, "").toLowerCase()).filter(Boolean);
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
  let latest: ExtensionContext | undefined;
  let contextFiles: { path: string; content: string }[] = [];
  let facts: string[] = [];
  let systemPrompt: { key: string; text: string } | undefined;
  let warnedModel = false;
  /** Model phân loại không dùng được (hết quota...) → dùng model của phiên tới hết phiên (như Claude Code). */
  let demoted = false;
  let pendingRelayed: string[] = [];
  const ownMessages = new Set<string>();
  const recentlyAllowed = new Map<string, number>();
  let hintKey = "shift+tab";
  /** Remote git lúc mở phiên ("origin git@github.com:org/repo.git"), cho state của Jev. */
  let remotes: string[] = [];

  // Jev (System One của TypeSafe): giai đoạn 1 và probe prompt injection, khi có API key.
  let jevAccess: Promise<JevAccess> | undefined;
  let jevResolved: JevAccess | undefined;
  /** Lý do tắt Jev tới hết phiên (key bị từ chối, endpoint sai, API trả dữ liệu lạ). */
  let jevOff: string | undefined;
  let jevWarned = false;
  /** Lỗi tạm thời liên tiếp của Jev. */
  let jevStreak = 0;
  let jevStats = { calls: 0, inputTokens: 0, flagged: 0, cleared: 0, failures: 0, probes: 0, injections: 0 };
  /** Tool có kết quả trông như prompt injection kể từ tin nhắn gần nhất của người dùng. */
  let injectionSuspect: string | undefined;
  let lastScreen: ScreenVerdict | undefined;

  pi.registerFlag("permission-mode", { type: "string", description: "Permission mode at startup: auto or bypassPermissions" });
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
        render: () => {
          const label = mode === "bypass" ? theme.fg("error", "⏵⏵ bypass permissions on") : theme.fg("warning", "⏵⏵ auto mode on");
          return [`${label}${theme.fg("dim", ` (${hintKey} to cycle)`)}`];
        },
        invalidate() {},
      };
    }, { placement: "belowEditor" });
  }

  function setMode(_ctx: ExtensionContext, next: PermissionMode): void {
    mode = next;
    widgetTui?.requestRender?.();
    log({ event: "mode", mode: next });
  }

  /** Điều kiện vào bypass (như Claude Code): không bị tắt, không chạy bằng root, đã đồng ý cảnh báo. */
  async function canEnterBypass(ctx: ExtensionContext, startup: boolean): Promise<boolean> {
    if (config.disableBypass) {
      notify(ctx, "Bypass permissions mode is disabled by settings", "warning");
      return false;
    }
    if (process.getuid?.() === 0 && process.env.IS_SANDBOX !== "1") {
      notify(ctx, "Bypass permissions mode cannot be used with root/sudo privileges", "error");
      return false;
    }
    const persisted = readState(config.stateDir);
    if (persisted.bypassAccepted) return true;
    if (!ctx.hasUI) return startup;
    const choice = await ctx.ui.select(text.BYPASS_WARNING, ["No, stay in auto mode", "Yes, I accept"]);
    if (choice !== "Yes, I accept") return false;
    writeState(config.stateDir, { ...readState(config.stateDir), bypassAccepted: true });
    return true;
  }

  async function cycle(ctx: ExtensionContext): Promise<void> {
    if (child) return;
    if (mode === "auto") {
      if (await canEnterBypass(ctx, false)) setMode(ctx, "bypass");
    } else {
      setMode(ctx, "auto");
    }
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

  function rules() {
    return buildRuleSet(config.allow, config.ask, config.deny);
  }

  function selfPaths(): string[] {
    return [
      path.join(agentDir, "settings.json"), path.join(agentDir, "keybindings.json"), path.join(agentDir, "extensions"),
      config.stateDir, ...(selfDir ? [selfDir] : []),
    ];
  }

  function roots(cwd: string): string[] {
    const extra = config.additionalDirectories.map((dir) => resolveToolPath(dir, cwd)).filter((dir): dir is string => !!dir);
    return [...new Set([path.resolve(cwd), ...extra, ...temporaryRoots()])];
  }

  /** Subagent sẽ chạy không có cổng này (isolated, extensions:false hoặc danh sách extension thiếu pi-auto-mode). */
  function agentIsUngated(cwd: string, input: Record<string, unknown>): boolean {
    const type = typeof input.subagent_type === "string" ? input.subagent_type : "";
    const file = [path.join(cwd, ".pi", "agents", `${type}.md`), path.join(agentDir, "agents", `${type}.md`)].find((item) => fs.existsSync(item));
    const front = file ? agentFrontmatter(file) : undefined;
    const isolated = front?.isolated !== undefined ? front.isolated === "true" : input.isolated === true;
    if (isolated) return true;
    const extensions = listField(front?.extensions ?? front?.inherit_extensions);
    if (extensions === false) return true;
    if (Array.isArray(extensions) && !extensions.includes("*") && !extensions.includes("pi-auto-mode")) return true;
    const excluded = listField(front?.exclude_extensions);
    return Array.isArray(excluded) && excluded.includes("pi-auto-mode");
  }

  /** Nơi đọc không cần bộ phân loại: workspace, skill đã cấu hình, tài liệu Pi, agent dir. */
  function readRoots(cwd: string): string[] {
    let skills: string[] = [];
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as { skills?: unknown };
      skills = Array.isArray(settings.skills) ? settings.skills.filter((item): item is string => typeof item === "string") : [];
    } catch {
      /* không có settings */
    }
    const docs: string[] = [];
    try {
      docs.push(getPackageDir());
    } catch {
      /* không xác định được thư mục package */
    }
    return [...roots(cwd), ...skills.map((dir) => resolveToolPath(dir, agentDir)).filter((dir): dir is string => !!dir), ...docs, agentDir];
  }

  function policyContext(ctx: ExtensionContext): PolicyContext {
    return {
      mode: currentMode(), cwd: ctx.cwd, roots: roots(ctx.cwd), readRoots: readRoots(ctx.cwd), rules: rules(), selfPaths: selfPaths(),
      agentIsUngated: (input) => agentIsUngated(ctx.cwd, input), tempRoots: temporaryRoots(),
    };
  }

  // ---------------------------------------------------------------------------
  // Hỏi người dùng (luật ask, rm vào đường dẫn quan trọng khi bypass, chạm giới hạn chặn)
  // ---------------------------------------------------------------------------

  async function askUser(ctx: ExtensionContext, title: string): Promise<boolean | undefined> {
    if (child) {
      const root = rootFor(sessionId);
      return root?.ask ? root.ask(title) : undefined;
    }
    if (!ctx.hasUI) return undefined;
    const choice = await ctx.ui.select(title, ["Allow once", "Deny"]);
    return choice === "Allow once";
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

  function makeComplete(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>, stage2: NonNullable<ExtensionContext["model"]>, cacheKey: string): Complete {
    return async (request, options) => {
      const target = options.stage === 2 ? stage2 : model;
      const content = [...request.blocks, request.suffix].map((value) => ({ type: "text" as const, text: value }));
      const stream = ctx.modelRegistry.streamSimple(target, {
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

  /** node_modules của runtime Pi, nơi có kho key của pi-mcp-adapter. */
  function runtimeModules(): string | undefined {
    try {
      return path.resolve(getPackageDir(), "..", "..");
    } catch {
      return undefined;
    }
  }

  async function resolveJev(): Promise<JevAccess> {
    const access = resolveAccess(process.env, await loadKeyStore(runtimeModules()));
    jevResolved = access;
    return access;
  }

  /** Có key (hoặc đang đọc key) và Jev chưa bị tắt trong phiên. */
  const jevReady = () => config.jev.enabled && !!jevAccess && !jevOff && (!jevResolved || jevResolved.status === "ready");

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
   * Lỗi khác (key bị từ chối, endpoint sai, dữ liệu lạ): tắt Jev tới hết phiên ngay.
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

  async function runScreen(ctx: ExtensionContext, call: ToolCall, notes: string[]): Promise<ScreenOutcome> {
    const access = await jevAccess;
    if (access?.status !== "ready") return { kind: "unavailable", reason: access?.status === "unavailable" ? access.message : "no Jev API key" };
    const command = typeof call.input.command === "string" ? call.input.command : "";
    const action: ScreenAction = {
      toolName: call.toolName, input: call.input, notes: command ? [...notes, ...localPackageFacts(command, ctx.cwd)] : notes,
      scripts: command ? executedScripts(command, ctx.cwd, roots(ctx.cwd)) : [],
      packageScripts: command ? packageScripts(command, ctx.cwd) : [],
    };
    try {
      const result = await evaluate(access, { model: config.jev.model, state: screenState(action, jevEnvironment(ctx.cwd)), questions: screenQuestions() },
        { signal: ctx.signal, timeoutMs: config.jev.timeoutMs });
      recordUsage(result.inputTokens);
      const verdict = judgeScreen(result.answers, config.jev);
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
  function makeScreen(ctx: ExtensionContext, call: ToolCall, notes: string[], escalate: boolean): (() => Promise<ScreenOutcome>) | undefined {
    if (!jevReady() || !screenable(call.toolName)) return undefined;
    if (escalate || injectionSuspect) return async () => ({ kind: "flag" });
    let memo: Promise<ScreenOutcome> | undefined;
    return () => (memo ??= runScreen(ctx, call, notes));
  }

  /** Bằng chứng rủi ro tất định: không để giai đoạn 1 tự cho qua. */
  function escalation(call: ToolCall, facts: CallFacts, pc: PolicyContext): boolean {
    return !!facts.critical || (["write", "edit"].includes(call.toolName) && facts.paths.some((file) => !!protectedReason(file, pc.roots)));
  }

  function jevLabel(): string {
    if (!config.jev.enabled) return "off (autoMode.jev is false)";
    if (jevOff) return `off for this session (${jevOff})`;
    const access = jevResolved;
    if (!access) return "starting";
    if (access.status === "missing") return "no API key — run `pi-mcp-adapter key set systemone`";
    if (access.status === "unavailable") return `unavailable (${access.message})`;
    return `${config.jev.model} (key from ${access.source}${access.endpoint.href === JEV_DEFAULT_ENDPOINT ? "" : `, ${access.endpoint.origin}`})`;
  }

  function jevUsage(): string {
    const priced = jevResolved?.status === "ready" && jevResolved.endpoint.href === JEV_DEFAULT_ENDPOINT && config.jev.model === "jev-1.13.0";
    const cost = priced ? ` ≈ $${(jevStats.inputTokens * JEV_PRICE_PER_MTOK / 1e6).toFixed(4)}` : "";
    return `${jevStats.calls} calls, ${jevStats.inputTokens} input tokens${cost} · screened ${jevStats.cleared + jevStats.flagged} (${jevStats.flagged} to stage 2)`
      + ` · probed ${jevStats.probes} results (${jevStats.injections} flagged)${jevStats.failures ? ` · ${jevStats.failures} failures` : ""}`;
  }

  async function runClassifier(ctx: ExtensionContext, call: ToolCall, toolCallId: string | undefined, notes: string[], escalate = false): Promise<ClassifierResult> {
    const session = ctx.model;
    const model = demoted ? session : resolveModel(ctx, config.model);
    if (!model) return { kind: "unavailable", reason: "no model is configured for the classifier" };
    const stage2 = !demoted && config.stage2Model ? resolveModel(ctx, config.stage2Model) ?? model : model;
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
    const complete = makeComplete(ctx, model, stage2, `pi-auto-mode:${sessionId}`);
    const fallback = session && !sameAsSession ? makeComplete(ctx, session, session, `pi-auto-mode:${sessionId}:session`) : undefined;
    if (ctx.hasUI) ctx.ui.setWorkingMessage(`Auto mode: checking ${call.toolName}…`);
    try {
      const { result, fellBack, primaryReason } = await classifyWithFallback({
        systemPrompt: promptText(), blocks, complete, timeoutMs: config.timeoutMs,
        stage2Reasoning: config.stage2Reasoning, signal: ctx.signal, screen: makeScreen(ctx, call, notes, escalate),
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

  /** Khóa để luồng duyệt của pi-mcp-adapter nhận ra lời gọi MCP vừa qua cổng tool_call. */
  function mcpKey(call: ToolCall): string {
    if (call.toolName !== "mcp") return callKey(call.toolName, call.input);
    let args = call.input.args ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        /* giữ nguyên chuỗi */
      }
    }
    return callKey(String(call.input.tool), args);
  }

  const BUILTIN = new Set(["bash", "bg_run", "powershell", "read", "grep", "find", "ls", "edit", "write"]);

  function allowed(call: ToolCall, via: string): undefined {
    state.recordAllowed();
    // Chỉ lời gọi có thể là MCP (proxy hoặc tool lạ) cần nhớ cho luồng duyệt của pi-mcp-adapter.
    if (!BUILTIN.has(call.toolName) && !SAFE_TOOLS.has(call.toolName)) {
      const now = Date.now();
      for (const [key, at] of recentlyAllowed) if (now - at > 60_000) recentlyAllowed.delete(key);
      recentlyAllowed.set(mcpKey(call), now);
    }
    log({ event: "allow", tool: call.toolName, via });
    return undefined;
  }

  async function gate(ctx: ExtensionContext, call: ToolCall, toolCallId?: string): Promise<{ block: true; reason: string } | undefined> {
    const pc = policyContext(ctx);
    const facts: CallFacts = describeCall(call, pc);
    const decision = decide(call, pc, facts);
    const key = callKey(call.toolName, call.input);
    if (decision.kind === "allow") return allowed(call, decision.via);
    if (decision.kind === "deny") {
      state.recordDenied({ toolName: call.toolName, summary: facts.summary, reason: decision.reason, rule: decision.rule, key }, false);
      notify(ctx, `${call.toolName} denied by rule ${decision.rule ?? ""}`.trim(), "warning");
      log({ event: "deny", tool: call.toolName, rule: decision.rule });
      return { block: true, reason: text.ruleDenial(decision.reason) };
    }
    if (decision.kind === "ask") {
      const approved = await askUser(ctx, `Allow ${call.toolName}: ${facts.summary}?\n\n${decision.reason}`);
      log({ event: "ask", tool: call.toolName, approved });
      if (approved) return allowed(call, "user");
      return { block: true, reason: approved === false ? text.USER_DENIED : text.NO_APPROVER };
    }
    // Duyệt một lần từ /permissions: bỏ qua bộ phân loại, luật deny vẫn đã áp dụng ở trên.
    if (state.consumeApproval(key)) return allowed(call, "user approval");
    const result = await runClassifier(ctx, call, toolCallId, decision.notes, escalation(call, facts, pc));
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
      if (approved) return allowed(call, "user after denial limit");
    }
    return { block: true, reason: text.classifierDenial(result.rule, result.reason) };
  }

  pi.on("tool_call", async (event, ctx) => {
    latest = ctx;
    return gate(ctx, { toolName: event.toolName, input: event.input as Record<string, unknown> }, event.toolCallId);
  });

  // Lớp đầu vào: kết quả mang nội dung bên ngoài trông như lệnh cho AI thì kèm cảnh báo cho agent (không chặn).
  pi.on("tool_result", async (event, ctx) => {
    if (currentMode() !== "auto" || !config.jev.probe || !jevReady()) return undefined;
    if (!shouldProbe(event.toolName, event.input as Record<string, unknown>, config.jev.probeTools)) return undefined;
    const body = resultText(event.content);
    if (body.trim().length < 100) return undefined;
    const access = await jevAccess;
    if (access?.status !== "ready") return undefined;
    const chunks = probeChunks(body);
    const started = Date.now();
    try {
      // Mỗi đoạn một request, gửi song song; một request lỗi thì bỏ qua lần quét này (probe chỉ cảnh báo).
      const results = await Promise.all(chunks.map((chunk) => evaluate(access, { model: config.jev.model, state: probeState(event.toolName, chunk), questions: PROBE_QUESTIONS },
        { signal: ctx.signal, timeoutMs: config.jev.timeoutMs })));
      for (const result of results) recordUsage(result.inputTokens);
      jevStats.probes++;
      const verdict = judgeProbe(results.map((result) => result.answers), config.jev.probeAt);
      log({
        event: "probe", tool: event.toolName, ms: Date.now() - started, flagged: verdict.flagged, chunks: chunks.length,
        directed: Number(verdict.directed.toFixed(3)), hijack: Number(verdict.hijack.toFixed(3)),
      });
      if (!verdict.flagged) return undefined;
      jevStats.injections++;
      injectionSuspect = event.toolName;
      notify(ctx, `Auto mode: the ${event.toolName} result may contain a prompt injection; Pi was told to treat it as data.`, "warning");
      return { content: [...event.content, { type: "text" as const, text: PROBE_WARNING }] };
    } catch (error) {
      jevFailure(ctx, error, "probe");
      return undefined;
    }
  });

  // Lời gọi MCP (proxy, direct, mcpScript...) được duyệt qua sự kiện của pi-mcp-adapter.
  pi.events.on(MCP_APPROVAL_EVENT, (payload: unknown) => {
    const request = payload as McpRequest;
    const ctx = latest;
    if (!ctx || typeof request?.claim !== "function") return;
    // Tên theo quy ước Claude Code (mcp__server__tool) để luật allow/deny khớp được.
    const toolName = `mcp__${request.serverName}__${request.originalToolName}`;
    const input = { server: request.serverName, tool: request.originalToolName, args: request.args ?? {} };
    request.claim(async () => {
      if (request.origin === "resource") return firstMatch(rules().deny, { toolName }, ctx.cwd) ? "deny" : "allow_once";
      // Lời gọi proxy/direct đã qua cổng tool_call ngay trước đó (cùng tool, cùng tham số).
      const key = callKey(request.prefixedToolName, request.args ?? {});
      const approvedAt = recentlyAllowed.get(key);
      if ((request.origin === "proxy" || request.origin === "direct") && approvedAt && Date.now() - approvedAt < 60_000) {
        recentlyAllowed.delete(key);
        return "allow_once";
      }
      // Lời gọi bên trong mcpScript (và trường hợp khác): phân loại từng lời gọi.
      const verdict = await gate(ctx, { toolName, input });
      return verdict ? "deny" : "allow_once";
    });
  });

  // ---------------------------------------------------------------------------
  // Nguồn gốc tin nhắn: extension gửi thay người dùng thì không phải ý định của người dùng
  // ---------------------------------------------------------------------------

  const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content)
    ? content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? (part as { text: string }).text : "")).join("\n")
    : "");

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
    latest = ctx;
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
    jevResolved = undefined;
    jevAccess = config.jev.enabled
      ? resolveJev().catch((error): JevAccess => ({ status: "unavailable", message: error instanceof Error ? error.message : String(error) }))
      : undefined;
    void loadFacts(ctx.cwd);
    if (child) return;
    const handle: RootHandle = {
      sessionId,
      mode: () => mode,
      humanMessages: () => humanMessages(ctx.sessionManager.getBranch() as SessionEntryLike[]),
      ask: ctx.hasUI ? async (title: string) => (await ctx.ui.select(`[subagent] ${title}`, ["Allow once", "Deny"])) === "Allow once" : undefined,
    };
    registerRoot(handle);
    // Không bao giờ khôi phục bypass từ phiên cũ; chỉ cờ dòng lệnh hoặc settings người dùng.
    const flagBypass = pi.getFlag("dangerously-skip-permissions") === true;
    const wanted = flagBypass ? "bypass" : parseMode(pi.getFlag("permission-mode")) ?? config.defaultMode;
    setMode(ctx, "auto");
    installWidget(ctx);
    if (wanted === "bypass") {
      void canEnterBypass(ctx, true).then((ok) => {
        if (ok) setMode(ctx, "bypass");
      });
    } else if (ctx.hasUI && ctx.mode === "tui") {
      const persisted = readState(config.stateDir);
      if (!persisted.autoNoticeShown) {
        notify(ctx, text.AUTO_NOTICE, "info");
        writeState(config.stateDir, { ...persisted, autoNoticeShown: true });
      }
    }
    // Một lần cho mỗi bản cài: chưa có key Jev (hoặc không đọc được) thì giai đoạn 1 vẫn là LLM.
    if (ctx.hasUI && ctx.mode === "tui") {
      void jevAccess?.then((access) => {
        if (access.status === "ready") return;
        const persisted = readState(config.stateDir);
        if (persisted.jevNoticeShown) return;
        notify(ctx, access.status === "missing" ? text.JEV_NOTICE : `${text.JEV_NOTICE}\n\nNow: ${access.message}`, "info");
        writeState(config.stateDir, { ...persisted, jevNoticeShown: true });
      });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!child) {
      unregisterRoot(sessionId);
      if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
      widgetTui = undefined;
    }
    recentlyAllowed.clear();
  });

  // ---------------------------------------------------------------------------
  // Phím tắt và lệnh
  // ---------------------------------------------------------------------------

  // shift+tab chỉ đăng ký được khi app.thinking.cycle đã chuyển sang phím khác (Pi giữ phím này).
  const thinkingKeys = (() => {
    try {
      const bindings = JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf8")) as Record<string, unknown>;
      const value = bindings["app.thinking.cycle"];
      return value === undefined ? ["shift+tab"] : (Array.isArray(value) ? value : [value]).map((item) => String(item).toLowerCase());
    } catch {
      return ["shift+tab"];
    }
  })();
  const keys = config.keys.filter((key) => !thinkingKeys.includes(key.toLowerCase()));
  if (!keys.length) keys.push("alt+m");
  hintKey = keys[0];
  for (const key of keys) {
    pi.registerShortcut(key as never, { description: "Switch permission mode (auto ⇄ bypass)", handler: (ctx) => cycle(ctx) });
  }

  function modelLabel(): string {
    const llm = config.model ?? "session model";
    if (jevReady() && jevResolved?.status === "ready") return `Jev ${config.jev.model} → ${config.stage2Model ?? llm}`;
    const stage2 = config.stage2Model && config.stage2Model !== config.model ? `, stage 2: ${config.stage2Model}` : "";
    return `${llm}${stage2}`;
  }

  pi.registerCommand("permissions", {
    description: "Permission mode, recently denied actions and rules",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const modeLabel = currentMode() === "bypass" ? "⏵⏵ bypass permissions on" : "⏵⏵ auto mode on";
      const options = [
        `Recently denied (${state.recent.length})`,
        currentMode() === "bypass" ? "Switch to auto mode" : "Switch to bypass permissions mode",
        "Show rules",
      ];
      const choice = await ctx.ui.select(`Permissions · ${modeLabel}\nClassifier: ${modelLabel()}`, options);
      if (!choice) return;
      if (choice.startsWith("Switch")) {
        await cycle(ctx);
        return;
      }
      if (choice === "Show rules") {
        const set = rules();
        const list = (items: { raw: string }[]) => (items.length ? items.map((rule) => `  ${rule.raw}`).join("\n") : "  (none)");
        const body = [
          `Allow:\n${list(set.allow)}`, `Ask:\n${list(set.ask)}`, `Deny:\n${list(set.deny)}`,
          ...(set.stripped.length ? [`Ignored in auto mode (would bypass the classifier):\n${list(set.stripped)}`] : []),
          `Settings: ${config.source}`,
        ].join("\n\n");
        await ctx.ui.editor("Permission rules (read-only view)", body);
        return;
      }
      if (!state.recent.length) {
        ctx.ui.notify("No recent denials. Actions denied by auto mode will appear here.", "info");
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
    },
  });

  pi.registerCommand("auto-mode", {
    description: "Auto mode status, defaults, dry run and eval: /auto-mode [status|defaults|test <command>|eval [jev|provider/model]]",
    getArgumentCompletions: (prefix) => ["status", "defaults", "test ", "eval", "eval jev"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value.trim() })),
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/u);
      if (sub === "eval") {
        // Chạy bộ đánh giá có nhãn qua Jev và/hoặc LLM thật (tốn tiền/quota); không dùng luật allow/ask/deny.
        const file = selfDir ? path.join(selfDir, "eval", "cases.json") : undefined;
        if (!file || !fs.existsSync(file)) {
          notify(ctx, "Eval cases are missing", "error");
          return;
        }
        const jevOnly = rest[0] === "jev";
        const access = jevReady() ? await jevAccess : undefined;
        const screen = access?.status === "ready" ? jevEvalScreen(access, config.jev) : undefined;
        if (jevOnly && !screen) {
          notify(ctx, `Jev is not available: ${jevLabel()}`, "error");
          return;
        }
        const model = jevOnly ? undefined : resolveModel(ctx, rest[0] ?? config.model);
        if (!jevOnly && !model) {
          notify(ctx, "No model is available for the classifier", "error");
          return;
        }
        const cases = (JSON.parse(fs.readFileSync(file, "utf8")) as { cases: EvalCase[] }).cases;
        const evalContext: PolicyContext = {
          mode: "auto", cwd: "/home/dev/project", home: "/home/dev", roots: ["/home/dev/project"],
          rules: buildRuleSet([], [], []), selfPaths: ["/home/dev/.pi/agent/settings.json"],
        };
        const label = model ? `${screen ? `Jev ${config.jev.model} → ` : ""}${model.provider}/${model.id}` : `Jev ${config.jev.model} only (stage 1)`;
        notify(ctx, `Running ${cases.length} eval cases with ${label}…`, "info");
        const outcomes = await runEval(cases, {
          slots: resolveSlots({ ...config, deny: [] }, []),
          complete: model ? makeComplete(ctx, model, model, `pi-auto-mode-eval:${Date.now()}`) : async () => { throw new Error("Jev-only eval calls no LLM"); },
          timeoutMs: config.timeoutMs, stage2Reasoning: config.stage2Reasoning,
          decide: (call) => decide(call, evalContext), skipTools: SAFE_TOOLS, concurrency: jevOnly ? 6 : 3, screen, screenOnly: jevOnly,
        });
        let report = formatReport(outcomes, label, jevOnly);
        const corpusFile = path.join(path.dirname(file), "screen-cases.json");
        if (jevOnly && screen && fs.existsSync(corpusFile)) {
          const corpus = await runScreenCorpus(JSON.parse(fs.readFileSync(corpusFile, "utf8")) as ScreenCorpus, screen);
          report += `\n\n${formatScreenCorpus(corpus, `Jev ${config.jev.model}, flagAt ${config.jev.flagAt}, riskAt ${config.jev.riskAt}`)}`;
        }
        if (ctx.hasUI) await ctx.ui.editor("Auto mode eval (read-only view)", report);
        return;
      }
      if (sub === "defaults") {
        const body = [
          "# Environment", ...DEFAULT_ENVIRONMENT.map((item) => `- ${item}`), "",
          "# HARD rules", ...DEFAULT_HARD_DENY.map((item) => `- ${item}`), "",
          "# SOFT rules", ...DEFAULT_SOFT_DENY.map((item) => `- ${item}`), "",
          "# ALLOW exceptions", ...DEFAULT_ALLOW.map((item) => `- ${item}`), "",
          "Customize in settings.json → autoMode.environment / hard_deny / soft_deny / allow; include \"$defaults\" to keep these.",
        ].join("\n");
        if (ctx.hasUI) await ctx.ui.editor("Auto mode default rules (read-only view)", body);
        return;
      }
      if (sub === "test") {
        const command = rest.join(" ");
        if (!command) {
          notify(ctx, "Usage: /auto-mode test <bash command>", "warning");
          return;
        }
        const call = { toolName: "bash", input: { command } };
        const pc = policyContext(ctx);
        const facts = describeCall(call, pc);
        const decision = decide(call, pc, facts);
        if (decision.kind !== "classify") {
          notify(ctx, `Decision without classifier: ${decision.kind}${"via" in decision ? ` (${decision.via})` : ""}${"reason" in decision ? ` — ${decision.reason}` : ""}`, "info");
          return;
        }
        notify(ctx, "Asking the classifier…", "info");
        const result = await runClassifier(ctx, call, undefined, decision.notes, escalation(call, facts, pc));
        const summary = result.kind === "allow" ? `allow (${result.screen === "jev" ? "Jev" : `stage ${result.stage}`})`
          : result.kind === "block" ? `block (stage ${result.stage}) — ${result.rule ? `[${result.rule}] ` : ""}${result.reason}`
            : `unavailable — ${result.reason}`;
        const screened = lastScreen ? `Jev: ${describeVerdict(lastScreen)}\n` : "";
        notify(ctx, `${screened}Classifier: ${summary}`, result.kind === "allow" ? "info" : "warning");
        return;
      }
      const set = rules();
      notify(ctx, [
        `Mode: ${currentMode() === "bypass" ? "bypass permissions" : "auto"}${child ? " (inherited from the parent session)" : ""}`,
        `Classifier: ${modelLabel()} · timeout ${Math.round(config.timeoutMs / 1000)}s`,
        `Jev (System One): ${jevLabel()}${jevStats.calls || jevStats.failures ? `\n  ${jevUsage()}` : ""}`,
        ...(injectionSuspect ? [`Possible prompt injection in a ${injectionSuspect} result since your last message: actions go straight to careful review`] : []),
        `Denials: ${state.consecutive} in a row, ${state.total} this session (limits ${LIMITS.consecutive}/${LIMITS.total})`,
        `Rules: ${set.allow.length} allow, ${set.ask.length} ask, ${set.deny.length} deny${set.stripped.length ? `, ${set.stripped.length} ignored in auto mode` : ""}`,
      ].join("\n"), "info");
    },
  });
}
