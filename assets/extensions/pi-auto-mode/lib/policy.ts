import os from "node:os";
import path from "node:path";
import type { GitGuardConfig, PermissionMode } from "./config.ts";
import { checkGitGuard, type GitGuardBlock, type GitRunner } from "./git-guard.ts";
import { gitGuardDenial } from "./messages.ts";
import {
  criticalPathReason, insideAny, insideTemporary, isSelfProtected, protectedReason, resolveShellPath, resolveToolPath, temporaryRoots, URL_LIKE,
} from "./paths.ts";
import { detectPowerShellRisks, detectRisks } from "./risks.ts";
import { type DeniedPath, denies, searchReadPaths, shellPathScope } from "./read-scope.ts";
import { allowCoversShell, firstMatch, isPathRule, type RuleMatchTarget, type RuleSet } from "./rules.ts";
import {
  analyzeShell, commandName, commandText, findRemoval, isReadOnlyCommand, isReadOnlyShell, optionOutputs, removeArgs, type ShellAnalysis,
  type SimpleCommand,
} from "./shell.ts";
import { READ_TOOLS, SHELL_TOOLS, WRITE_TOOLS } from "./tools.ts";

/**
 * Quyết định tất định cho một lời gọi tool, trước khi cần tới bộ phân loại.
 * Thứ tự theo Claude Code: deny → ask → rm vào đường dẫn quan trọng → (bypass: xoá đệ quy, lệnh rủi ro)
 * → bypass → tự bảo vệ → lối đi nhanh (chỉ bao giờ nói "an toàn") → bộ phân loại.
 * Manual quyết định như auto; "classify" ở manual là hỏi người dùng (index.ts, lib/manual.ts).
 */
export type Decision =
  | { kind: "allow"; via: string }
  | { kind: "deny"; reason: string; rule?: string; message?: string }
  | { kind: "ask"; reason: string }
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
  /** Thư mục tạm: xoá đệ quy bên trong không cần hỏi khi bypass; mặc định temporaryRoots(). */
  tempRoots?: string[];
  /** Git guard tất định; undefined = bật với danh sách nhánh mặc định. */
  gitGuard?: GitGuardConfig;
  /** Môi trường của tiến trình Pi cho git guard (HOME cho `~`); mặc định process.env. */
  env?: Record<string, string | undefined>;
  /** Chạy git cho git guard (test); mặc định git thật. */
  git?: GitRunner;
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
const DIRECTORY_CHANGERS = new Set(["cd", "pushd", "popd"]);

export interface CallFacts {
  kind: "safe" | "read" | "write" | "shell" | "network" | "agent" | "workflow" | "other";
  target: RuleMatchTarget;
  analysis?: ShellAnalysis;
  readOnly?: boolean;
  /** Đường dẫn ghi (edit/write) hoặc đối số đường dẫn của lệnh shell. */
  paths: string[];
  critical?: string;
  /** Lệnh xoá đệ quy có đích ngoài thư mục tạm (hoặc không kiểm được), vd "rm -r". */
  removal?: string;
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

interface RemovalTarget {
  word: string;
  literal: boolean;
  glob: boolean;
}

const targetAt = (command: SimpleCommand, index: number): RemovalTarget =>
  ({ word: command.words[index], literal: command.literal[index], glob: command.glob[index] });

interface Removal {
  label: string;
  targets: RemovalTarget[];
  /** Đích đến từ stdin hoặc script lồng (xargs, cmd /c, PowerShell): không kiểm được. */
  opaque?: boolean;
}

const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const CMD_RECURSIVE = /\b(?:rd|rmdir|del|erase)\b[^&|]*\s\/\/?s\b/iu;
const POWERSHELL_RECURSIVE = /\b(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^;|\n]*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b/iu;

/**
 * Lệnh xoá đệ quy: rm -r với mọi thứ tự/cách viết cờ, find -delete hoặc -exec rm, git clean
 * (trừ -n), rimraf, rd /s của cmd và Remove-Item -Recurse của PowerShell.
 */
function recursiveRemovals(analysis: ShellAnalysis): Removal[] {
  const result: Removal[] = [];
  for (const command of analysis.commands) {
    const name = commandName(command);
    const args = command.words.slice(1);
    const at = (index: number): RemovalTarget => targetAt(command, index + 1);
    const remove = removeArgs(command.words);
    const find = findRemoval(command.words);
    if (remove) {
      const targets = remove.targets.map((index) => targetAt(command, index));
      // xargs lấy đích từ stdin.
      if (remove.recursive && (targets.length || command.wrapped === "xargs")) result.push({ label: "rm -r", targets, opaque: command.wrapped === "xargs" });
    } else if (find) {
      result.push({
        label: find.deletes ? "find -delete" : "find -exec rm",
        targets: find.targets.length ? find.targets.map((index) => targetAt(command, index)) : [{ word: ".", literal: true, glob: false }],
        opaque: find.follows,
      });
    } else if (name === "git") {
      let index = 0;
      let tree: RemovalTarget = { word: ".", literal: true, glob: false };
      while (index < args.length && args[index].startsWith("-")) {
        const option = args[index];
        if (option === "-C" || option === "--work-tree") {
          if (index + 1 < args.length) tree = at(index + 1);
          index += 2;
        } else if (option.startsWith("--work-tree=")) {
          tree = { word: option.slice("--work-tree=".length), literal: command.literal[index + 1], glob: false };
          index++;
        } else {
          index += ["-c", "--git-dir", "--namespace", "--config-env", "--super-prefix"].includes(option) ? 2 : 1;
        }
      }
      if (args[index] !== "clean") continue;
      let dryRun = false;
      for (let i = index + 1; i < args.length; i++) {
        const word = args[i];
        if (word === "--") break;
        if (word === "--dry-run") dryRun = true;
        else if (word === "--exclude") i++;
        else if (/^-[^-]/u.test(word)) {
          // Cụm cờ ngắn; -e nhận giá trị (dính liền hoặc là từ kế tiếp).
          const cluster = word.slice(1);
          const exclude = cluster.indexOf("e");
          if ((exclude < 0 ? cluster : cluster.slice(0, exclude)).includes("n")) dryRun = true;
          if (exclude === cluster.length - 1) i++;
        }
      }
      // Pathspec chỉ thu hẹp phạm vi: xét cả cây làm việc (git clean bắt đầu từ thư mục hiện tại hoặc -C).
      if (!dryRun) result.push({ label: "git clean", targets: [tree] });
    } else if (name === "rimraf" || (PACKAGE_RUNNERS.has(name) && /^rimraf(?:@|$)/u.test(args.find((word) => !word.startsWith("-")) ?? ""))) {
      const start = name === "rimraf" ? 0 : args.findIndex((word) => !word.startsWith("-")) + 1;
      const targets: RemovalTarget[] = [];
      for (let index = start; index < args.length; index++) if (!args[index].startsWith("-")) targets.push(at(index));
      if (targets.length) result.push({ label: "rimraf", targets });
    } else if (/^cmd(?:\.exe)?$/iu.test(name)) {
      const script = args.findIndex((word) => /^\/\/?[ck]$/iu.test(word));
      if (script >= 0 && CMD_RECURSIVE.test(args.slice(script + 1).join(" "))) result.push({ label: "rd /s", targets: [], opaque: true });
    } else if (/^(?:powershell|pwsh)(?:\.exe)?$/iu.test(name) && POWERSHELL_RECURSIVE.test(args.join(" "))) {
      result.push({ label: "Remove-Item -Recurse", targets: [], opaque: true });
    }
  }
  return result;
}

/**
 * Đích nằm hẳn trong thư mục tạm: chữ thuần, không có "..", đường dẫn thật (sau symlink) ở bên trong.
 * Glob chỉ được ở thành phần cuối (rm không theo symlink của mục khớp, trừ khi có "/" phía sau), và
 * glob ngay dưới thư mục tạm phải có tiền tố: /tmp/pi-test-* được, /tmp/* thì không.
 */
function temporaryTarget(target: RemovalTarget, cwd: string, home: string, temp: string[]): boolean {
  if (!target.literal || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(target.word)) return false;
  if (!target.glob) return insideTemporary(resolveShellPath(target.word, cwd, home), temp);
  const first = target.word.search(/[*?[]/u);
  if (/[\\/]/u.test(target.word.slice(first))) return false;
  const head = `${target.word.slice(0, first)}x`;
  return insideTemporary(resolveShellPath(path.dirname(head), cwd, home), temp, path.basename(head) === "x");
}

function removalOutsideTemp(removals: Removal[], cwd: string, home: string, temp: string[]): string | undefined {
  const outside = removals.filter((item) => item.opaque || !item.targets.length || !item.targets.every((target) => temporaryTarget(target, cwd, home, temp)));
  return outside.length ? [...new Set(outside.map((item) => item.label))].join(", ") : undefined;
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
    const removals = toolName === "powershell"
      ? (POWERSHELL_RECURSIVE.test(command) || CMD_RECURSIVE.test(command) ? [{ label: "Remove-Item -Recurse", targets: [], opaque: true }] : [])
      : recursiveRemovals(analysis);
    const tempRoots = pc.tempRoots ?? temporaryRoots();
    return {
      kind: "shell", analysis, readOnly, paths, summary,
      critical: criticalRemoval(analysis, pc.cwd, home),
      removal: removalOutsideTemp(removals, pc.cwd, home, tempRoots),
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

/** Luật allow phủ mọi lệnh con ghi của một chuỗi lệnh plain (vd Bash(rm -rf node_modules)). */
function allowCovers(facts: CallFacts, pc: PolicyContext): boolean {
  const analysis = facts.analysis;
  return !!analysis?.plain &&
    allowCoversShell(pc.rules.allow, analysis.commands.filter((command) => !isReadOnlyCommand(command)).map(commandText));
}

/** Lệnh shell của bash/bg_run bị git guard chặn; PowerShell có cú pháp khác nên không qua bộ phân tích kiểu sh. */
export function gitGuardBlock(call: ToolCall, pc: PolicyContext): GitGuardBlock | undefined {
  if (pc.gitGuard?.enabled === false) return undefined;
  if (call.toolName !== "bash" && call.toolName !== "bg_run") return undefined;
  const command = call.input.command;
  if (typeof command !== "string") return undefined;
  return checkGitGuard(command, { cwd: pc.cwd, env: pc.env, protectedBranches: pc.gitGuard?.protectedBranches, git: pc.git });
}

/** Luật deny đường dẫn chặn đọc một file (có tính ngoại lệ !Path). */
export function deniedPath(toolName: string, pc: PolicyContext, home = pc.home ?? os.homedir(), writes = false): DeniedPath {
  return (file) => firstMatch(pc.rules.deny, { toolName, paths: [file], writes }, pc.cwd, home)?.raw;
}

function pathRuleList(pc: PolicyContext): string {
  const rules = pc.rules.deny.filter((rule) => !rule.negate && isPathRule(rule)).map((rule) => rule.raw);
  return rules.length > 4 ? `${rules.slice(0, 4).join(", ")}…` : rules.join(", ");
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

  // Git guard: tất định như luật deny, ở cả auto và bypass; không giao cho bộ phân loại hay bypass quyết định lại.
  const guard = gitGuardBlock(call, pc);
  if (guard) return { kind: "deny", rule: "git guard", reason: guard.reason, message: gitGuardDenial(guard) };

  // Luật deny đường dẫn với lệnh shell có tập đích không đọc được từ argv (glob, cây thư mục, biến...):
  // chặn khi thấy file thật khớp luật; không kiểm được thì auto giao bộ phân loại, bypass hỏi người dùng.
  // Tool grep của Pi được lọc ở kết quả (filterDeniedGrep); find/ls chỉ liệt kê tên.
  let unverified: string | undefined;
  const pathDeny = facts.kind === "shell" && pc.rules.deny.some((rule) => !rule.negate && isPathRule(rule) &&
    (["read", "path"].includes(rule.tool.toLowerCase()) || facts.target.writes !== false));
  if (pathDeny) {
    const denied = deniedPath(call.toolName, pc, home, facts.target.writes !== false);
    const scope = call.toolName === "powershell"
      ? { uncertain: "PowerShell commands are not parsed for paths" }
      : shellPathScope(facts.analysis as ShellAnalysis, pc.cwd, home, denied);
    if (scope.evidence) {
      const shown = path.relative(pc.cwd, scope.evidence.file) || scope.evidence.file;
      return {
        kind: "deny", rule: scope.evidence.rule,
        reason: `Permission to use ${call.toolName} has been denied by the rule ${scope.evidence.rule}: the command would read ${shown}. ` +
          "Name the permitted files explicitly, or use the grep tool, which leaves out denied files.",
      };
    }
    unverified = scope.uncertain;
  }

  const ask = firstMatch(pc.rules.ask, facts.target, pc.cwd, home);
  if (ask) return { kind: "ask", reason: `The rule ${ask.raw} requires your confirmation.` };

  if (facts.critical) {
    // Claude Code: auto mode đưa cho bộ phân loại, bypass vẫn phải hỏi người dùng.
    if (pc.mode === "bypass") return { kind: "ask", reason: `This command ${facts.critical}.` };
    notes.push(`this command ${facts.critical}`);
  }

  // Riêng pi-config: bypass hỏi trước mọi lệnh xoá đệ quy ra ngoài thư mục tạm, trừ khi luật allow phủ
  // đúng lệnh (vd Bash(rm -rf node_modules)). Auto mode đã gửi các lệnh này cho bộ phân loại.
  if (pc.mode === "bypass" && facts.removal && !allowCovers(facts, pc)) {
    return { kind: "ask", reason: `This command deletes recursively (${facts.removal}).` };
  }

  // Riêng pi-config: cơ chế tự chạy, tắt kiểm TLS, ghi đường dẫn hệ thống. Bypass hỏi người dùng (trừ khi
  // luật allow phủ đúng lệnh); auto ghi chú cho bộ phân loại và bỏ qua Jev (xem classify ở trên).
  if (facts.risks?.length) {
    if (pc.mode === "bypass" && !allowCovers(facts, pc)) return { kind: "ask", reason: `This command ${facts.risks.join("; ")}.` };
    notes.push(...facts.risks.map((risk) => `this command ${risk}`));
  }

  if (pc.mode === "bypass") {
    if (unverified) return { kind: "ask", reason: `The path deny rules cannot be checked for this command (${unverified}).` };
    return { kind: "allow", via: "bypass" };
  }

  if (facts.writesSelf) {
    return { kind: "ask", reason: "This changes Pi's permission configuration, which only you can approve." };
  }

  if (unverified) {
    notes.push(`the path deny rules (${pathRuleList(pc)}) cannot be checked because ${unverified}; block it if it may read such a file`);
    return { kind: "classify", notes, escalate: true };
  }

  switch (facts.kind) {
    case "safe":
      return { kind: "allow", via: "safe tool" };
    case "read": {
      // Đọc ngoài workspace (vd grep ~/ tìm token) qua bộ phân loại; Claude Code cũng không tự cho qua.
      if (facts.paths.every((file) => readable(file, pc))) return { kind: "allow", via: "safe tool" };
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
      else return { kind: "allow", via: "workspace edit" };
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
          const commands = analysis.commands.filter((command) => !isReadOnlyCommand(command));
          if (allowCoversShell(pc.rules.allow, commands.map(commandText))) return { kind: "allow", via: "allow rule" };
          if (workspaceFileOps(analysis.commands, pc, home)) return { kind: "allow", via: "workspace file operation" };
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
      // Luật allow `Agent` chỉ có ở manual (auto bỏ luật này, xem isDangerousAllow).
      if (firstMatch(pc.rules.allow, facts.target, pc.cwd, home)) return { kind: "allow", via: "allow rule" };
      return classify();
    default: {
      const allow = firstMatch(pc.rules.allow, facts.target, pc.cwd, home);
      if (allow) return { kind: "allow", via: "allow rule" };
      return classify();
    }
  }
}
