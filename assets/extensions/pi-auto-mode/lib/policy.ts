import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "./config.ts";
import { criticalPathReason, insideAny, isSelfProtected, protectedReason, resolveShellPath, resolveToolPath } from "./paths.ts";
import { allowCoversShell, firstMatch, type RuleMatchTarget, type RuleSet } from "./rules.ts";
import { analyzeShell, commandName, commandText, isReadOnlyCommand, isReadOnlyShell, type ShellAnalysis, type SimpleCommand } from "./shell.ts";

/**
 * Quyết định tất định cho một lời gọi tool, trước khi cần tới bộ phân loại.
 * Thứ tự theo Claude Code: deny → ask → rm vào đường dẫn quan trọng → bypass
 * → tự bảo vệ → lối đi nhanh (chỉ bao giờ nói "an toàn") → bộ phân loại.
 */
export type Decision =
  | { kind: "allow"; via: string }
  | { kind: "deny"; reason: string; rule?: string }
  | { kind: "ask"; reason: string }
  | { kind: "classify"; notes: string[] };

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
}

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

// Tool không đổi trạng thái bên ngoài phiên: đọc, tìm kiếm, todo, hỏi người dùng, xem subagent,
// công cụ đọc của pi-lens, trạng thái goal và advisor. Tương tự danh sách safe-tool của Claude Code.
export const SAFE_TOOLS = new Set([
  "read", "grep", "find", "ls", "todo", "ask_user_question", "get_subagent_result", "steer_subagent",
  "bg_status", "bg_logs", "bg_kill", "get_search_content",
  "lens_diagnostics", "project_report", "module_report", "lsp_navigation", "symbol_search", "read_symbol",
  "read_enclosing", "ast_grep_search", "ast_grep_outline", "effective_config", "lens_diagnostic_mark",
  "pi_lens_activate_tools",
  "get_goal", "create_goal", "update_goal", "set_goal_tasks", "update_goal_task", "submit_goal_oracle_advice",
  "ask_advisor", "record_advisor_outcome",
]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "bg_run"]);
const FS_WRITE_COMMANDS = new Set(["mkdir", "touch", "cp", "mv"]);
const DIRECTORY_CHANGERS = new Set(["cd", "pushd", "popd"]);

export interface CallFacts {
  kind: "safe" | "read" | "write" | "shell" | "network" | "agent" | "workflow" | "mcp" | "other";
  target: RuleMatchTarget;
  analysis?: ShellAnalysis;
  readOnly?: boolean;
  /** Đường dẫn ghi (edit/write) hoặc đối số đường dẫn của lệnh shell. */
  paths: string[];
  critical?: string;
  writesSelf?: boolean;
  /** Tóm tắt ngắn để hiển thị. */
  summary: string;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]+:\/\//iu;
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
    for (const redirect of command.redirects) {
      if (redirect.literal && looksLikePath(redirect.target) && !/^\d+$|^-$/u.test(redirect.target)) {
        result.add(resolveShellPath(redirect.target, cwd, home));
      }
    }
  }
  return [...result];
}

/** rm/rmdir/unlink hoặc find -delete nhắm vào đường dẫn quan trọng. */
function criticalRemoval(analysis: ShellAnalysis, cwd: string, home: string): string | undefined {
  for (const command of analysis.commands) {
    const name = commandName(command);
    const args = command.words.slice(1);
    let targets: { word: string; literal: boolean; glob: boolean }[] = [];
    if (name === "rm" || name === "rmdir" || name === "unlink") {
      let options = true;
      args.forEach((word, i) => {
        if (options && word === "--") {
          options = false;
          return;
        }
        if (options && word.startsWith("-") && word !== "-") return;
        targets.push({ word, literal: command.literal[i + 1], glob: command.glob[i + 1] });
      });
    } else if (name === "find" && args.includes("-delete")) {
      targets = args.filter((word, i) => i < args.findIndex((item) => item.startsWith("-")) || !args.some((item) => item.startsWith("-")))
        .map((word) => ({ word, literal: true, glob: false }));
    } else {
      continue;
    }
    for (const target of targets) {
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

function summarize(toolName: string, input: Record<string, unknown>): string {
  const pick = (value: unknown) => (typeof value === "string" ? value : undefined);
  const text = pick(input.command) ?? pick(input.path) ?? pick(input.url) ?? pick(input.query) ??
    (Array.isArray(input.urls) ? input.urls.join(" ") : undefined) ?? pick(input.prompt) ?? pick(input.tool) ?? JSON.stringify(input);
  const oneLine = text.replace(/\s+/gu, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}

export function describeCall(call: ToolCall, pc: PolicyContext): CallFacts {
  const home = pc.home ?? os.homedir();
  const { toolName, input } = call;
  const summary = summarize(toolName, input);
  if (SHELL_TOOLS.has(toolName) || toolName === "powershell") {
    const command = typeof input.command === "string" ? input.command : "";
    // PowerShell không phân tích được bằng bộ lexer bash: chỉ khớp chuỗi gốc.
    const analysis = toolName === "powershell"
      ? { commands: [], plain: false, problems: ["powershell"], nested: [] }
      : analyzeShell(command);
    const readOnly = isReadOnlyShell(analysis);
    const paths = shellPaths(analysis, pc.cwd, home);
    return {
      kind: "shell", analysis, readOnly, paths, summary,
      critical: criticalRemoval(analysis, pc.cwd, home),
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
    const url = typeof input.url === "string" ? input.url : Array.isArray(input.urls) && typeof input.urls[0] === "string" ? input.urls[0] : undefined;
    return { kind: "network", paths: [], summary, target: { toolName, url } };
  }
  if (toolName === "Agent") return { kind: "agent", paths: [], summary, target: { toolName } };
  if (toolName === "SubagentWorkflow" || toolName === "mcpScript") return { kind: "workflow", paths: [], summary, target: { toolName } };
  if (toolName === "mcp") {
    // Proxy của pi-mcp-adapter: luật đường dẫn áp dụng cho tham số của tool MCP được gọi.
    const paths = inputPaths(input, pc.cwd, home);
    return { kind: "mcp", paths, summary, writesSelf: paths.some((file) => isSelfProtected(file, pc.selfPaths)), target: { toolName, paths } };
  }
  if (SAFE_TOOLS.has(toolName)) return { kind: "safe", paths: [], summary, target: { toolName } };
  // pi-lens: chỉ xem trước khi apply khác true.
  if (toolName === "ast_grep_replace" && input.apply !== true) return { kind: "safe", paths: [], summary, target: { toolName } };
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

/** mkdir/touch/cp/mv với mọi đích nằm trong workspace, không phải đường dẫn được bảo vệ. */
function workspaceFileOps(commands: SimpleCommand[], pc: PolicyContext, home: string): boolean {
  if (commands.some((command) => DIRECTORY_CHANGERS.has(commandName(command)))) return false;
  let sawWrite = false;
  for (const command of commands) {
    if (isReadOnlyCommand(command)) continue;
    const name = commandName(command);
    if (!FS_WRITE_COMMANDS.has(name) || command.words[0] !== name || command.redirects.length || command.wrapped) return false;
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

export function decide(call: ToolCall, pc: PolicyContext, facts = describeCall(call, pc)): Decision {
  const home = pc.home ?? os.homedir();
  const notes: string[] = [];

  const deny = firstMatch(pc.rules.deny, facts.target, pc.cwd, home);
  if (deny) return { kind: "deny", rule: deny.raw, reason: `Permission to use ${call.toolName} has been denied by the rule ${deny.raw}.` };

  const ask = firstMatch(pc.rules.ask, facts.target, pc.cwd, home);
  if (ask) return { kind: "ask", reason: `The rule ${ask.raw} requires your confirmation.` };

  if (facts.critical) {
    // Claude Code: auto mode đưa cho bộ phân loại, bypass vẫn phải hỏi người dùng.
    if (pc.mode === "bypass") return { kind: "ask", reason: `This command ${facts.critical}.` };
    notes.push(`this command ${facts.critical}`);
  }

  if (pc.mode === "bypass") return { kind: "allow", via: "bypass" };

  if (facts.writesSelf) {
    return { kind: "ask", reason: "This changes Pi's permission configuration, which only you can approve in auto mode." };
  }

  switch (facts.kind) {
    case "safe":
      return { kind: "allow", via: "safe tool" };
    case "read": {
      // Đọc ngoài workspace (vd grep ~/ tìm token) qua bộ phân loại; Claude Code cũng không tự cho qua.
      if (facts.paths.every((file) => readable(file, pc))) return { kind: "allow", via: "safe tool" };
      notes.push("reads outside the working directory");
      return { kind: "classify", notes };
    }
    case "write": {
      const file = facts.paths[0];
      if (!file) return { kind: "classify", notes: ["the target path is missing"] };
      const guarded = protectedReason(file, pc.roots);
      if (guarded) notes.push(`writes ${guarded}`);
      else if (!insideAny(pc.roots, file)) notes.push("writes outside the working directory");
      else return { kind: "allow", via: "workspace edit" };
      return { kind: "classify", notes };
    }
    case "shell": {
      const analysis = facts.analysis as ShellAnalysis;
      if (!facts.critical) {
        if (facts.readOnly) {
          if (facts.paths.every((file) => readable(file, pc))) return { kind: "allow", via: "read-only command" };
          notes.push("reads outside the working directory");
        }
        if (analysis.plain) {
          const commands = analysis.commands.filter((command) => !isReadOnlyCommand(command));
          if (allowCoversShell(pc.rules.allow, commands.map(commandText))) return { kind: "allow", via: "allow rule" };
          if (workspaceFileOps(analysis.commands, pc, home)) return { kind: "allow", via: "workspace file operation" };
        }
      }
      if (!analysis.plain && analysis.problems.length) notes.push(`shell constructs: ${analysis.problems.slice(0, 4).join(", ")}`);
      return { kind: "classify", notes };
    }
    case "agent":
      if (pc.agentIsUngated?.(call.input)) {
        return {
          kind: "deny",
          reason: "This subagent would run without extensions (isolated), so auto mode could not check its actions. Spawn it without isolated/extensions:false, or ask the user to run it in bypass mode.",
        };
      }
      return { kind: "classify", notes };
    case "mcp": {
      const action = call.input.action;
      if (typeof action === "string" && ["install", "auth-start", "auth-complete"].includes(action)) {
        notes.push(`MCP ${action}`);
        return { kind: "classify", notes };
      }
      // Gọi một tool MCP: phân loại tại đây để model nhận đúng lý do; tìm kiếm/mô tả/trạng thái thì cho qua.
      if (typeof call.input.tool === "string") return { kind: "classify", notes };
      return { kind: "allow", via: "mcp discovery" };
    }
    default: {
      const allow = firstMatch(pc.rules.allow, facts.target, pc.cwd, home);
      if (allow) return { kind: "allow", via: "allow rule" };
      return { kind: "classify", notes };
    }
  }
}
