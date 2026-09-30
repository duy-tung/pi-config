import fs from "node:fs";
import path from "node:path";
import { resolveShellPath } from "./paths.ts";
import { commandName, type ShellAnalysis, type SimpleCommand } from "./shell.ts";

const SEARCH = new Set(["grep", "egrep", "fgrep", "rg"]);

interface SearchPaths {
  paths: string[];
  recursive: boolean;
  /** rg --files: chỉ liệt kê tên file, không đọc nội dung. */
  filesOnly: boolean;
}

/**
 * Chỉ nhận cú pháp tìm kiếm đã biết để chứng minh đích là từng file cụ thể.
 * Cờ lạ/viết tắt mơ hồ không được đoán; include/exclude không chứng minh một thư mục an toàn.
 */
export function searchReadPaths(command: SimpleCommand): SearchPaths | undefined {
  const name = commandName(command);
  if (!SEARCH.has(name)) return undefined;
  const rg = name === "rg";
  const shortFlags = rg ? "0123456789aAbcEFhHiIlLMnNoPpqSsTuUvVwWxz" : "abcEFGHhIiLlnoPqRrsUVvwxZz";
  const shortValues = rg ? "ABCEefgMjmtTr" : "ABCDdefm";
  const longFlags = rg
    ? ["--text", "--byte-offset", "--count", "--count-matches", "--fixed-strings", "--heading", "--no-heading",
      "--with-filename", "--no-filename", "--ignore-case", "--case-sensitive", "--smart-case", "--files-with-matches",
      "--files-without-match", "--line-number", "--no-line-number", "--only-matching", "--pcre2", "--quiet", "--invert-match",
      "--word-regexp", "--line-regexp", "--hidden", "--no-ignore", "--no-ignore-vcs", "--no-ignore-parent", "--no-ignore-dot",
      "--follow", "--multiline", "--multiline-dotall", "--null", "--null-data", "--files", "--no-config", "--json"]
    : ["--text", "--byte-offset", "--count", "--extended-regexp", "--fixed-strings", "--basic-regexp", "--with-filename",
      "--no-filename", "--ignore-case", "--files-with-matches", "--files-without-match", "--line-number", "--only-matching",
      "--perl-regexp", "--quiet", "--silent", "--recursive", "--dereference-recursive", "--no-messages", "--invert-match",
      "--word-regexp", "--line-regexp", "--null", "--null-data", "--line-buffered", "--binary", "--unix-byte-offsets"];
  const longValues = rg
    ? ["--after-context", "--before-context", "--context", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not",
      "--max-count", "--max-columns", "--max-depth", "--threads", "--replace", "--encoding", "--color", "--colors", "--sort", "--sortr"]
    : ["--after-context", "--before-context", "--context", "--devices", "--directories", "--regexp", "--file", "--max-count",
      "--include", "--exclude", "--exclude-dir", "--exclude-from", "--binary-files", "--label", "--color", "--colour"];
  const operands: string[] = [];
  const paths: string[] = [];
  let pattern = false;
  let recursive = rg;
  let filesOnly = false;
  let options = true;
  const use = (option: string, value?: string) => {
    if (option === "e" || option === "--regexp") pattern = true;
    if (option === "f" || option === "--file") {
      pattern = true;
      paths.push(value as string);
    }
    if (option === "--exclude-from") paths.push(value as string);
    if (option === "--files") filesOnly = true;
    if (!rg && ["r", "R", "--recursive", "--dereference-recursive"].includes(option)) recursive = true;
    if (!rg && (option === "d" || option === "--directories")) recursive ||= value === "recurse";
  };
  const args = command.words.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") { options = false; continue; }
    if (!options || arg === "-" || !arg.startsWith("-")) { operands.push(arg); continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq < 0 ? arg : arg.slice(0, eq);
      const names = [...longFlags, ...longValues];
      // GNU grep nhận tiền tố duy nhất; rg không nhận viết tắt.
      const matches = names.includes(key) ? [key] : names.filter((item) => !rg && item.startsWith(key));
      if (matches.length !== 1) return undefined;
      const option = matches[0];
      const takesValue = longValues.includes(option);
      if (!takesValue && eq >= 0) return undefined;
      // GNU/BSD grep khác nhau ở đối số tùy chọn của context; color/colour cũng có giá trị tùy ý.
      // Không nuốt regexp kế tiếp rồi vô tình bỏ thư mục đầu tiên khỏi tập đích.
      if (!rg && eq < 0 && ["--context", "--color", "--colour"].includes(option)) return undefined;
      const value = takesValue ? (eq < 0 ? args[++i] : arg.slice(eq + 1)) : undefined;
      if (takesValue && value === undefined) return undefined;
      use(option, value);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const option = arg[j];
      if (shortValues.includes(option)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (value === undefined) return undefined;
        use(option, value);
        break;
      }
      if (!shortFlags.includes(option)) return undefined;
      use(option);
    }
  }
  if (!pattern && !filesOnly) {
    if (!operands.length) return undefined;
    operands.shift(); // regexp đứng trước danh sách file
  }
  // grep thường đọc stdin; grep -r và rg không có đích sẽ duyệt cwd.
  paths.push(...(operands.length ? operands : recursive ? ["."] : []));
  return { paths: paths.filter((file) => file !== "-"), recursive, filesOnly };
}

/** Không đọc nội dung; chỉ file thường mới chứng minh được không duyệt cây thư mục. */
export function isRegularFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Trả về luật deny (chuỗi gốc) chặn đọc file này, kể cả ngoại lệ !Path; undefined = được đọc. */
export type DeniedPath = (file: string) => string | undefined;

export interface PathScope {
  /** Bằng chứng: file có thật khớp luật deny mà lệnh sẽ đọc. */
  evidence?: { file: string; rule: string };
  /** Không kiểm được tập file lệnh sẽ đọc (biến, script, cây quá lớn...). */
  uncertain?: string;
}

const WALK_LIMIT = 50_000;
const WALK_MS = 500;
// Lệnh không đọc nội dung file từ đối số: tham số chưa biết của chúng không làm lộ file bị deny.
const NO_READ = new Set([
  "echo", "printf", "true", "false", ":", "pwd", "sleep", "date", "whoami", "id", "uname", "hostname", "exit", "return",
  "export", "unset", "set", "shift", "local", "declare", "typeset", "readonly", "test", "[", "which", "type", "basename",
  "dirname", "seq", "yes", "cd", "pushd", "popd", "mkdir", "touch", "rmdir", "wait", "trap", "kill",
]);
// Chỉ liệt kê tên/kích thước, không đọc nội dung: không cần duyệt cây để kiểm luật đọc.
const NAMES_ONLY = new Set(["find", "tree", "du", "ls"]);
// Đọc nội dung cả cây thư mục khi nhận thư mục làm đối số.
const ARCHIVERS = new Set(["tar", "bsdtar", "gtar", "zip", "7z", "7za", "jar", "cpio", "pax"]);
const COPIERS = new Set(["cp", "rsync", "scp"]);
const isRecursiveCopy = (arg: string) =>
  /^-[^-]*[rRa]/u.test(arg) || ["--recursive", "--archive"].includes(arg);
const FIND_ACTIONS = /^-(?:exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/u;
const LOOP_KEYWORDS = new Set(["for", "select"]);
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time"]);

function denies(file: string, denied: DeniedPath, link = true): { file: string; rule: string } | undefined {
  const rule = denied(file);
  if (rule) return { file, rule };
  if (!link) return undefined;
  // Symlink tới file bị deny cũng bị deny: kiểm cả đích thật.
  try {
    const real = fs.realpathSync.native(file);
    const hit = real !== file ? denied(real) : undefined;
    if (hit) return { file, rule: hit };
  } catch { /* không tồn tại */ }
  return undefined;
}

/**
 * Duyệt cây (không theo symlink thư mục) tìm file khớp luật deny. Giới hạn số mục và thời gian;
 * vượt giới hạn thì không kết luận được. skipHidden: rg mặc định bỏ file/thư mục ẩn.
 */
export function findDenied(root: string, denied: DeniedPath, skipHidden = false): PathScope {
  const started = Date.now();
  const first = denies(root, denied);
  if (first) return { evidence: first };
  const queue = [root];
  let seen = 0;
  while (queue.length) {
    const dir = queue.shift() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > WALK_LIMIT || Date.now() - started > WALK_MS) {
        return { uncertain: `the directory ${root} is too large to check against the path deny rules` };
      }
      if (entry.name === ".git" || (skipHidden && entry.name.startsWith("."))) continue;
      const file = path.join(dir, entry.name);
      const hit = denies(file, denied, entry.isSymbolicLink());
      if (hit) return { evidence: hit };
      if (entry.isDirectory()) queue.push(file);
    }
  }
  return {};
}

function globRegex(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end < 0) source += "\\[";
      else {
        const body = segment.slice(i + 1, end).replace(/^!/u, "^").replace(/\\/gu, "\\\\");
        source += `[${body}]`;
        i = end;
      }
    } else source += ch.replace(/[.+^${}()|\\/]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/**
 * Mở rộng glob như bash mặc định (không dotglob, ** như *), trên hệ file hiện tại.
 * undefined = quá nhiều mục để kiểm.
 */
export function expandGlob(word: string, cwd: string, home: string): string[] | undefined {
  const absolute = resolveShellPath(word, cwd, home);
  const { root } = path.parse(absolute);
  const segments = absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean);
  let current = [root];
  let seen = 0;
  for (const segment of segments) {
    const next: string[] = [];
    if (!/[*?[]/u.test(segment)) {
      for (const dir of current) next.push(path.join(dir, segment));
    } else {
      const pattern = globRegex(segment);
      for (const dir of current) {
        let names: string[];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (++seen > WALK_LIMIT) return undefined;
          if (name.startsWith(".") && !segment.startsWith(".")) continue;
          if (pattern.test(name)) next.push(path.join(dir, name));
        }
      }
    }
    current = next;
  }
  return current;
}

function checkGlob(word: string, cwd: string, home: string, denied: DeniedPath): PathScope {
  const files = expandGlob(word, cwd, home);
  if (!files) return { uncertain: `the glob ${word} matches too many files to check` };
  for (const file of files) {
    const hit = denies(file, denied);
    if (hit) return { evidence: hit };
  }
  return {};
}

/**
 * Thư mục mà lệnh chuyển tới trước khi đọc: cd/pushd, env -C/--chdir, git -C.
 * undefined = không đổi; null = đích không phải chữ thuần.
 */
function directoryChange(command: SimpleCommand, home: string): string | null | undefined {
  const name = commandName(command);
  const words = command.words;
  const literal = (index: number) => command.literal[index] && !command.glob[index] ? words[index] : null;
  if (name === "cd" || name === "pushd") {
    const index = words.findIndex((word, i) => i > 0 && !word.startsWith("-"));
    return index < 0 ? home : literal(index);
  }
  if (name === "tar" || name === "bsdtar" || name === "gtar") {
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "-C" || words[i] === "--directory") return i + 1 < words.length ? literal(i + 1) : undefined;
      if (words[i].startsWith("--directory=")) return command.literal[i] ? words[i].slice("--directory=".length) : null;
    }
    return undefined;
  }
  if (name === "env" || name === "git") {
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "-C" || (name === "env" && words[i] === "--chdir")) return i + 1 < words.length ? literal(i + 1) : undefined;
      if (name === "env" && words[i].startsWith("--chdir=")) return command.literal[i] ? words[i].slice("--chdir=".length) : null;
      if (name === "env" && /^-C./u.test(words[i])) return command.literal[i] ? words[i].slice(2) : null;
      if (!words[i].startsWith("-")) break;
    }
  }
  return undefined;
}

/** rg có đọc file/thư mục ẩn không: --hidden, --no-ignore*, -u/-uu/-uuu, -. (kể cả trong cụm cờ ngắn). */
function rgSearchesHidden(arg: string): boolean {
  if (arg === "--hidden" || arg.startsWith("--no-ignore") || arg === "--unrestricted") return true;
  if (!/^-[^-]/u.test(arg)) return false;
  for (const flag of arg.slice(1)) {
    if (flag === "u" || flag === ".") return true;
    if ("ABCEefgMjmtTr".includes(flag)) return false; // phần còn lại là giá trị của cờ
  }
  return false;
}

/** Đối số chữ thuần (không glob) có thể là đường dẫn: từ, giá trị --opt=, @file, đích chuyển hướng, phần sau ":". */
function literalOperands(command: SimpleCommand): string[] {
  const words = new Set<string>();
  const add = (value: string) => {
    if (!value || /[\r\n]/u.test(value) || /^[a-z][a-z0-9+.-]+:\/\//iu.test(value)) return;
    words.add(value);
    const colon = value.indexOf(":");
    if (colon > 0 && colon < value.length - 1 && !/^[A-Za-z]:[\\/]/u.test(value)) words.add(value.slice(colon + 1));
  };
  command.words.forEach((word, index) => {
    if (index === 0 || command.glob[index]) return;
    let value = word.startsWith("@") ? word.slice(1) : word;
    if (value.startsWith("-")) {
      const eq = value.indexOf("=");
      if (eq < 0) return;
      value = value.slice(eq + 1).replace(/^@/u, "");
    }
    add(value);
  });
  for (const redirect of command.redirects) if (!redirect.glob && !/^\d+$|^-$/u.test(redirect.target)) add(redirect.target);
  return [...words];
}

/** Bỏ từ khoá điều khiển đứng đầu (if, do, then...) để lấy lệnh thật. */
function stripKeywords(command: SimpleCommand): SimpleCommand {
  let start = 0;
  while (start < command.words.length && command.literal[start] && SHELL_KEYWORDS.has(command.words[start])) start++;
  return start ? { ...command, words: command.words.slice(start), literal: command.literal.slice(start), glob: command.glob.slice(start) } : command;
}

/**
 * Kiểm luật deny đường dẫn cho một chuỗi lệnh shell. Chỉ trả bằng chứng khi thấy file thật khớp luật;
 * đường dẫn chữ thuần đã được kiểm ở luật deny thường. Chỗ không kiểm được trả "uncertain" để
 * auto mode giao bộ phân loại, bypass hỏi người dùng. Đây là kiểm theo argv, không phải sandbox:
 * chương trình tuỳ ý (node, python...) vẫn có thể tự mở file.
 */
export function shellPathScope(analysis: ShellAnalysis, cwd: string, home: string, denied: DeniedPath): PathScope {
  for (const problem of ["brace expansion", "unterminated quote", "unterminated command substitution", "nesting too deep"]) {
    if (analysis.problems.includes(problem)) return { uncertain: `shell ${problem} has no verified set of paths` };
  }
  // cd chữ thuần: đường dẫn tương đối có thể tính từ cwd hoặc từ bất kỳ thư mục đã cd tới (xét mọi khả năng).
  const dirs = [cwd];
  for (const command of analysis.commands.map(stripKeywords)) {
    const target = directoryChange(command, home);
    if (target === undefined) continue;
    if (target === null) return { uncertain: "the command changes to a directory known only at run time" };
    for (const dir of [...dirs]) dirs.push(resolveShellPath(target, dir, home));
  }
  const uncertain: string[] = [];
  const merge = (scope: PathScope) => {
    if (scope.uncertain) uncertain.push(scope.uncertain);
    return scope.evidence;
  };
  for (const raw of analysis.commands) {
    const loop = raw.words[0] !== undefined && raw.literal[0] && LOOP_KEYWORDS.has(raw.words[0]);
    if (loop) {
      // for x in a b c: danh sách là đường dẫn tiềm năng; bản thân vòng lặp không đọc file.
      const list = raw.words.indexOf("in");
      for (let i = list < 0 ? raw.words.length : list + 1; i < raw.words.length; i++) {
        if (!raw.glob[i]) continue;
        for (const dir of dirs) {
          const hit = merge(checkGlob(raw.words[i], dir, home, denied));
          if (hit) return { evidence: hit };
        }
      }
      continue;
    }
    const command = stripKeywords(raw);
    if (!command.words.length) continue;
    const name = commandName(command);
    if (!command.literal[0]) { uncertain.push("the command name is known only at run time"); continue; }
    if (NO_READ.has(name)) continue;
    if (command.wrapped === "xargs") { uncertain.push(`xargs passes ${name} arguments read at run time`); continue; }
    const args = command.words.slice(1);
    if (command.literal.slice(1).some((value) => !value) || command.redirects.some((redirect) => !redirect.literal)) {
      uncertain.push(`${name} has an argument known only at run time`);
      continue;
    }
    // Chữ thuần: luật deny thường chỉ xét theo cwd; ở đây xét theo mọi thư mục mà cd/env -C/git -C có thể chuyển tới,
    // và phần đường dẫn của dạng <rev>:<path> (git show HEAD:.env) hoặc <host>:<path>.
    for (const word of literalOperands(command)) for (const dir of dirs) {
      const hit = denies(resolveShellPath(word, dir, home), denied);
      if (hit) return { evidence: hit };
    }
    const globs = [
      ...command.words.filter((_, index) => index > 0 && command.glob[index]),
      ...command.redirects.filter((redirect) => redirect.glob).map((redirect) => redirect.target),
    ];
    for (const word of globs) for (const dir of dirs) {
      const hit = merge(checkGlob(word, dir, home, denied));
      if (hit) return { evidence: hit };
    }
    if (NAMES_ONLY.has(name)) {
      if (name === "find" && args.some((arg) => FIND_ACTIONS.test(arg))) uncertain.push("find runs a command on the files it finds");
      continue;
    }
    // Danh sách tên file đến từ file/stdin không phải các đích đã kiểm trong argv.
    if (["sort", "wc"].includes(name) && args.some((arg) => {
      const key = arg.split("=", 1)[0];
      return key.length > 2 && "--files0-from".startsWith(key);
    })) { uncertain.push(`${name} reads an indirect list of paths`); continue; }
    // Lệnh đọc nội dung cả cây: duyệt thư mục tìm file bị deny.
    let trees: string[] = [];
    let skipHidden = false;
    if (SEARCH.has(name)) {
      const search = searchReadPaths(command);
      if (!search) { uncertain.push(`${name} uses options that are not recognized`); continue; }
      if (search.recursive && !search.filesOnly) trees = search.paths;
      skipHidden = name === "rg" && !args.some(rgSearchesHidden);
    } else if (name === "git" && args.includes("grep")) {
      trees = ["."];
    } else if (ARCHIVERS.has(name) || (COPIERS.has(name) && args.some(isRecursiveCopy))) {
      // Đóng gói hoặc sao chép cả cây: nội dung file bên dưới rời khỏi chỗ cũ. Đích cuối của cp/rsync/scp chỉ bị ghi.
      const operands = args.filter((arg) => !arg.startsWith("-"));
      trees = COPIERS.has(name) ? operands.slice(0, -1) : operands;
    } else if (name === "diff") {
      if (args.some((arg) => {
        const key = arg.split("=", 1)[0];
        return key.length > 2 && ["--from-file", "--to-file"].some((flag) => flag.startsWith(key));
      })) { uncertain.push("diff uses indirect file operands"); continue; }
      const end = args.indexOf("--");
      trees = end < 0 ? args.filter((arg) => !arg.startsWith("-")) : [...args.slice(0, end).filter((arg) => !arg.startsWith("-")), ...args.slice(end + 1)];
    }
    for (const tree of trees) for (const dir of dirs) {
      const file = resolveShellPath(tree, dir, home);
      if (!fs.existsSync(file) || isRegularFile(file)) continue;
      const hit = merge(findDenied(file, denied, skipHidden));
      if (hit) return { evidence: hit };
    }
  }
  return uncertain.length ? { uncertain: [...new Set(uncertain)].join("; ") } : {};
}
