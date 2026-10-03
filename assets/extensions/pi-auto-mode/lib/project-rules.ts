import fs from "node:fs";
import path from "node:path";
import { isReadOnlyCommand, ruleUnits, type ShellAnalysis, type SimpleCommand } from "./shell.ts";

/**
 * Luật allow người dùng lưu bằng "Yes, and don't ask again" và thư mục lưu bằng /add-dir (như
 * `.claude/settings.local.json` của Claude Code): theo project (gốc repo, dùng chung cho mọi worktree), ngoài repo.
 * File `<stateDir>/project-rules.json` nằm trong thư mục trạng thái của cổng, nên agent không tự sửa được (selfPaths);
 * settings của project không được thêm luật allow (repo không được nới quyền).
 */

const FILE = "project-rules.json";

interface Project {
  allow: string[];
  /** Thư mục thêm bằng /add-dir → "remember for this project". */
  additionalDirectories?: string[];
}

interface Store {
  projects: Record<string, Project>;
}

/** Thư mục gần nhất chứa `.git` (thư mục, hoặc file của worktree/submodule); không có thì chính cwd. */
function nearestRepo(cwd: string): string {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

const roots = new Map<string, string>();

/**
 * Gốc project như Claude Code: gốc repo git, qua worktree về checkout chính (file `.git` của worktree trỏ tới
 * `<repo>/.git/worktrees/<tên>`); submodule giữ gốc riêng; không trong repo thì chính cwd. Không gọi git.
 */
export function projectRoot(cwd: string): string {
  const key = path.resolve(cwd);
  const cached = roots.get(key);
  if (cached) return cached;
  const repo = nearestRepo(key);
  let root = repo;
  try {
    const marker = path.join(repo, ".git");
    if (fs.statSync(marker).isFile()) {
      const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(fs.readFileSync(marker, "utf8"))?.[1];
      const resolved = gitdir ? path.resolve(repo, gitdir) : undefined;
      if (resolved && path.basename(path.dirname(resolved)) === "worktrees" && path.basename(path.dirname(path.dirname(resolved))) === ".git") {
        root = path.dirname(path.dirname(path.dirname(resolved)));
      }
    }
  } catch {
    /* không đọc được .git: dùng thư mục chứa nó */
  }
  roots.set(key, root);
  return root;
}

/** Khóa của project trong file: gốc mới, và gốc cũ (worktree/thư mục con) của bản trước để luật đã lưu vẫn dùng được. */
function projectKeys(cwd: string): string[] {
  return [...new Set([projectRoot(cwd), nearestRepo(cwd)])];
}

function read(stateDir: string): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), "utf8")) as Partial<Store>;
    const projects = parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {};
    return { projects: projects as Store["projects"] };
  } catch {
    return { projects: {} };
  }
}

function write(stateDir: string, store: Store): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

function collect(store: Store, cwd: string, field: keyof Project): string[] {
  return [...new Set(projectKeys(cwd).flatMap((key) => texts(store.projects[key]?.[field])))];
}

/** Luật allow đã lưu cho project của cwd. */
export function projectRules(stateDir: string, cwd: string): string[] {
  return collect(read(stateDir), cwd, "allow");
}

/** Thư mục đã lưu cho project của cwd bằng /add-dir. */
export function projectDirectories(stateDir: string, cwd: string): string[] {
  return collect(read(stateDir), cwd, "additionalDirectories");
}

/** Ghi lại project của cwd dưới gốc mới (gộp cả khóa cũ); project rỗng thì bỏ khỏi file. */
function update(stateDir: string, cwd: string, edit: (project: Project) => Project): Project {
  const store = read(stateDir);
  const current: Project = { allow: collect(store, cwd, "allow"), additionalDirectories: collect(store, cwd, "additionalDirectories") };
  const next = edit(current);
  for (const key of projectKeys(cwd)) delete store.projects[key];
  const additionalDirectories = next.additionalDirectories?.length ? next.additionalDirectories : undefined;
  if (next.allow.length || additionalDirectories) store.projects[projectRoot(cwd)] = { allow: next.allow, ...(additionalDirectories ? { additionalDirectories } : {}) };
  write(stateDir, store);
  return next;
}

/** Thêm luật cho project của cwd (bỏ trùng); trả danh sách mới. */
export function addProjectRules(stateDir: string, cwd: string, rules: string[]): string[] {
  return update(stateDir, cwd, (project) => ({ ...project, allow: [...new Set([...project.allow, ...rules])] })).allow;
}

/** Bỏ một luật của project. */
export function removeProjectRule(stateDir: string, cwd: string, rule: string): string[] {
  return update(stateDir, cwd, (project) => ({ ...project, allow: project.allow.filter((item) => item !== rule) })).allow;
}

/** Lưu thư mục cho project của cwd (/add-dir). */
export function addProjectDirectory(stateDir: string, cwd: string, dir: string): string[] {
  return update(stateDir, cwd, (project) => ({
    ...project, additionalDirectories: [...new Set([...(project.additionalDirectories ?? []), dir])],
  })).additionalDirectories ?? [];
}

/** Bỏ một thư mục đã lưu của project. */
export function removeProjectDirectory(stateDir: string, cwd: string, dir: string): string[] {
  return update(stateDir, cwd, (project) => ({
    ...project, additionalDirectories: (project.additionalDirectories ?? []).filter((item) => item !== dir),
  })).additionalDirectories ?? [];
}

const WORD = /^[A-Za-z0-9][\w.:@+-]*$/u;
const SUBCOMMAND = /^[a-z][a-z0-9:-]*$/u;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Công cụ có lệnh con: tiền tố gồm cả lệnh con (`git commit`, `docker compose`, `npm install`). */
const SUBCOMMAND_TOOLS = new Set([
  ...PACKAGE_MANAGERS, "git", "gh", "cargo", "go", "docker", "podman", "kubectl", "helm", "terraform", "pip", "pip3", "uv",
  "poetry", "brew", "apt", "apt-get", "dnf", "deno", "dotnet", "mvn", "gradle", "swift", "rustup", "aws", "gcloud", "az",
  "firebase", "vercel", "wrangler", "supabase", "turbo", "nx", "pnpx", "npx", "bunx",
]);
/**
 * Lệnh phá huỷ, đổi quyền, ra mạng hay trình thông dịch (tiền tố sẽ cho chạy code tùy ý): chỉ lưu đúng nguyên lệnh,
 * không lưu theo tiền tố.
 */
const EXACT_ONLY = new Set([
  "rm", "rmdir", "shred", "dd", "truncate", "mkfs", "chmod", "chown", "chgrp", "kill", "pkill", "killall", "curl", "wget",
  "ssh", "scp", "rsync", "nc", "sudo", "doas", "su", "python", "python3", "node", "ruby", "perl", "php", "bash", "sh", "zsh",
  "eval", "exec", "env", "xargs", "osascript", "open",
]);

/**
 * Tiền tố lệnh cho luật "don't ask again" (như Claude Code đề xuất `npm run test:*`): tên lệnh, thêm lệnh con với công
 * cụ có lệnh con (`git commit`, `docker compose`), và tên script với `npm/pnpm/yarn/bun run|exec`. Lệnh trong EXACT_ONLY
 * không có tiền tố (shellRules lưu nguyên lệnh). undefined khi lệnh không phải chữ thuần hoặc chạy chương trình theo đường dẫn.
 */
export function commandPrefix(command: SimpleCommand): string | undefined {
  const { words } = command;
  if (!words.length || command.assignments.length || command.redirects.length || command.wrapped) return undefined;
  if (!command.literal.every(Boolean) || command.glob.some(Boolean)) return undefined;
  if (!WORD.test(words[0]) || words[0].includes("/")) return undefined;
  if (EXACT_ONLY.has(words[0])) return undefined;
  const prefix = [words[0]];
  if (SUBCOMMAND_TOOLS.has(words[0]) && words[1] && SUBCOMMAND.test(words[1])) {
    prefix.push(words[1]);
    if (PACKAGE_MANAGERS.has(words[0]) && ["run", "exec", "run-script"].includes(words[1]) && words[2] && WORD.test(words[2])) prefix.push(words[2]);
  }
  return prefix.join(" ");
}

/** Luật đúng nguyên lệnh (chữ thuần, không chuyển hướng, không glob); undefined khi không tạo được. */
function exactRule(command: SimpleCommand): string | undefined {
  if (!command.words.length || command.assignments.length || command.redirects.length || command.wrapped) return undefined;
  if (!command.literal.every(Boolean) || command.glob.some(Boolean) || command.words[0].includes("/")) return undefined;
  const text = command.words.join(" ");
  return /[()*]/u.test(text) ? undefined : `Bash(${text})`;
}

/**
 * Luật lưu cho một lệnh shell: một luật `Bash(<tiền tố> *)` (lệnh phá huỷ/ra mạng: đúng nguyên lệnh) cho mỗi lệnh con không chỉ đọc (luật allow chỉ cho chạy
 * khi mọi lệnh con khớp). undefined khi không đề xuất được (cấu trúc shell không hiểu được, lệnh con không có tiền tố).
 */
export function shellRules(analysis: ShellAnalysis | undefined): string[] | undefined {
  if (!analysis?.plain) return undefined;
  // Như Claude Code: wrapper timeout/nice/nohup... bị bỏ, luật lưu cho lệnh bên trong.
  const commands = ruleUnits(analysis).filter((command) => !isReadOnlyCommand(command));
  if (!commands.length) return undefined;
  const rules = commands.map((command) => {
    const prefix = commandPrefix(command);
    return prefix ? `Bash(${prefix} *)` : EXACT_ONLY.has(command.words[0]) ? exactRule(command) : undefined;
  });
  if (rules.some((rule) => !rule)) return undefined;
  return [...new Set(rules as string[])];
}

/** Luật lưu cho fetch_content: `WebFetch(domain:<host>)` khi mọi URL cùng một host http(s). */
export function fetchRules(urls: string[] | undefined): string[] | undefined {
  const hosts = new Set<string>();
  for (const url of urls ?? []) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
      hosts.add(parsed.hostname.toLowerCase());
    } catch {
      return undefined;
    }
  }
  return hosts.size === 1 ? [`WebFetch(domain:${[...hosts][0]})`] : undefined;
}

/** Luật lưu cho web_search: cả tool, như `WebSearch` của Claude Code (lưu theo repo). */
export const WEB_SEARCH_RULE = "WebSearch";

/** Mô tả ngắn của các luật trong lựa chọn của hộp thoại: `npm test`, `git commit` hoặc domain. */
export function describeRules(rules: string[]): string {
  return rules.map((rule) => {
    const match = /^(\w+)\((.*)\)$/u.exec(rule);
    if (!match) return rule;
    return match[1] === "WebFetch" ? match[2].replace(/^domain:/u, "") : `${match[2].replace(/ \*$/u, "")}`;
  }).map((item) => `\`${item}\``).join(", ");
}
