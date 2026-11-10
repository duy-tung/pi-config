import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Chuỗi bắt đầu bằng scheme URL (`https://`, `git+ssh://`); scheme ít nhất hai ký tự nên `C://` vẫn là đường dẫn. */
export const URL_LIKE = /^[a-z][a-z0-9+.-]+:\/\//iu;

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

function currentUser(): string | undefined {
  try { return os.userInfo().username; } catch { return undefined; }
}

/**
 * Như path.resolve, nhưng `..` đứng sau một symlink đi lên từ đích của symlink: kernel làm vậy khi một lệnh mở file
 * (`cat link/../x` đọc file cạnh đích của link, không phải ./x). Thành phần chưa tồn tại thì đi lên theo chữ.
 */
function physical(base: string, value: string): string {
  const separators = process.platform === "win32" ? /[\\/]+/u : /\/+/u;
  if (!value.split(separators).includes("..")) return path.resolve(base, value);
  const root = path.isAbsolute(value) ? path.parse(value).root : "";
  let current = root ? path.resolve(root) : path.resolve(base);
  for (const part of value.slice(root.length).split(separators)) {
    if (part === "" || part === ".") continue;
    if (part !== "..") {
      current = path.join(current, part);
      continue;
    }
    let real = current;
    try { real = fs.realpathSync.native(current); } catch { /* chưa tồn tại */ }
    current = path.dirname(real);
  }
  return current;
}

/**
 * Đối số của lệnh shell thành đường dẫn tuyệt đối (~, ~+, ~user và đường dẫn tương đối; shell không hiểu @).
 * ~user của chính người dùng là home; user khác đoán theo thư mục cha của home (root: /root, macOS /var/root),
 * đủ để coi là ngoài workspace. `logical`: tính `..` theo chữ như `cd` của shell (mặc định theo symlink như khi mở file).
 */
export function resolveShellPath(word: string, cwd: string, home = os.homedir(), logical = false): string {
  const join = logical ? path.resolve : physical;
  // `~//x` là $HOME//x: phần sau dấu ngã luôn tương đối với home.
  const below = (prefix: number) => word.slice(prefix).replace(/^\/+/u, "");
  if (word === "~") return home;
  if (word.startsWith("~/")) return join(home, below(2));
  // ~+ là thư mục hiện tại ($PWD).
  if (word === "~+") return path.resolve(cwd);
  if (word.startsWith("~+/")) return join(cwd, below(3));
  const tilde = /^~([A-Za-z0-9._][A-Za-z0-9._-]*)(?:\/(.*))?$/u.exec(word);
  if (tilde) {
    const name = tilde[1];
    const base = name === currentUser() ? home
      : name === "root" && process.platform !== "win32" ? (process.platform === "darwin" ? "/var/root" : "/root")
      : path.join(path.dirname(home), name);
    return tilde[2] ? path.join(base, tilde[2]) : base;
  }
  return join(cwd, word);
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

// Thư mục và file mà việc ghi có thể chạy code về sau, đổi quyền hoặc cấu hình công cụ: danh sách protected paths của
// Claude Code. `.pi` và `.agents` (pi-subagents nạp vai từ đó) là cấu hình của Pi, như `.claude` của Claude Code.
const PROTECTED_DIRS = new Set([
  ".git", ".pi", ".agents", ".claude", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn",
]);
/** Thư mục được bảo vệ gồm hai cấp (`.config/git`). */
const PROTECTED_NESTED = [[".config", "git"]];
const PROTECTED_FILES = new Set([
  ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile",
  ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs",
  ".pnp.loader.mjs", ".pnpmfile.cjs", "bunfig.toml", ".bunfig.toml", ".bazelrc", ".bazelversion", ".bazeliskrc",
  ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml", "gradle-wrapper.properties",
  "maven-wrapper.properties", ".devcontainer.json", ".ripgreprc", "pyrightconfig.json", ".mcp.json", ".claude.json",
]);

/** Lý do đường dẫn được bảo vệ (ghi vào đây phải qua bộ phân loại), hoặc undefined. */
export function protectedReason(file: string, roots: string[]): string | undefined {
  const candidates = [path.resolve(file), realPath(file)];
  for (const candidate of candidates) {
    // Không phân biệt hoa thường như Claude Code: trên macOS và Windows `.GIT/config` là `.git/config`.
    const base = path.basename(candidate).toLowerCase();
    if (PROTECTED_FILES.has(base)) return `${base} is a protected file`;
    // Chỉ xét các thành phần nằm trong workspace, để workspace nằm dưới ~/.config... vẫn dùng được.
    const root = roots.find((item) => isInside(item, candidate) || isInside(realPath(item), candidate));
    const relative = root ? path.relative(isInside(root, candidate) ? root : realPath(root), candidate) : candidate;
    // Cả thành phần cuối: `mv staging .git` hay file tên `.git` (gitfile) đặt nguyên một thư mục được bảo vệ.
    const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
    for (const [index, segment] of segments.entries()) {
      if (PROTECTED_DIRS.has(segment)) return `${segment}/ is a protected directory`;
      const nested = PROTECTED_NESTED.find(([first, second]) => segment === first && segments[index + 1] === second);
      if (nested) return `${nested.join("/")}/ is a protected directory`;
    }
  }
  return undefined;
}

/**
 * git tìm repo từ dir đi lên: thư mục có HEAD, objects/ và refs/ là một repo bare, và git chạy lệnh trong config của nó
 * (core.fsmonitor, pager…). Trả thư mục đó nếu git gặp nó trước một `.git`: agent dựng được bằng các file thường.
 */
export function bareRepositoryAbove(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return undefined;
    if (["HEAD", "objects", "refs"].every((name) => fs.existsSync(path.join(current, name)))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Đường dẫn chứa một file cấu hình của cổng permission (thư mục cha của nó): đổi tên hay xoá là đổi cả cấu hình. */
export function containsSelfProtected(file: string, selfPaths: string[]): boolean {
  const resolved = path.resolve(file);
  const real = realPath(resolved);
  return selfPaths.some((item) => {
    const target = path.resolve(item);
    return isInside(resolved, target) || isInside(real, realPath(target));
  });
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
 * Đường dẫn quan trọng cho rm/rmdir (giống Claude Code): /, thư mục con trực tiếp của /, HOME (và thư mục cha của nó),
 * thư mục làm việc và các thư mục cha của nó.
 */
export function criticalPathReason(target: string, cwd: string, home = os.homedir()): string | undefined {
  const resolved = path.resolve(target);
  const real = realPath(resolved);
  for (const candidate of new Set([resolved, real])) {
    const parent = path.dirname(candidate);
    if (candidate === path.parse(candidate).root) return "the filesystem root";
    if (parent === path.parse(candidate).root) return `a top-level directory (${candidate})`;
    if (isInside(candidate, home)) return candidate === home ? "the home directory" : `a parent of the home directory (${candidate})`;
    if (isInside(candidate, cwd)) return candidate === path.resolve(cwd) ? "the working directory" : `a parent of the working directory (${candidate})`;
  }
  return undefined;
}
