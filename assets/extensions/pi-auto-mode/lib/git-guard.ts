import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realPath } from "./paths.ts";

/**
 * Guard git tất định, theo hooks/guard_git.py của tstack (cùng bảng ca kiểm thử), viết bằng built-in của Node.
 *
 * Chặn thao tác git làm mất việc, viết lại lịch sử chung, push thẳng lên nhánh được bảo vệ hoặc bỏ qua hook của
 * repo, cùng vài lệnh rm thảm hoạ; mọi thứ khác cho qua. Lệnh được tách như shell tách: nháy, escape, heredoc,
 * comment, pipeline, danh sách lệnh, subshell, thay thế lệnh và tiến trình, `bash -c`, `eval`, chữ được pipe hoặc
 * heredoc vào shell, và các wrapper phổ biến (sudo, env, timeout, nice, xargs, flock...). Chữ trong nháy, trong
 * heredoc có delimiter trong nháy hoặc trong comment là dữ liệu, không phải lệnh.
 *
 * Bộ tách lệnh riêng, không dùng lib/shell.ts: shell.ts cố ý bảo thủ cho lớp chính sách (cấu trúc lạ → bộ phân loại),
 * đọc thân heredoc như lệnh và bỏ toán tử giữa các lệnh, nên không phân biệt được `| bash` với `| grep` hay commit
 * message trong heredoc với lệnh thật. Guard cần đúng hai điều đó để vừa không chặn nhầm vừa không bỏ lọt.
 *
 * Nhánh được bảo vệ: autoMode.gitGuard.protectedBranches nếu có, không thì mặc định. Bật/tắt bằng autoMode.gitGuard
 * (lib/config.ts); bên gọi không gọi guard khi đã tắt.
 *
 * Đây là dây an toàn chống tai nạn, không phải sandbox: lỗi bất ngờ nào (kể cả lỗi của bộ phân tích) cũng cho qua.
 */

export type GitRunner = (args: string[], cwd: string) => string | undefined;

export interface GitGuardOptions {
  cwd: string;
  /** Môi trường của tiến trình Pi (HOME cho `~`); mặc định process.env. */
  env?: Record<string, string | undefined>;
  /** Danh sách nhánh được bảo vệ từ settings, thay danh sách mặc định. */
  protectedBranches?: string[];
  /** Chạy git trong một thư mục: stdout, hoặc undefined khi lỗi. Mặc định runGit. */
  git?: GitRunner;
}

export interface GitGuardBlock {
  reason: string;
  alternative: string;
  /** Lệnh bị chặn nằm trong backtick hoặc $(...): shell chạy nó thật. */
  substitution: boolean;
}

export const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "trunk", "develop", "production", "prod", "release", "release/*"];

const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

// Giá trị biến môi trường làm hook git thành no-op.
const BYPASS_ENV = new Map([["HUSKY", new Set(["0"])], ["HUSKY_SKIP_HOOKS", new Set(["1", "true"])], ["SKIP_HOOKS", new Set(["1", "true"])]]);
const HOOK_RUNNING = new Set(["commit", "push", "merge", "rebase", "am", "cherry-pick", "revert"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "coproc"]);
const CLAUSES = new Set(["for", "select", "case", "esac", "in"]);

// Wrapper: tùy chọn nhận giá trị ở từ riêng, và số từ vị trí bỏ qua trước lệnh được bọc.
const WRAPPERS = new Map<string, [Set<string>, number]>([
  ["sudo", [new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]), 0]],
  ["doas", [new Set(["-u", "-C"]), 0]],
  ["env", [new Set(["-u", "-C", "-S", "--unset", "--chdir"]), 0]],
  ["command", [new Set<string>(), 0]],
  ["builtin", [new Set<string>(), 0]],
  ["exec", [new Set(["-a"]), 0]],
  ["nohup", [new Set<string>(), 0]],
  ["time", [new Set(["-f", "-o", "--format", "--output"]), 0]],
  ["timeout", [new Set(["-s", "-k", "--signal", "--kill-after"]), 1]],
  ["nice", [new Set(["-n", "--adjustment"]), 0]],
  ["ionice", [new Set(["-c", "-n", "-p", "-P", "-u"]), 0]],
  ["stdbuf", [new Set(["-i", "-o", "-e"]), 0]],
  ["xargs", [new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--arg-file", "--delimiter",
    "--max-args", "--max-procs", "--max-lines", "--replace", "--eof", "--max-chars"]), 0]],
  ["watch", [new Set(["-n", "--interval", "-d"]), 0]],
  ["chronic", [new Set<string>(), 0]],
  ["caffeinate", [new Set(["-t", "-w"]), 0]],
  ["flock", [new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]), 1]],
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Chỗ giữ cho output chưa biết của một phép thay thế. */
const SUB = "\u0000sub\u0000";

class Blocked extends Error {
  reason: string;
  alternative: string;
  constructor(reason: string, alternative: string) {
    super(reason);
    this.reason = reason;
    this.alternative = alternative;
  }
}

function block(reason: string, alternative: string): never {
  throw new Blocked(reason, alternative);
}

/** Tên chương trình: phần sau "/" cuối cùng. */
const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

function partition(word: string): [string, string] {
  const eq = word.indexOf("=");
  return [word.slice(0, eq), word.slice(eq + 1)];
}

const homeDir = (env: Record<string, string | undefined>) => (env.HOME || os.homedir()).replace(/\/+$/u, "");

/** ~ và ~/… theo HOME của môi trường; ~tên giữ nguyên. */
function expandHome(value: string, env: Record<string, string | undefined>): string {
  return value === "~" || value.startsWith("~/") ? homeDir(env) + value.slice(1) || "/" : value;
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

const globs = new Map<string, RegExp>();

/** Khớp tên nhánh với mẫu: * khớp mọi chuỗi (kể cả "/"), ? một ký tự. */
function globMatch(name: string, pattern: string): boolean {
  let regex = globs.get(pattern);
  if (!regex) {
    const source = pattern.replace(/[\\^$.+()[\]{}|/]/gu, "\\$&").replaceAll("*", "[\\s\\S]*").replaceAll("?", "[\\s\\S]");
    globs.set(pattern, regex = new RegExp(`^${source}$`, "u"));
  }
  return regex.test(name);
}

// ---------------------------------------------------------------------------
// Tách lệnh shell
// ---------------------------------------------------------------------------

function findBacktickEnd(text: string, i: number): number {
  const n = text.length;
  while (i < n) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") return i;
    i++;
  }
  return n;
}

/** Thân heredoc bắt đầu tại i: [thân, chỉ số sau dòng delimiter]. */
function readHeredocBody(text: string, i: number, delim: string, stripTabs: boolean): [string, number] {
  const n = text.length;
  const start = i;
  while (i < n) {
    const j = text.indexOf("\n", i);
    const line = text.slice(i, j === -1 ? n : j);
    if ((stripTabs ? line.replace(/^\t+/u, "") : line) === delim) return [text.slice(start, i), j === -1 ? n : j + 1];
    i = j === -1 ? n : j + 1;
  }
  return [text.slice(start), n];
}

type Heredoc = [delim: string, quoted: boolean, stripTabs: boolean];

function skipHeredocBodies(text: string, i: number, pending: Heredoc[]): number {
  for (const [delim, , stripTabs] of pending) i = readHeredocBody(text, i, delim, stripTabs)[1];
  return i;
}

const HEREDOC_OP = /<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|(\\?)([^\s;&|()<>'"]+))/uy;

/** Chỉ số của ")" đóng một "$(" hoặc "(" có thân bắt đầu tại i. */
function findParenEnd(text: string, i: number): number {
  let depth = 1;
  const n = text.length;
  let pending: Heredoc[] = [];
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      i = j === -1 ? n : j + 1;
      continue;
    }
    if (c === '"') {
      i = skipDouble(text, i + 1);
      continue;
    }
    if (c === "`") {
      i = findBacktickEnd(text, i + 1) + 1;
      continue;
    }
    if (c === "$" && text.startsWith("$(", i)) {
      i = findParenEnd(text, i + 2) + 1;
      continue;
    }
    if (c === "<" && text.startsWith("<<", i) && !text.startsWith("<<<", i)) {
      HEREDOC_OP.lastIndex = i;
      const match = HEREDOC_OP.exec(text);
      if (match) {
        pending.push([match[2] ?? match[3] ?? match[5], true, match[1] === "-"]);
        i += match[0].length;
        continue;
      }
    }
    if (c === "\n" && pending.length) {
      i = skipHeredocBodies(text, i + 1, pending);
      pending = [];
      continue;
    }
    if (c === "#" && (i === 0 || " \t\n;&|(".includes(text[i - 1]))) {
      const j = text.indexOf("\n", i);
      i = j === -1 ? n : j;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return n;
}

/** Chỉ số sau dấu '"' đóng chuỗi trong nháy kép bắt đầu tại i. */
function skipDouble(text: string, i: number): number {
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === "$" && text.startsWith("$(", i)) {
      i = findParenEnd(text, i + 2) + 1;
      continue;
    }
    if (c === "`") {
      i = findBacktickEnd(text, i + 1) + 1;
      continue;
    }
    i++;
  }
  return n;
}

/**
 * Phép thay thế bắt đầu tại i: $((...)), $(...), `...` và (khi process) <(...), >(...). Trả về [chỉ số sau nó,
 * lệnh bên trong (undefined với số học)], hoặc undefined khi không phải phép thay thế.
 */
function substitution(text: string, i: number, process = false): [number, string | undefined] | undefined {
  if (text.startsWith("$((", i)) return [findParenEnd(text, i + 3) + 2, undefined];
  if (text.startsWith("$(", i) || (process && (text[i] === "<" || text[i] === ">") && text[i + 1] === "(")) {
    const j = findParenEnd(text, i + 2);
    return [j + 1, text.slice(i + 2, j)];
  }
  if (text[i] === "`") {
    const j = findBacktickEnd(text, i + 1);
    return [j + 1, text.slice(i + 1, j).replaceAll("\\`", "`")];
  }
  return undefined;
}

/** Phép thay thế lệnh mà shell mở rộng trong chữ (thân heredoc không có nháy). */
function collectSubstitutions(text: string, nested: string[]): void {
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    const sub = substitution(text, i);
    if (!sub) {
      i++;
      continue;
    }
    if (sub[1] !== undefined) nested.push(sub[1]);
    i = sub[0];
  }
}

const REDIRECT = /&>>|&>|<<<|<<-|<<|>>|>&|<&|>\||<>|>|</uy;

type Parsed = [words: string[], substituted: boolean];

/**
 * Tách chữ shell thành lệnh đơn: [các từ sau khi bỏ nháy, có đến từ phép thay thế không]. Lệnh bên trong phép
 * thay thế cũng được trả về, thành mục riêng. Không bao giờ chạy gì.
 */
function parseCommands(text: string, depth = 0): Parsed[] {
  if (depth > 6) return [];
  const commands: Parsed[] = [];
  const words: string[] = [];
  const nested: string[] = [];
  const pending: [delim: string, quoted: boolean, stripTabs: boolean, owner: number][] = [];
  const ops: (string | undefined)[] = [];
  const executed: string[] = [];
  let buf: string[] = [];
  let inWord = false;
  let quoted = false;
  let redirect: string | undefined;
  let i = 0;
  const n = text.length;

  const endWord = () => {
    if (inWord) {
      const word = buf.join("");
      if (redirect !== undefined) {
        if (redirect === "<<" || redirect === "<<-") pending.push([word, quoted, redirect === "<<-", commands.length]);
        redirect = undefined;
      } else {
        words.push(word);
      }
    }
    buf = [];
    inWord = false;
    quoted = false;
  };
  const endCommand = (op?: string) => {
    endWord();
    if (words.length) {
      commands.push([[...words], depth > 0]);
      ops.push(op);
    }
    words.length = 0;
  };
  const add = (value: string, isQuoted = false) => {
    buf.push(value);
    inWord = true;
    quoted ||= isQuoted;
  };

  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      if (text.startsWith("\\\n", i)) {
        i += 2;
        continue;
      }
      if (i + 1 < n) add(text[i + 1], true);
      i += 2;
      continue;
    }
    if (c === "'") {
      let j = text.indexOf("'", i + 1);
      if (j === -1) j = n;
      add(text.slice(i + 1, j), true);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const out: string[] = [];
      i++;
      while (i < n && text[i] !== '"') {
        const d = text[i];
        if (d === "\\" && i + 1 < n && '$`"\\\n'.includes(text[i + 1])) {
          if (text[i + 1] !== "\n") out.push(text[i + 1]);
          i += 2;
          continue;
        }
        const sub = substitution(text, i);
        if (sub) {
          if (sub[1] !== undefined) nested.push(sub[1]);
          out.push(SUB);
          i = sub[0];
          continue;
        }
        out.push(d);
        i++;
      }
      add(out.join(""), true);
      i++;
      continue;
    }
    const sub = substitution(text, i, true);
    if (sub) {
      if (sub[1] !== undefined) nested.push(sub[1]);
      add(SUB);
      i = sub[0];
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && text.startsWith(">", i + 1))) {
      // Số fd đứng liền trước (2>) thuộc về toán tử chuyển hướng.
      if (inWord && /^\d+$/u.test(buf.join("")) && !quoted) {
        buf = [];
        inWord = false;
      } else {
        endWord();
      }
      REDIRECT.lastIndex = i;
      const op = (REDIRECT.exec(text) as RegExpExecArray)[0];
      redirect = op;
      i += op.length;
      continue;
    }
    if (c === "\n") {
      endCommand("\n");
      i++;
      for (const [delim, isQuoted, stripTabs, owner] of pending) {
        const [body, next] = readHeredocBody(text, i, delim, stripTabs);
        i = next;
        if (owner < commands.length && stdinShell(commands[owner][0])) executed.push(body); // shell chạy thân heredoc
        else if (!isQuoted) collectSubstitutions(body, nested);
      }
      pending.length = 0;
      continue;
    }
    if (";&|()".includes(c)) {
      const op = ["&&", "||", ";;", "|&"].some((item) => text.startsWith(item, i)) ? text.slice(i, i + 2) : c;
      endCommand(op);
      i += op.length;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      const j = text.indexOf("\n", i);
      i = j === -1 ? n : j;
      continue;
    }
    add(c);
    i++;
  }
  endCommand();
  // `echo '...' | bash` chạy chữ được echo.
  for (let k = 1; k < commands.length; k++) {
    if ((ops[k - 1] === "|" || ops[k - 1] === "|&") && stdinShell(commands[k][0])) {
      const feeder = unwrap(commands[k - 1][0]);
      if (feeder && feeder.words.length && ["echo", "printf"].includes(basename(feeder.words[0]))) {
        const args = feeder.words.slice(1).filter((arg) => !(arg.startsWith("-") && arg.length <= 3));
        executed.push(args.join(" ").replaceAll("\\n", "\n"));
      }
    }
  }
  for (const body of executed) for (const [inner] of parseCommands(body, depth + 1)) commands.push([inner, false]);
  for (const inner of nested) for (const [words] of parseCommands(inner, depth + 1)) commands.push([words, true]);
  return commands;
}

/** Các từ mở một shell đọc lệnh từ stdin. */
function stdinShell(words: string[]): boolean {
  const unwrapped = unwrap(words);
  if (!unwrapped || !unwrapped.words.length) return false;
  const rest = unwrapped.words;
  if (!SHELLS.has(basename(rest[0]))) return false;
  const { letters, positional } = parseOpts(rest.slice(1), "oO");
  return !letters.has("c") && (letters.has("s") || !positional.length);
}

/** Bỏ từ khoá, phép gán và wrapper; trả về môi trường gán kèm và các từ bắt đầu từ lệnh thật, hoặc undefined. */
function unwrap(words: string[]): { env: Map<string, string>; words: string[] } | undefined {
  const env = new Map<string, string>();
  let i = 0;
  const n = words.length;
  while (i < n) {
    const word = words[i];
    if (KEYWORDS.has(word)) {
      i++;
      continue;
    }
    if (word === "function") {
      i += 2; // từ khoá và tên hàm; thân hàm theo sau
      continue;
    }
    if (CLAUSES.has(word)) return undefined;
    if (ASSIGNMENT.test(word)) {
      env.set(...partition(word));
      i++;
      continue;
    }
    const name = basename(word);
    const wrapper = WRAPPERS.get(name);
    if (!wrapper) break;
    const [withValue, positional] = wrapper;
    i++;
    while (i < n) {
      const value = words[i];
      if (value === "--") {
        i++;
        break;
      }
      if (name === "env" && ASSIGNMENT.test(value)) {
        env.set(...partition(value));
        i++;
        continue;
      }
      if (value.startsWith("-") && value.length > 1) {
        i += withValue.has(value) && !value.includes("=") ? 2 : 1;
        continue;
      }
      break;
    }
    i += positional;
  }
  return { env, words: i >= n ? [] : words.slice(i) };
}

// ---------------------------------------------------------------------------
// Kiểm tra
// ---------------------------------------------------------------------------

interface Context {
  env: Record<string, string | undefined>;
  git: GitRunner;
  protectedBranches?: string[];
}

/** Git runner mặc định: `git -C cwd ...`, tối đa 3 giây; lỗi hoặc mã thoát khác 0 → undefined. */
export function runGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", timeout: 3_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

function gitOutput(ctx: Context, cwd: string, ...args: string[]): string {
  const out = ctx.git(args, cwd);
  return typeof out === "string" ? out.trim() : "";
}

const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;

const DEFAULTED = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?)-([^}$`]*)\}/gu;

/** Mở rộng $NAME, ${NAME} và ${NAME:-mặc định} theo phép gán thấy trong lệnh này. */
function expand(word: string, env: Map<string, string>): string {
  return word
    .replace(DEFAULTED, (_match: string, name: string, colon: string, fallback: string) => {
      const value = env.get(name);
      return value === undefined || (colon && value === "") ? fallback : value;
    })
    .replace(VARIABLE, (match: string, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      return env.has(name) ? env.get(name) as string : match;
    });
}

const unknown = (word: string) => word.includes(SUB) || word.includes("$");

function isProtected(branch: string, patterns: string[]): boolean {
  const name = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
  return patterns.some((pattern) => globMatch(name, pattern));
}

interface Options {
  letters: Set<string>;
  longs: Set<string>;
  positional: string[];
}

/**
 * Chữ cờ ngắn, tên tùy chọn dài và đối số vị trí của một lệnh con git. shortValue: chữ cờ nhận giá trị;
 * longValue: tùy chọn dài nhận giá trị ở từ kế tiếp khi viết không có "=".
 */
function parseOpts(args: string[], shortValue = "", longValue: string[] = []): Options {
  const letters = new Set<string>();
  const longs = new Set<string>();
  const positional: string[] = [];
  let i = 0;
  const n = args.length;
  while (i < n) {
    const arg = args[i];
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=", 1)[0];
      longs.add(name);
      i += longValue.includes(name) && !arg.includes("=") ? 2 : 1;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const cluster = [...arg];
      for (let j = 1; j < cluster.length; j++) {
        letters.add(cluster[j]);
        if (shortValue.includes(cluster[j])) {
          if (j === cluster.length - 1) i++; // giá trị là từ kế tiếp
          break; // phần còn lại của cụm là giá trị
        }
      }
      i++;
      continue;
    }
    positional.push(arg);
    i++;
  }
  // git và GNU rm nhận tiền tố duy nhất của tùy chọn dài (--no-veri = --no-verify, --har = --hard). Tiền tố của
  // tùy chọn guard xét được tính như tùy chọn đó; tiền tố mơ hồ thì git báo lỗi, nên chặn cũng không hại.
  for (const name of [...longs]) {
    if (name.length < 4) continue;
    for (const option of GUARDED_LONGS) if (option !== name && option.startsWith(name)) longs.add(option);
  }
  return { letters, longs, positional };
}

const GUARDED_LONGS = [
  "--no-verify", "--force", "--mirror", "--prune", "--all", "--branches", "--delete", "--tags", "--hard", "--dry-run",
  "--discard-changes", "--staged", "--worktree", "--cached", "--recursive",
];

/** [tùy chọn toàn cục, lệnh con, đối số] của một lời gọi git. */
function splitGit(words: string[]): [string[], string, string[]] {
  const globals: string[] = [];
  let i = 1;
  const n = words.length;
  while (i < n && words[i].startsWith("-")) {
    const option = words[i];
    globals.push(option);
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(option) && i + 1 < n) {
      globals.push(words[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }
  if (i >= n) return [globals, "", []];
  return [globals, words[i], words.slice(i + 1)];
}

function repoDir(ctx: Context, globals: string[], cwd: string): string {
  const index = globals.indexOf("-C");
  if (index >= 0 && index + 1 < globals.length) return path.resolve(cwd, expandHome(globals[index + 1], ctx.env));
  return cwd;
}

const has = (set: Set<string>, ...items: string[]) => items.some((item) => set.has(item));

function checkPush(ctx: Context, args: string[], cwd: string, env: Map<string, string>): void {
  const { letters, longs, positional } = parseOpts(args, "o", ["--push-option", "--repo", "--receive-pack", "--exec"]);
  if (longs.has("--no-verify")) block("git push --no-verify skips the repo's pre-push checks", "Fix what the check reports.");
  if (longs.has("--force") || letters.has("f")) {
    block("force-push without a lease can overwrite other people's commits", "Use --force-with-lease on your own branch, or push a new branch.");
  }
  if (has(longs, "--mirror", "--prune")) block("push --mirror/--prune can delete remote branches", "Push named branches instead.");
  if (has(longs, "--all", "--branches")) block("push --all also pushes protected branches such as main", "Push the branch you mean by name.");
  if (longs.has("--delete") || letters.has("d")) {
    block("pushing a branch deletion", "Delete remote branches only when the user asks, or let them do it.");
  }
  const patterns = ctx.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  const refspecs = positional.slice(1).map((spec) => expand(spec, env));
  for (const spec of refspecs) {
    if (spec.startsWith("+")) block(`refspec '${spec}' force-updates the remote`, "Drop the leading '+'.");
    if (spec.startsWith(":")) block(`refspec '${spec}' deletes a remote branch`, "Ask the user to delete it.");
    let dst = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    // Tên tính lúc chạy nhiều khả năng là nhánh hiện tại.
    if (dst === "HEAD" || dst === "@" || unknown(dst)) dst = gitOutput(ctx, cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (dst && isProtected(dst, patterns)) block(`direct push to protected branch '${dst}'`, "Push a feature branch and open a PR.");
  }
  if (!refspecs.length && !longs.has("--tags")) {
    const branch = gitOutput(ctx, cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (branch && isProtected(branch, patterns)) {
      block(`push while on protected branch '${branch}'`, "Create a branch (git switch -c <name>) and push that.");
    }
  }
}

const GIT_HOOKS = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "post-index-change",
]);
const CONFIG_READ = ["--get", "--get-all", "--get-regexp", "--list", "-l", "get", "list", "--show-origin", "--show-scope"];
const CONFIG_UNSET = ["--unset", "--unset-all", "unset", "--remove-section", "remove-section", "--rename-section", "rename-section"];

function checkConfig(ctx: Context, args: string[], cwd: string): void {
  const lowered = args.map((arg) => arg.toLowerCase());
  const index = lowered.indexOf("core.hookspath");
  if (index < 0) return;
  const before = new Set(lowered.slice(0, index));
  if (has(before, ...CONFIG_READ)) return;
  if (has(before, ...CONFIG_UNSET)) block("unsetting core.hooksPath can switch off the repo's hook manager", "Leave it as the repo configured it.");
  if (index + 1 >= args.length) return; // chỉ đọc
  const value = args[index + 1];
  if (has(before, "--global", "--system")) block("a global core.hooksPath changes hooks for every repo", "Set it per repo, or ask the user.");
  const top = realPath(gitOutput(ctx, cwd, "rev-parse", "--show-toplevel") || cwd);
  const target = value ? realPath(path.resolve(top, expandHome(value, ctx.env))) : "";
  const inside = !!value && !unknown(value) && (target === top || target.startsWith(top + path.sep));
  const hooks = inside && isDirectory(target) && fs.readdirSync(target).some((name) => GIT_HOOKS.has(name));
  if (!hooks) {
    block(`core.hooksPath '${value}' would switch off the repo's hooks`,
      "Point it at a directory inside the repo that already holds hook scripts (pre-commit, pre-push...): write them first.");
  }
}

const WHOLE_TREE = new Set([".", ":/", "*", ":/*", "./"]);

function checkGit(ctx: Context, words: string[], env: Map<string, string>, cwd: string): void {
  const [globals, sub, args] = splitGit(words);
  if (globals.join(" ").toLowerCase().includes("core.hookspath")) {
    block("overriding core.hooksPath skips the repo's hooks", "Fix what the hook reports instead.");
  }
  cwd = repoDir(ctx, globals, cwd);
  if (HOOK_RUNNING.has(sub)) {
    for (const [key, value] of env) {
      if (BYPASS_ENV.get(key)?.has(value.toLowerCase())) block(`${key}=${value} disables the repo's git hooks`, "Fix what the hook reports.");
      if (key === "SKIP" && value) block("SKIP=... skips pre-commit hooks", "Fix what the hook reports.");
    }
  }

  if (sub === "commit") {
    const { letters, longs } = parseOpts(args, "mFCct", [
      "--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author",
      "--date", "--fixup", "--squash", "--cleanup", "--trailer", "--pathspec-from-file"]);
    if (longs.has("--no-verify") || letters.has("n")) {
      block("git commit --no-verify skips the repo's hooks", "Fix what the hook reports instead of skipping it.");
    }
  } else if (["merge", "rebase", "am", "cherry-pick", "revert"].includes(sub)) {
    const { longs } = parseOpts(args, "msXS", ["--message", "--strategy", "--strategy-option", "--onto", "--exec", "--file"]);
    if (longs.has("--no-verify")) block(`git ${sub} --no-verify skips the repo's hooks`, "Fix what the hook reports instead of skipping it.");
  } else if (sub === "push") {
    checkPush(ctx, args, cwd, env);
  } else if (sub === "reset") {
    const { longs } = parseOpts(args, "", ["--pathspec-from-file"]);
    if (longs.has("--hard")) {
      block("git reset --hard discards uncommitted work", "Use git stash push -u -m '<why>', git restore <paths>, or git revert <sha>.");
    }
  } else if (sub === "clean") {
    const { letters, longs } = parseOpts(args, "e", ["--exclude"]);
    const dry = letters.has("n") || longs.has("--dry-run");
    if (!dry && (letters.has("f") || longs.has("--force"))) {
      block("git clean -f deletes untracked files for good", "Run git clean -n first and delete named paths.");
    }
  } else if (sub === "branch") {
    const { letters, longs } = parseOpts(args, "u", [
      "--set-upstream-to", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort"]);
    const force = letters.has("f") || longs.has("--force");
    const remove = letters.has("d") || longs.has("--delete");
    if (letters.has("D") || (remove && force)) block("force-deleting a branch can lose unmerged commits", "Use git branch -d (refuses unmerged work).");
  } else if (sub === "checkout") {
    const { letters, longs, positional } = parseOpts(args, "bB", ["--orphan"]);
    if (longs.has("--force") || letters.has("f")) block("git checkout --force discards local changes", "Commit or stash first.");
    if (positional.some((item) => WHOLE_TREE.has(item))) block("git checkout . discards every uncommitted change", "Restore named files, or stash.");
  } else if (sub === "switch") {
    const { letters, longs } = parseOpts(args, "cC", ["--create", "--force-create", "--orphan"]);
    if (has(longs, "--discard-changes", "--force") || letters.has("f")) {
      block("git switch --discard-changes throws away local changes", "Commit or stash first.");
    }
  } else if (sub === "restore") {
    const { letters, longs, positional } = parseOpts(args, "s", ["--source", "--pathspec-from-file"]);
    const stagedOnly = (longs.has("--staged") || letters.has("S")) && !(longs.has("--worktree") || letters.has("W"));
    if (!stagedOnly && positional.some((item) => WHOLE_TREE.has(item))) block("git restore . discards every uncommitted change", "Restore named files, or stash.");
  } else if (sub === "stash") {
    const action = args.find((arg) => !arg.startsWith("-")) ?? "";
    if (action === "drop" || action === "clear") block(`git stash ${action} deletes stashed work`, "Leave the stash; the user can drop it.");
  } else if (sub === "rm") {
    const { letters, longs, positional } = parseOpts(args, "", ["--pathspec-from-file"]);
    const force = letters.has("f") || longs.has("--force");
    if (force && !longs.has("--cached") && positional.some((item) => WHOLE_TREE.has(item))) {
      block("git rm -f . deletes every tracked file and any uncommitted change", "Remove named paths, or use git rm -r --cached to untrack.");
    }
  } else if (sub === "worktree") {
    if (args[0] === "remove") {
      const { letters, longs } = parseOpts(args.slice(1));
      if (letters.has("f") || longs.has("--force")) {
        block("git worktree remove --force deletes uncommitted work in that worktree", "Commit or stash there first.");
      }
    }
  } else if (sub === "config") {
    checkConfig(ctx, args, cwd);
  } else if (sub === "filter-branch" || sub === "filter-repo") {
    block(`git ${sub} rewrites history`, "Ask the user; history rewrites need a human decision.");
  } else if (sub === "update-ref") {
    const { letters, longs } = parseOpts(args, "m");
    if (letters.has("d") || longs.has("--delete")) block("deleting a ref directly", "Use git branch -d.");
  } else if (sub === "reflog" && (args[0] === "expire" || args[0] === "delete")) {
    block("expiring the reflog removes the recovery path", "Leave the reflog alone.");
  } else if (sub === "gc" && args.some((arg) => arg.startsWith("--prune=now") || arg === "--prune=all")) {
    block("git gc --prune=now removes the recovery path", "Run git gc without --prune=now.");
  }
}

const CATASTROPHIC = new Set(["/", "~", "$HOME", "${HOME}", ".", "..", "*", ".*", ".git"]);

function isCatastrophic(ctx: Context, target: string): boolean {
  let t = target;
  for (const suffix of ["/*", "/.*"]) {
    if (t.endsWith(suffix)) t = t.slice(0, -suffix.length) || "/";
  }
  if (t.length > 1) t = t.replace(/\/+$/u, "") || "/";
  if (t.startsWith("./") && t.length > 2) t = t.slice(2);
  return CATASTROPHIC.has(t) || t === homeDir(ctx.env);
}

function checkRm(ctx: Context, words: string[]): void {
  const { letters, longs, positional } = parseOpts(words.slice(1));
  if (!(letters.has("r") || letters.has("R") || longs.has("--recursive"))) return;
  for (const target of positional) {
    if (!target.includes(SUB) && isCatastrophic(ctx, target)) block(`rm -r ${target} would delete far more than intended`, "Delete named paths inside the project.");
  }
}

function check(ctx: Context, words: string[], sessionEnv: Map<string, string>, cwd: string, depth = 0): void {
  const unwrapped = unwrap(words);
  if (!unwrapped || !unwrapped.words.length) return;
  const { env, words: rest } = unwrapped;
  // Tên lệnh lấy từ biến đã gán trong lệnh (GIT=git; $GIT reset --hard): mở rộng rồi tách từ như shell.
  if (depth < 2 && rest[0].includes("$")) {
    const head = expand(rest[0], new Map([...sessionEnv, ...env]));
    if (head !== rest[0] && !head.includes("$")) {
      check(ctx, [...head.split(/\s+/u).filter(Boolean), ...rest.slice(1)], sessionEnv, cwd, depth + 1);
      return;
    }
  }
  const name = basename(rest[0]);
  if (SHELLS.has(name)) {
    const { letters, positional } = parseOpts(rest.slice(1), "oO");
    if (letters.has("c") && positional.length) for (const [inner] of parseCommands(positional[0], 1)) check(ctx, inner, sessionEnv, cwd);
    return;
  }
  if (name === "eval") {
    for (const [inner] of parseCommands(rest.slice(1).join(" "), 1)) check(ctx, inner, sessionEnv, cwd);
    return;
  }
  if (name === "git") checkGit(ctx, rest, new Map([...sessionEnv, ...env]), cwd);
  else if (name === "rm") checkRm(ctx, rest);
}

/** Biến được đặt cho phần còn lại của lệnh bằng `export X=..` hoặc `X=..`. */
function sessionAssignments(commands: Parsed[]): Map<string, string> {
  const env = new Map<string, string>();
  for (const [words] of commands) {
    if (!words.length) continue;
    let candidates: string[];
    if (["export", "declare", "typeset"].includes(words[0])) candidates = words.slice(1);
    else if (words.every((word) => ASSIGNMENT.test(word))) candidates = words;
    else continue;
    for (const word of candidates) if (ASSIGNMENT.test(word)) env.set(...partition(word));
  }
  return env;
}

/**
 * Lý do chặn lệnh shell, hoặc undefined khi cho qua. Mọi lỗi nội bộ đều cho qua: lỗi của bộ phân tích không bao giờ
 * được làm hỏng shell (trong Pi, handler tool_call ném lỗi thì lời gọi bị chặn).
 */
export function checkGitGuard(command: string, opts: GitGuardOptions): GitGuardBlock | undefined {
  try {
    const env = opts.env ?? process.env;
    if (typeof command !== "string") return undefined;
    const ctx: Context = { env, git: opts.git ?? runGit, protectedBranches: opts.protectedBranches };
    const cwd = opts.cwd || process.cwd();
    const commands = parseCommands(command);
    const sessionEnv = sessionAssignments(commands);
    for (const [words, substituted] of commands) {
      try {
        check(ctx, words, sessionEnv, cwd);
      } catch (error) {
        if (error instanceof Blocked) return { reason: error.reason, alternative: error.alternative, substitution: substituted };
        throw error;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
