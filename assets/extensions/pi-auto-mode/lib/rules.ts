import os from "node:os";
import path from "node:path";
import { realPath } from "./paths.ts";

/**
 * Luật permission theo cú pháp Claude Code: `Tool` hoặc `Tool(specifier)`.
 * - Bash(cmd *): khớp từng lệnh con; ` *` ở cuối cũng khớp khi không có đối số.
 * - Read(glob) / Edit(glob) / Write(glob): đường dẫn. Path(glob) = cả đọc và ghi (riêng Pi).
 * - WebFetch(domain:host), mcp__server hoặc mcp__server__tool, tên tool bất kỳ.
 * Luật deny bắt đầu bằng "!" là ngoại lệ: không deny khi ngoại lệ khớp.
 */
export interface Rule {
  raw: string;
  tool: string;
  spec?: string;
  negate: boolean;
}

export type RuleKind = "allow" | "ask" | "deny";

export interface RuleSet {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
  /** Luật allow bị bỏ khi ở auto mode vì cho phép chạy code tùy ý. */
  stripped: Rule[];
}

export function parseRule(raw: string): Rule | undefined {
  if (typeof raw !== "string") return undefined;
  let text = raw.trim();
  let negate = false;
  if (text.startsWith("!")) {
    negate = true;
    text = text.slice(1).trim();
  }
  const match = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/su.exec(text);
  if (!match) return undefined;
  return { raw, tool: match[1], spec: match[2]?.trim() || undefined, negate };
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "bg_run", "powershell"]);

/** Luật có áp dụng cho tool này không (tên Claude Code được ánh xạ sang tool Pi). */
export function ruleAppliesTo(rule: Rule, toolName: string): boolean {
  const tool = rule.tool.toLowerCase();
  const name = toolName.toLowerCase();
  switch (tool) {
    case "bash":
      return SHELL_TOOLS.has(name);
    case "read":
      return READ_TOOLS.has(name);
    case "edit":
    case "write":
    case "notebookedit":
      return WRITE_TOOLS.has(name);
    case "path":
      return READ_TOOLS.has(name) || WRITE_TOOLS.has(name);
    case "glob":
      return name === "find";
    case "webfetch":
      return name === "fetch_content";
    case "websearch":
      return name === "web_search";
    default:
      if (tool.startsWith("mcp__")) return name === tool || name.startsWith(`${tool}__`);
      return tool === name;
  }
}

/** Luật đường dẫn (Read/Edit/Write/Path) áp dụng cho đối số đường dẫn của lệnh shell. */
export function isPathRule(rule: Rule): boolean {
  return ["read", "edit", "write", "path", "notebookedit"].includes(rule.tool.toLowerCase()) && !!rule.spec;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
}

/** Glob đường dẫn: ** khớp mọi thứ kể cả /, * và ? không vượt qua /. */
function pathGlob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(ch);
    }
  }
  const flags = process.platform === "darwin" || process.platform === "win32" ? "iu" : "u";
  return new RegExp(`^${source}$`, flags);
}

const slashes = (value: string) => value.replaceAll("\\", "/");

/**
 * Khớp đường dẫn tuyệt đối với glob của luật.
 * ~/x: theo HOME; /x hoặc //x: tuyệt đối; không có / : so với tên file;
 * còn lại: tương đối với cwd (hoặc ở bất kỳ đâu nếu bắt đầu bằng ** /).
 */
export function matchPath(spec: string, file: string, cwd: string, home = os.homedir()): boolean {
  const candidates = new Set([slashes(path.resolve(file)), slashes(realPath(file))]);
  let pattern = spec.trim();
  if (!pattern) return false;
  if (pattern === "~" || pattern.startsWith("~/")) pattern = slashes(path.join(home, pattern.slice(2))) + (pattern.endsWith("/") ? "/" : "");
  else if (pattern.startsWith("//")) pattern = pattern.slice(1);
  if (pattern.endsWith("/")) pattern += "**";
  const regex = pathGlob(slashes(pattern));
  for (const candidate of candidates) {
    if (pattern.startsWith("/") || /^[A-Za-z]:\//u.test(pattern)) {
      if (regex.test(candidate)) return true;
    } else if (!pattern.includes("/")) {
      if (regex.test(path.posix.basename(candidate))) return true;
    } else if (pattern.startsWith("**/")) {
      if (regex.test(candidate) || regex.test(candidate.replace(/^\/+/u, ""))) return true;
    } else {
      const relative = slashes(path.relative(cwd, candidate));
      if (!relative.startsWith("..") && regex.test(relative)) return true;
    }
  }
  return false;
}

/** Glob lệnh bash: * khớp mọi ký tự; "cmd *" ở cuối cũng khớp "cmd"; hậu tố ":*" kiểu cũ = tiền tố. */
export function bashPattern(spec: string): RegExp {
  let pattern = spec.trim().replace(/\s+/gu, " ");
  let optionalTail = false;
  if (pattern.endsWith(":*")) {
    pattern = pattern.slice(0, -2);
    optionalTail = true;
  } else if (pattern.endsWith(" *")) {
    pattern = pattern.slice(0, -2);
    optionalTail = true;
  }
  const body = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${body}${optionalTail ? "(?: .*)?" : ""}$`, "su");
}

export function matchBash(spec: string | undefined, command: string): boolean {
  if (!spec || spec === "*") return true;
  return bashPattern(spec).test(command.trim().replace(/\s+/gu, " "));
}

/** Luật WebFetch(domain:host) khớp URL; domain:*.example.com khớp subdomain. */
export function matchDomain(spec: string, url: string): boolean {
  const match = /^domain:(.+)$/u.exec(spec.trim());
  if (!match) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const domain = match[1].toLowerCase();
  if (domain.startsWith("*.")) return host.endsWith(domain.slice(1)) || host === domain.slice(2);
  return host === domain;
}

// Tiền tố trình thông dịch và wrapper: luật allow dạng này cho phép chạy code tùy ý
// (danh sách theo cách Claude Code bỏ luật nguy hiểm khi vào auto mode).
const DANGEROUS_PREFIXES = [
  "python", "python3", "python2", "node", "deno", "tsx", "ts-node", "bun", "ruby", "perl", "php", "lua", "npx", "bunx",
  "npm run", "npm exec", "yarn run", "yarn dlx", "pnpm run", "pnpm exec", "pnpm dlx", "bun run", "bash", "sh", "zsh",
  "fish", "dash", "ssh", "eval", "exec", "env", "xargs", "sudo", "doas", "source", ".", "make", "just", "uv run",
  "uvx", "pipx run", "go run", "cargo run", "osascript", "open",
];
const ALWAYS_CLASSIFY_TOOLS = new Set(["agent", "subagentworkflow", "mcpscript", "bg_run_pi_attested"]);

/** Luật allow cho phép chạy code tùy ý hoặc bỏ qua bộ phân loại cho thao tác nhạy cảm. */
export function isDangerousAllow(rule: Rule): boolean {
  const tool = rule.tool.toLowerCase();
  if (ALWAYS_CLASSIFY_TOOLS.has(tool)) return true;
  if (tool !== "bash" && tool !== "bg_run" && tool !== "powershell") return false;
  const spec = rule.spec?.trim();
  if (!spec || /^[*\s]*$/u.test(spec)) return true;
  const normalized = spec.replace(/:\*$/u, " *").replace(/\s+/gu, " ");
  return DANGEROUS_PREFIXES.some((prefix) => {
    if (normalized === prefix || normalized === `${prefix}*` || normalized.startsWith(`${prefix} `) || normalized.startsWith(`${prefix}*`)) {
      // `python -m module` cụ thể vẫn là luật hẹp.
      return !/^python3? -m [A-Za-z0-9_.]+$/u.test(normalized);
    }
    return false;
  });
}

export function buildRuleSet(allow: string[], ask: string[], deny: string[]): RuleSet {
  const parse = (items: string[]) => items.map(parseRule).filter((rule): rule is Rule => !!rule);
  const allowRules = parse(allow);
  return {
    allow: allowRules.filter((rule) => !isDangerousAllow(rule)),
    ask: parse(ask),
    deny: parse(deny),
    stripped: allowRules.filter(isDangerousAllow),
  };
}

export interface RuleMatchTarget {
  toolName: string;
  /** Lệnh con (đã chuẩn hóa) khi tool là shell. */
  commands?: string[];
  /** Chuỗi lệnh gốc, để luật dạng *chuỗi* khớp cả trong cấu trúc phức tạp. */
  raw?: string;
  /** Đường dẫn tuyệt đối mà tool đọc hoặc ghi. */
  paths?: string[];
  /** Mọi URL mà tool nhận, từ cả url và urls. */
  urls?: string[];
  /** Lệnh shell có thể ghi (false khi đã chứng minh chỉ đọc). */
  writes?: boolean;
}

/** Luật có khớp với lời gọi tool này không. */
export function ruleMatches(rule: Rule, target: RuleMatchTarget, cwd: string, home = os.homedir()): boolean {
  if (isPathRule(rule)) {
    // Tool file theo tên (Read → đọc, Edit/Write → ghi, Path → cả hai). Tool khác có tham số
    // đường dẫn (shell, MCP, extension): Read/Path luôn áp dụng; Edit/Write trừ khi đã biết chỉ đọc.
    const name = target.toolName.toLowerCase();
    const writeRule = ["edit", "write", "notebookedit"].includes(rule.tool.toLowerCase());
    const fileTool = READ_TOOLS.has(name) || WRITE_TOOLS.has(name);
    const applies = fileTool ? ruleAppliesTo(rule, target.toolName) : !!target.paths?.length && (!writeRule || target.writes !== false);
    if (!applies) return false;
    return (target.paths ?? []).some((file) => matchPath(rule.spec as string, file, cwd, home));
  }
  if (!ruleAppliesTo(rule, target.toolName)) return false;
  if (!rule.spec) return true;
  const tool = rule.tool.toLowerCase();
  if (tool === "bash") {
    if ((target.commands ?? []).some((command) => matchBash(rule.spec, command))) return true;
    // Luật có * ở đầu (vd *firecrawl-key.cjs*) khớp cả chuỗi gốc để không lọt qua cấu trúc lồng.
    return !!target.raw && rule.spec.trim().startsWith("*") && matchBash(rule.spec, target.raw);
  }
  if (tool === "webfetch") return (target.urls ?? []).some((url) => matchDomain(rule.spec as string, url));
  return false;
}

/** Luật allow chỉ cho phép lệnh shell khi MỌI lệnh con đều khớp. */
export function allowCoversShell(rules: Rule[], commands: string[]): boolean {
  const shellRules = rules.filter((rule) => rule.tool.toLowerCase() === "bash" && !rule.negate);
  return commands.length > 0 && commands.every((command) => shellRules.some((rule) => matchBash(rule.spec, command)));
}

/**
 * Luật đầu tiên khớp trong danh sách. Ngoại lệ "!" được xét trên từng đơn vị
 * (từng đường dẫn, từng lệnh con, từng URL) để `cat .env.example .env` vẫn bị deny vì .env.
 */
export function firstMatch(rules: Rule[], target: RuleMatchTarget, cwd: string, home = os.homedir()): Rule | undefined {
  const positives = rules.filter((rule) => !rule.negate);
  const exceptions = rules.filter((rule) => rule.negate);
  const pick = (unit: RuleMatchTarget, pathRules: boolean) => {
    const hit = positives.find((rule) => isPathRule(rule) === pathRules && ruleMatches(rule, unit, cwd, home));
    if (!hit) return undefined;
    return exceptions.some((rule) => isPathRule(rule) === pathRules && ruleMatches(rule, unit, cwd, home)) ? undefined : hit;
  };
  for (const file of target.paths ?? []) {
    const hit = pick({ toolName: target.toolName, paths: [file], writes: target.writes }, true);
    if (hit) return hit;
  }
  const units: RuleMatchTarget[] = (target.commands ?? []).map((command) => ({ toolName: target.toolName, commands: [command] }));
  if (target.raw) units.push({ toolName: target.toolName, raw: target.raw });
  for (const url of target.urls ?? []) units.push({ toolName: target.toolName, urls: [url] });
  if (!units.length) units.push({ toolName: target.toolName });
  for (const unit of units) {
    const hit = pick(unit, false);
    if (hit) return hit;
  }
  return undefined;
}
