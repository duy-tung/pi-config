import os from "node:os";
import path from "node:path";
import { type PermissionMode, prompts } from "./config.ts";
import {
  criticalPathReason, insideAny, isSelfProtected, protectedReason, resolveShellPath, resolveToolPath, temporaryRoots, URL_LIKE,
} from "./paths.ts";
import { detectPowerShellRisks, detectRisks } from "./risks.ts";
import { type DeniedPath, denies, searchReadPaths } from "./read-scope.ts";
import { allowCoversShell, firstMatch, type RuleMatchTarget, type RuleSet } from "./rules.ts";
import {
  analyzeShell, commandName, commandText, findRemoval, isReadOnlyCommand, isReadOnlyShell, optionOutputs, removeArgs, ruleUnits,
  safeAssignments, type ShellAnalysis, type SimpleCommand,
} from "./shell.ts";
import { READ_TOOLS, SHELL_TOOLS, WRITE_TOOLS } from "./tools.ts";

/**
 * Quyết định tất định cho một lời gọi tool, trước khi cần tới bộ phân loại.
 * Thứ tự theo Claude Code: deny → ask → rm vào đường dẫn quan trọng (bypass hỏi) → bypass → cấu hình của Pi
 * → lối đi nhanh (chỉ bao giờ nói "an toàn") → bộ phân loại.
 * Manual/acceptEdits quyết định như auto; "classify" ở hai mode này là hỏi người dùng (index.ts, lib/manual.ts).
 */
export type Decision =
  | { kind: "allow"; via: string }
  | { kind: "deny"; reason: string; rule?: string; message?: string }
  /** critical: rm vào đường dẫn quan trọng ở auto/bypass (hỏi có đếm ngược); outsideRead: lần đọc đầu ngoài workspace ở auto. */
  | { kind: "ask"; reason: string; critical?: boolean; outsideRead?: string[] }
  | { kind: "classify"; notes: string[]; escalate?: boolean };

export interface PolicyContext {
  mode: PermissionMode;
  cwd: string;
  home?: string;
  /** Thư mục làm việc và additionalDirectories, tuyệt đối. */
  roots: string[];
  /** Thư mục đọc tự do (roots + skill, tài liệu Pi...); mặc định = roots. */
  readRoots?: string[];
  rules: RuleSet;
  /** File/thư mục chỉ người dùng được sửa khi ở auto mode (cấu hình của chính cổng này). */
  selfPaths: string[];
  /** Agent (tintinweb) sẽ chạy không có extension, tức là không có cổng permission. */
  agentIsUngated?: (input: Record<string, unknown>) => boolean;
  /** Thư mục tạm (cho lib/risks.ts); mặc định temporaryRoots(). */
  tempRoots?: string[];
  /** permissions.blockReadsOutsideWorkingDirectories: tool đọc file từ chối đọc ngoài workspace ở mọi mode. */
  blockOutsideReads?: boolean;
  /** Người dùng đã chọn "keep allowing" ở lần đọc đầu ngoài workspace của auto mode. */
  outsideReadsAccepted?: boolean;
}

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

// Tool không đổi trạng thái bên ngoài phiên: đọc, tìm kiếm, todo, hỏi người dùng, xem subagent,
// xem tiến trình nền, bật web tools, advisor. Tương tự danh sách safe-tool của Claude Code.
// bg_kill dừng tiến trình nên không thuộc danh sách: đi qua bộ phân loại như tool khác.
export const SAFE_TOOLS = new Set([
  "read", "grep", "find", "ls", "todo", "ask_user_question", "get_subagent_result", "steer_subagent",
  "bg_status", "bg_logs", "get_search_content", "web_enable",
  "ask_advisor", "record_advisor_outcome",
  // Pi 0.99 (builtin:tool-search): chỉ khai báo tool đã đăng ký cho lượt sau; mỗi lời gọi tool đó vẫn qua cổng.
  "tool_search",
]);
const FS_WRITE_COMMANDS = new Set(["mkdir", "touch", "cp", "mv"]);
const ACCEPT_EDITS_COMMANDS = new Set([...FS_WRITE_COMMANDS, "rm", "rmdir", "sed"]);
const DIRECTORY_CHANGERS = new Set(["cd", "pushd", "popd"]);

export interface CallFacts {
  kind: "safe" | "read" | "write" | "shell" | "network" | "agent" | "workflow" | "other";
  target: RuleMatchTarget;
  analysis?: ShellAnalysis;
  readOnly?: boolean;
  /** Đường dẫn ghi (edit/write) hoặc đối số đường dẫn của lệnh shell. */
  paths: string[];
  critical?: string;
  /** Rủi ro nhận ra tất định (lib/risks.ts): cơ chế tự chạy, tắt kiểm TLS, ghi đường dẫn hệ thống. */
  risks?: string[];
  writesSelf?: boolean;
  /** Tóm tắt ngắn để hiển thị. */
  summary: string;
}

// Đường dẫn tuyệt đối/tương đối rõ ràng: /, ~/, ./, ../, ổ đĩa Windows (C:\ hoặc C:/), UNC (\\server).
const EXPLICIT_PATH = /^(?:\/|~[\/\\]|~$|\.\.?[\/\\]|[A-Za-z]:[\/\\]|\\\\)/u;

// Từ của lệnh shell: có khoảng trắng chỉ tính là đường dẫn khi chứa dấu phân cách thư mục
// ("My Project/.env"), để câu commit kiểu "fix bug" không bị coi là file.
const looksLikePath = (word: string) =>
  word !== "" && !/[\r\n]/u.test(word) && (!/\s/u.test(word) || /[\/\\]/u.test(word)) && !word.startsWith("-") && !URL_LIKE.test(word);

/** Đối số có thể là đường dẫn: mọi từ chữ thuần (trừ tên lệnh và tùy chọn) + đích chuyển hướng. */
function shellPaths(analysis: ShellAnalysis, cwd: string, home: string): string[] {
  const result = new Set<string>();
  for (const command of analysis.commands) {
    command.words.forEach((word, index) => {
      if (index === 0 || !command.literal[index]) return;
      let value = word;
      // curl -d @file, --data-binary=@file, --file=path
      if (value.startsWith("@")) value = value.slice(1);
      const eq = value.startsWith("-") ? value.indexOf("=") : -1;
      if (eq > 0) value = value.slice(eq + 1).replace(/^@/u, "");
      if (!looksLikePath(value)) return;
      result.add(resolveShellPath(value, cwd, home));
    });
    for (const output of optionOutputs(command)) if (looksLikePath(output)) result.add(resolveShellPath(output, cwd, home));
    // grep/rg có thể đọc file tham số viết liền với cờ, vd -f.env hoặc --file=.env.
    for (const file of searchReadPaths(command)?.paths ?? []) result.add(resolveShellPath(file, cwd, home));
    for (const redirect of command.redirects) {
      if (redirect.literal && looksLikePath(redirect.target) && !/^\d+$|^-$/u.test(redirect.target)) {
        result.add(resolveShellPath(redirect.target, cwd, home));
      }
    }
  }
  return [...result];
}

const targetAt = (command: SimpleCommand, index: number) =>
  ({ word: command.words[index], literal: command.literal[index], glob: command.glob[index] });

/** rm/rmdir/unlink hoặc find -delete nhắm vào đường dẫn quan trọng. */
function criticalRemoval(analysis: ShellAnalysis, cwd: string, home: string): string | undefined {
  for (const command of analysis.commands) {
    const name = commandName(command);
    const find = findRemoval(command.words);
    const indices = removeArgs(command.words)?.targets ?? (find?.deletes ? find.targets : undefined);
    if (!indices) continue;
    for (const target of indices.map((i) => targetAt(command, i))) {
      if (!target.literal) {
        // rm -rf "$DIR"/* hoặc "$DIR"/: không kiểm được đích thật.
        if (/\/\*?$/u.test(target.word) || target.word.endsWith("*")) return `${name} target cannot be verified (${target.word})`;
        continue;
      }
      let file = resolveShellPath(target.word, cwd, home);
      if (target.glob) {
        // Glob xóa nội dung thư mục chứa nó: rm -rf * ≈ xóa thư mục làm việc.
        const first = target.word.search(/[*?[]/u);
        file = resolveShellPath(path.dirname(`${target.word.slice(0, first)}x`), cwd, home);
      }
      const reason = criticalPathReason(file, cwd, home);
      if (reason) return `${name} targets ${reason}`;
    }
  }
  return undefined;
}

function summarize(input: Record<string, unknown>): string {
  const pick = (value: unknown) => (typeof value === "string" ? value : undefined);
  const text = pick(input.command) ?? pick(input.path) ?? pick(input.url) ?? pick(input.query) ??
    (Array.isArray(input.urls) ? input.urls.join(" ") : undefined) ?? pick(input.prompt) ?? pick(input.tool) ?? JSON.stringify(input);
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}

export function describeCall(call: ToolCall, pc: PolicyContext): CallFacts {
  const home = pc.home ?? os.homedir();
  const { toolName, input } = call;
  const summary = summarize(input);
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof input.command === "string" ? input.command : "";
    // PowerShell không phân tích được bằng bộ lexer bash: chỉ khớp chuỗi gốc.
    const analysis = toolName === "powershell"
      ? { commands: [], plain: false, problems: ["powershell"], nested: [] }
      : analyzeShell(command);
    const readOnly = isReadOnlyShell(analysis);
    const paths = shellPaths(analysis, pc.cwd, home);
    const tempRoots = pc.tempRoots ?? temporaryRoots();
    return {
      kind: "shell", analysis, readOnly, paths, summary,
      critical: criticalRemoval(analysis, pc.cwd, home),
      risks: toolName === "powershell" ? detectPowerShellRisks(command) : detectRisks(analysis, { cwd: pc.cwd, home, roots: pc.roots, tempRoots }),
      writesSelf: !readOnly && paths.some((file) => isSelfProtected(file, pc.selfPaths)),
      target: { toolName, commands: analysis.commands.map(commandText), raw: command, paths, writes: !readOnly },
    };
  }
  if (READ_TOOLS.has(toolName)) {
    const file = resolveToolPath(input.path, pc.cwd, home) ?? pc.cwd;
    return { kind: "read", paths: [file], summary, target: { toolName, paths: [file] } };
  }
  if (WRITE_TOOLS.has(toolName)) {
    const file = resolveToolPath(input.path, pc.cwd, home);
    const paths = file ? [file] : [];
    return {
      kind: "write", paths, summary, writesSelf: paths.some((item) => isSelfProtected(item, pc.selfPaths)),
      target: { toolName, paths },
    };
  }
  if (toolName === "fetch_content" || toolName === "web_search" || toolName === "source_check") {
    const urls = [input.url, ...(Array.isArray(input.urls) ? input.urls : [])].filter((url): url is string => typeof url === "string");
    return { kind: "network", paths: [], summary, target: { toolName, urls } };
  }
  if (toolName === "Agent") return { kind: "agent", paths: [], summary, target: { toolName } };
  if (toolName === "SubagentWorkflow") return { kind: "workflow", paths: [], summary, target: { toolName } };
  if (SAFE_TOOLS.has(toolName)) return { kind: "safe", paths: [], summary, target: { toolName } };
  // Tool khác (MCP, extension): luật đường dẫn áp dụng cho tham số giống đường dẫn.
  const paths = inputPaths(input, pc.cwd, home);
  return { kind: "other", paths, summary, writesSelf: paths.some((file) => isSelfProtected(file, pc.selfPaths)), target: { toolName, paths } };
}

const PATH_KEY = /(?:^|_)(?:path|paths|file|files|filename|filepath|dir|directory|source|destination|dest|target|cwd)$/iu;

/** Giá trị chuỗi dưới khóa kiểu path/file/dir, hoặc chuỗi bắt đầu bằng / ~/ ./ ../ (kể cả args là chuỗi JSON). */
function inputPaths(input: unknown, cwd: string, home: string): string[] {
  const result = new Set<string>();
  const visit = (value: unknown, key: string, depth: number) => {
    if (depth > 6) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 100_000) {
        try {
          visit(JSON.parse(trimmed), key, depth + 1);
          return;
        } catch {
          /* không phải JSON */
        }
      }
      // Tham số của tool là chuỗi riêng: dấu cách vẫn là một phần đường dẫn.
      const pathLike = EXPLICIT_PATH.test(trimmed) || (PATH_KEY.test(key) && trimmed !== "" && !trimmed.startsWith("-") && !URL_LIKE.test(trimmed));
      if (pathLike && !/[\r\n]/u.test(trimmed) && trimmed.length < 4_096) result.add(resolveShellPath(trimmed, cwd, home));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value as Record<string, unknown>)) visit(item, name, depth + 1);
    }
  };
  visit(input, "", 0);
  return [...result];
}

const DEVICES = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function readable(file: string, pc: PolicyContext): boolean {
  return DEVICES.has(file) || insideAny(pc.readRoots ?? pc.roots, file);
}

/**
 * Lệnh file với mọi đối số nằm trong workspace, không phải đường dẫn được bảo vệ: mkdir/touch/cp/mv (acceptEdits và
 * auto), thêm rm/rmdir/sed -i ở acceptEdits như Claude Code. Cho phép biến môi trường an toàn (`LANG=C`) và wrapper
 * timeout/time/nice/nohup/stdbuf đứng trước.
 */
function workspaceFileOps(commands: SimpleCommand[], pc: PolicyContext, home: string): boolean {
  if (commands.some((command) => DIRECTORY_CHANGERS.has(commandName(command)))) return false;
  const allowed = pc.mode === "acceptEdits" ? ACCEPT_EDITS_COMMANDS : FS_WRITE_COMMANDS;
  let sawWrite = false;
  for (const command of commands) {
    if (!safeAssignments(command)) return false;
    if (isReadOnlyCommand({ ...command, assignments: [] })) continue;
    const name = commandName(command);
    if (!allowed.has(name) || command.words[0] !== name || command.redirects.length || command.wrapped) return false;
    if (name === "sed" && !command.words.some((word) => /^-i|^--in-place(?:=|$)/u.test(word))) return false;
    const args = command.words.slice(1).filter((word) => !word.startsWith("-"));
    if (!args.length) return false;
    for (const word of args) {
      const file = resolveShellPath(word, pc.cwd, home);
      if (!insideAny(pc.roots, file) || protectedReason(file, pc.roots)) return false;
    }
    sawWrite = true;
  }
  return sawWrite;
}

/** Luật deny đường dẫn chặn đọc một file (có tính ngoại lệ !Path). */
export function deniedPath(toolName: string, pc: PolicyContext, home = pc.home ?? os.homedir(), writes = false): DeniedPath {
  return (file) => firstMatch(pc.rules.deny, { toolName, paths: [file], writes }, pc.cwd, home)?.raw;
}

/**
 * Bỏ khỏi kết quả tool grep của Pi các dòng thuộc file bị luật deny đường dẫn chặn đọc.
 * Dòng có dạng "<đường dẫn>:<dòng>: nội dung" hoặc "<đường dẫn>-<dòng>- ngữ cảnh" (tools/grep.js của Pi), đường
 * dẫn tương đối với thư mục tìm.
 */
export function filterDeniedGrep(text: string, searchPath: string, pc: PolicyContext): { text: string; removed: number } {
  const denied = deniedPath("grep", pc);
  const cache = new Map<string, boolean>();
  const isDenied = (relative: string) => {
    let hit = cache.get(relative);
    if (hit === undefined) {
      const candidates = [path.resolve(searchPath, relative), path.resolve(path.dirname(searchPath), relative)];
      hit = candidates.some((file) => !!denies(file, denied));
      cache.set(relative, hit);
    }
    return hit;
  };
  let removed = 0;
  const kept = text.split("\n").filter((line) => {
    // Đường dẫn là phần trước dấu tách đầu tiên; phần sau là nội dung file, có thể chứa chuỗi giống dấu tách.
    const match = /[:-]\d+[:-] /u.exec(line);
    if (match?.index && isDenied(line.slice(0, match.index))) {
      removed++;
      return false;
    }
    return true;
  });
  return { text: kept.join("\n"), removed };
}

export function decide(call: ToolCall, pc: PolicyContext, facts = describeCall(call, pc)): Decision {
  const home = pc.home ?? os.homedir();
  const notes: string[] = [];
  /**
   * Hành động có bằng chứng rủi ro từ lớp chính sách thì bỏ qua sàng lọc nhanh (Jev) và đi thẳng LLM giai đoạn 2:
   * rm vào đường dẫn quan trọng, lệnh có rủi ro nhận ra được, edit/write vào đường dẫn được bảo vệ (`guarded`).
   */
  const classify = (guarded = false): Decision =>
    (facts.critical || facts.risks?.length || guarded ? { kind: "classify", notes, escalate: true } : { kind: "classify", notes });

  const deny = firstMatch(pc.rules.deny, facts.target, pc.cwd, home);
  if (deny) return { kind: "deny", rule: deny.raw, reason: `Permission to use ${call.toolName} has been denied by the rule ${deny.raw}.` };

  const ask = firstMatch(pc.rules.ask, facts.target, pc.cwd, home);
  if (ask) return { kind: "ask", reason: `The rule ${ask.raw} requires your confirmation.` };

  if (facts.critical) {
    // Claude Code: auto và bypass hỏi người dùng (đếm ngược 2 phút), không đưa bộ phân loại; manual/acceptEdits hỏi như
    // mọi lời gọi khác, không có "don't ask again". Không luật allow nào cho qua.
    if (pc.mode === "auto" || pc.mode === "bypass") return { kind: "ask", reason: `This command ${facts.critical}.`, critical: true };
    notes.push(`this command ${facts.critical}`);
  }

  // Riêng pi-config: cơ chế tự chạy, tắt kiểm TLS, ghi đường dẫn hệ thống: ghi chú cho bộ phân loại (bỏ qua Jev, xem
  // classify ở trên); manual/acceptEdits hỏi kèm ghi chú. Bypass cho chạy như Claude Code.
  if (facts.risks?.length) notes.push(...facts.risks.map((risk) => `this command ${risk}`));

  // Như Claude Code: blockReadsOutsideWorkingDirectories chặn tool đọc file ngoài workspace ở mọi mode, kể cả bypass;
  // lệnh shell chỉ đọc vào đó thì hỏi.
  if (pc.blockOutsideReads && (facts.kind === "read" || (facts.kind === "shell" && facts.readOnly)) && !facts.paths.every((file) => readable(file, pc))) {
    if (facts.kind === "read") {
      return {
        kind: "deny", rule: "blockReadsOutsideWorkingDirectories",
        reason: "Reads outside the working directories are blocked by permissions.blockReadsOutsideWorkingDirectories. Ask the user to add the directory with /add-dir if you need it.",
      };
    }
    return { kind: "ask", reason: "This command reads outside the working directories, which permissions.blockReadsOutsideWorkingDirectories blocks for file tools." };
  }

  if (pc.mode === "bypass") return { kind: "allow", via: "bypass" };

  // Cấu hình của chính Pi và cổng permission (như .claude/ của Claude Code): auto gửi bộ phân loại (giai đoạn 2),
  // manual/acceptEdits hỏi; không có lựa chọn "don't ask again".
  if (facts.writesSelf) {
    notes.push("changes Pi's permission configuration (settings, extensions, permission state)");
    return { kind: "classify", notes, escalate: true };
  }

  switch (facts.kind) {
    case "safe":
      return { kind: "allow", via: "safe tool" };
    case "read": {
      if (facts.paths.every((file) => readable(file, pc))) return { kind: "allow", via: "safe tool" };
      // Như Claude Code: auto cho tool đọc file đọc ngoài workspace, chỉ hỏi một lần đầu; manual/acceptEdits hỏi (cho
      // đọc cả thư mục tới hết phiên).
      if (pc.mode === "auto") {
        if (pc.outsideReadsAccepted) return { kind: "allow", via: "read outside the working directories" };
        return { kind: "ask", reason: "Claude Code-style first read outside the working directories.", outsideRead: facts.paths };
      }
      notes.push("reads outside the working directory");
      return classify();
    }
    case "write": {
      const file = facts.paths[0];
      if (!file) {
        notes.push("the target path is missing");
        return classify();
      }
      const guarded = protectedReason(file, pc.roots);
      if (guarded) notes.push(`writes ${guarded}`);
      else if (!insideAny(pc.roots, file)) notes.push("writes outside the working directory");
      // Manual (mode default của Claude Code) hỏi cả khi sửa file trong workspace; acceptEdits và auto cho chạy ngay.
      else if (pc.mode !== "manual") return { kind: "allow", via: "workspace edit" };
      return classify(!!guarded);
    }
    case "shell": {
      const analysis = facts.analysis as ShellAnalysis;
      if (!facts.critical) {
        if (facts.readOnly) {
          if (facts.paths.every((file) => readable(file, pc))) return { kind: "allow", via: "read-only command" };
          notes.push("reads outside the working directory");
        }
        if (analysis.plain) {
          const commands = ruleUnits(analysis).filter((command) => !isReadOnlyCommand(command));
          if (allowCoversShell(pc.rules.allow, commands.map(commandText))) return { kind: "allow", via: "allow rule" };
        }
        // Biến môi trường an toàn (LANG=C) đứng trước lệnh file không làm mất lối đi nhanh của acceptEdits/auto.
        const plainExceptEnv = analysis.plain || analysis.problems.every((problem) => problem === "environment assignment");
        if (pc.mode !== "manual" && plainExceptEnv && workspaceFileOps(ruleUnits(analysis), pc, home)) {
          return { kind: "allow", via: "workspace file operation" };
        }
      }
      if (!analysis.plain && analysis.problems.length) notes.push(`shell constructs: ${analysis.problems.slice(0, 4).join(", ")}`);
      return classify();
    }
    case "network": {
      // Deny/ask khớp bất kỳ URL nào; allow phải phủ mọi URL, kể cả khi có cả url và urls.
      const targets = facts.target.urls?.length
        ? facts.target.urls.map((url) => ({ toolName: call.toolName, urls: [url] }))
        : [facts.target];
      if (targets.every((target) => firstMatch(pc.rules.allow, target, pc.cwd, home))) return { kind: "allow", via: "allow rule" };
      return classify();
    }
    case "agent":
      if (pc.agentIsUngated?.(call.input)) {
        return {
          kind: "deny",
          reason: "This subagent would run without extensions (isolated), so the permission gate could not check its actions. Spawn it without isolated/extensions:false, or ask the user to run it in bypass mode.",
        };
      }
      // Như Claude Code: tool Agent không cần hỏi ở manual/acceptEdits; từng lệnh của subagent vẫn qua cổng (hỏi
      // qua phiên gốc). Auto xét nội dung task lúc spawn. Luật allow `Agent` chỉ có hiệu lực ngoài auto (isDangerousAllow).
      if (prompts(pc.mode)) return { kind: "allow", via: "subagent (its actions are checked)" };
      if (firstMatch(pc.rules.allow, facts.target, pc.cwd, home)) return { kind: "allow", via: "allow rule" };
      return classify();
    default: {
      const allow = firstMatch(pc.rules.allow, facts.target, pc.cwd, home);
      if (allow) return { kind: "allow", via: "allow rule" };
      return classify();
    }
  }
}
