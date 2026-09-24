import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[  -   　]/gu;

/** Cùng quy tắc resolveToCwd của tool read/write/edit của Pi: bỏ @, mở rộng ~, file://, khoảng trắng Unicode. */
export function resolveToolPath(input: unknown, cwd: string, home = os.homedir()): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  let value = input.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (process.platform === "win32") {
    const drive = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
    if (drive && !value.startsWith("//")) value = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (value === "~") value = home;
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) value = path.join(home, value.slice(2));
  else if (value.startsWith("file://")) value = fileURLToPath(value);
  return path.resolve(cwd, value);
}

/** Đối số của lệnh shell thành đường dẫn tuyệt đối (chỉ ~ và đường dẫn tương đối; shell không hiểu @). */
export function resolveShellPath(word: string, cwd: string, home = os.homedir()): string {
  if (word === "~") return home;
  if (word.startsWith("~/")) return path.join(home, word.slice(2));
  return path.resolve(cwd, word);
}

/**
 * Đường dẫn thật: realpath của tổ tiên gần nhất còn tồn tại + phần còn lại.
 * Nhờ vậy symlink trỏ ra ngoài workspace không lọt qua kiểm tra "nằm trong".
 */
export function realPath(file: string): string {
  let current = path.resolve(file);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest.reverse());
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function caseFold(value: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;
}

/** file nằm trong (hoặc là) dir. */
export function isInside(dir: string, file: string): boolean {
  const relative = path.relative(caseFold(dir), caseFold(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Thư mục tạm của hệ thống (thêm /tmp ngoài Windows). */
export function temporaryRoots(): string[] {
  return [...new Set([os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])])];
}

/**
 * Đường dẫn thật của file nằm hẳn bên trong (strict) hoặc là đường dẫn thật của một thư mục tạm.
 * Symlink trong thư mục tạm trỏ ra ngoài thì không tính.
 */
export function insideTemporary(file: string, temp: string[], strict = true): boolean {
  const real = caseFold(realPath(file));
  return temp.some((dir) => {
    const root = caseFold(realPath(dir));
    return (!strict || real !== root) && isInside(root, real);
  });
}

/** Nằm trong một trong các thư mục gốc; so cả đường dẫn logic lẫn đường dẫn thật. */
export function insideAny(roots: string[], file: string): boolean {
  const resolved = path.resolve(file);
  const real = realPath(resolved);
  return roots.some((root) => isInside(root, resolved) && isInside(realPath(root), real));
}

// Thư mục và file mà việc ghi có thể chạy code về sau, đổi quyền hoặc cấu hình công cụ
// (tham khảo danh sách protected paths của Claude Code và .git/.agents/.codex của Codex).
const PROTECTED_DIRS = new Set([
  ".git", ".pi", ".claude", ".codex", ".agents", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer",
  ".yarn", ".mvn", ".github", ".circleci", ".gitlab",
]);
const PROTECTED_FILES = new Set([
  ".gitconfig", ".gitmodules", ".gitattributes", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
  ".bash_aliases", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".envrc",
  ".ripgreprc", ".mcp.json", ".claude.json", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs",
  ".pnpmfile.cjs", "bunfig.toml", ".bunfig.toml", ".bazelrc", ".pre-commit-config.yaml", "lefthook.yml",
  ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml", ".gitlab-ci.yml", "gradle-wrapper.properties",
  "maven-wrapper.properties", ".devcontainer.json", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md",
  "CLAUDE.local.md", ".pypirc", ".netrc",
]);

/** Lý do đường dẫn được bảo vệ (ghi vào đây phải qua bộ phân loại), hoặc undefined. */
export function protectedReason(file: string, roots: string[]): string | undefined {
  const candidates = [path.resolve(file), realPath(file)];
  for (const candidate of candidates) {
    const base = path.basename(candidate);
    if (PROTECTED_FILES.has(base)) return `${base} is a protected file`;
    // Chỉ xét các thành phần nằm trong workspace, để workspace nằm dưới ~/.config... vẫn dùng được.
    const root = roots.find((item) => isInside(item, candidate) || isInside(realPath(item), candidate));
    const relative = root ? path.relative(isInside(root, candidate) ? root : realPath(root), candidate) : candidate;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      if (PROTECTED_DIRS.has(segment)) return `${segment}/ is a protected directory`;
    }
  }
  return undefined;
}

/** File cấu hình của chính cổng permission: chỉ người dùng được sửa khi ở auto mode. */
export function isSelfProtected(file: string, selfPaths: string[]): boolean {
  const resolved = path.resolve(file);
  const real = realPath(resolved);
  return selfPaths.some((item) => {
    const target = path.resolve(item);
    return isInside(target, resolved) || isInside(realPath(target), real);
  });
}

/**
 * Đường dẫn quan trọng cho rm/rmdir (giống Claude Code): /, thư mục con trực tiếp của /,
 * HOME và con trực tiếp của HOME, thư mục làm việc và các thư mục cha của nó.
 */
export function criticalPathReason(target: string, cwd: string, home = os.homedir()): string | undefined {
  const resolved = path.resolve(target);
  const real = realPath(resolved);
  for (const candidate of new Set([resolved, real])) {
    const parent = path.dirname(candidate);
    if (candidate === path.parse(candidate).root) return "the filesystem root";
    if (parent === path.parse(candidate).root) return `a top-level directory (${candidate})`;
    if (isInside(candidate, home)) return candidate === home ? "the home directory" : `a parent of the home directory (${candidate})`;
    if (path.dirname(candidate) === home) return `a top-level folder of the home directory (${candidate})`;
    if (isInside(candidate, cwd)) return candidate === path.resolve(cwd) ? "the working directory" : `a parent of the working directory (${candidate})`;
  }
  return undefined;
}
