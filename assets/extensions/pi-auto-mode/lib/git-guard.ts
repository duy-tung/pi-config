import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realPath } from "./paths.ts";

/**
 * Guard git tất định, port từ hooks/guard_git.py của tstack (cùng quyết định trên mọi ca kiểm thử của bản gốc).
 *
 * Chặn thao tác git làm mất việc, viết lại lịch sử chung, push thẳng lên nhánh được bảo vệ hoặc bỏ qua hook của
 * repo, cùng vài lệnh rm thảm hoạ; mọi thứ khác cho qua. Lệnh được tách như shell tách: nháy, escape, heredoc,
 * comment, pipeline, danh sách lệnh, subshell, thay thế lệnh và tiến trình, `bash -c`, `eval`, chữ được pipe hoặc
 * heredoc vào shell, và các wrapper phổ biến (sudo, env, timeout, nice, xargs, flock...). Chữ trong nháy, trong
 * heredoc có delimiter trong nháy hoặc trong comment là dữ liệu, không phải lệnh.
 *
 * Nhánh được bảo vệ: PI_GIT_PROTECTED_BRANCHES="a,b" (môi trường của tiến trình Pi) > autoMode.gitGuard.protectedBranches
 * > mặc định; khoá git config `pi.protectedBranches` của repo (lặp được) chỉ thêm vào, và agent không được ghi khoá
 * `pi.*`. PI_GIT_GUARD=off tắt guard; phép gán ngay trong lệnh bị bỏ qua có chủ đích.
 *
 * Đây là dây an toàn chống tai nạn, không phải sandbox: lỗi bất ngờ nào (kể cả lỗi của bộ phân tích) cũng cho qua.
 */

export type GitRunner = (args: string[], cwd: string) => string | undefined;

export interface GitGuardOptions {
  cwd: string;
  /** Môi trường của tiến trình Pi (PI_GIT_GUARD, PI_GIT_PROTECTED_BRANCHES, HOME); mặc định process.env. */
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

// ---------------------------------------------------------------------------
// Ngữ nghĩa chuỗi và đường dẫn của Python mà bản gốc dựa vào
// ---------------------------------------------------------------------------

// Khoảng trắng theo str.isspace() (cũng là \s của re) của Python.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");
// str.isdigit(): chữ số thập phân và chữ số khác (², ①...).
const DIGITS = new RegExp("^[\\p{Nd}\\xb2\\xb3\\xb9\\u1369-\\u1371\\u19da\\u2070\\u2074-\\u2079\\u2080-\\u2089\\u2460-\\u2468"
  + "\\u2474-\\u247c\\u2488-\\u2490\\u24ea\\u24f5-\\u24fd\\u24ff\\u2776-\\u277e\\u2780-\\u2788\\u278a-\\u2792"
  + "\\u{10a40}-\\u{10a43}\\u{10e60}-\\u{10e68}\\u{11052}-\\u{1105a}\\u{1f100}-\\u{1f10a}]+$", "u");

const strip = (value: string) => value.replace(STRIP, "");
/** os.path.basename (POSIX): phần sau "/" cuối cùng. */
const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
/** Số ký tự như len() của Python (theo code point). */
const length = (value: string) => [...value].length;

function partition(word: string): [string, string] {
  const eq = word.indexOf("=");
  return [word.slice(0, eq), word.slice(eq + 1)];
}

/** os.path.join của Python cho hai thành phần (POSIX: không chuẩn hoá). */
function joinPath(base: string, part: string): string {
  if (process.platform === "win32") return path.resolve(base, part);
  if (part.startsWith("/")) return part;
  return !base || base.endsWith("/") ? base + part : `${base}/${part}`;
}

function userHome(name: string): string | undefined {
  try {
    const me = os.userInfo();
    if (me.username === name) return me.homedir;
  } catch {
    /* không có mục passwd cho người dùng hiện tại */
  }
  try {
    for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields.length >= 7 && fields[0] === name) return fields[5];
    }
  } catch {
    /* không có /etc/passwd (Windows) */
  }
  return undefined;
}

/** os.path.expanduser: ~ theo HOME của môi trường, ~tên theo passwd; không tìm được thì giữ nguyên. */
function expandUser(value: string, env: Record<string, string | undefined>): string {
  if (!value.startsWith("~")) return value;
  let slash = value.indexOf("/", 1);
  if (slash < 0) slash = value.length;
  let home: string | undefined;
  if (slash === 1) {
    try {
      home = env.HOME ?? os.userInfo().homedir;
    } catch {
      return value;
    }
  } else {
    home = userHome(value.slice(1, slash));
    if (home === undefined) return value;
  }
  return home.replace(/\/+$/u, "") + value.slice(slash) || "/";
}

/** Lỗi hệ thống (OSError của Python), khác lỗi đối số như NUL trong đường dẫn. */
const osError = (error: unknown) => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && !code.startsWith("ERR_");
};

/** posixpath.split: (thư mục, thành phần cuối). */
function splitPath(value: string): [string, string] {
  const at = value.lastIndexOf("/") + 1;
  let head = value.slice(0, at);
  if (head && head !== "/".repeat(head.length)) head = head.replace(/\/+$/u, "");
  return [head, value.slice(at)];
}

function joinRealPath(base: string, rest: string, seen: Map<string, string | undefined>): [string, boolean] {
  let current = base;
  if (rest.startsWith("/")) {
    rest = rest.slice(1);
    current = "/";
  }
  while (rest) {
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    rest = slash < 0 ? "" : rest.slice(slash + 1);
    if (!name || name === ".") continue;
    if (name === "..") {
      if (current) {
        const [head, tail] = splitPath(current);
        current = tail === ".." ? joinPath(joinPath(head, ".."), "..") : head;
      } else {
        current = "..";
      }
      continue;
    }
    const next = joinPath(current, name);
    let link = false;
    try {
      link = fs.lstatSync(next).isSymbolicLink();
    } catch (error) {
      if (!osError(error)) throw error;
    }
    if (!link) {
      current = next;
      continue;
    }
    if (seen.has(next)) {
      const cached = seen.get(next);
      if (cached !== undefined) {
        current = cached;
        continue;
      }
      // Vòng symlink: giữ phần đã resolve và phần còn lại.
      return [joinPath(next, rest), false];
    }
    seen.set(next, undefined);
    const [resolved, ok] = joinRealPath(current, fs.readlinkSync(next), seen);
    current = resolved;
    if (!ok) return [joinPath(current, rest), false];
    seen.set(next, current);
  }
  return [current, true];
}

/** os.path.realpath (không strict): theo symlink của phần đã có, phần chưa có giữ nguyên chữ. */
function realpath(file: string): string {
  if (process.platform === "win32") return realPath(file);
  return path.resolve(joinRealPath("", file, new Map())[0]);
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;
const patterns = new Map<string, RegExp>();

/** fnmatch.translate: * và ? khớp cả "/", [...] là lớp ký tự ([!...] phủ định), không phân biệt hoa thường thì không. */
function translate(pattern: string): RegExp {
  let source = "";
  let star = false;
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i++];
    if (c === "*") {
      if (!star) source += "[\\s\\S]*";
      star = true;
      continue;
    }
    star = false;
    if (c === "?") {
      source += "[\\s\\S]";
    } else if (c === "[") {
      let j = i;
      if (j < n && pattern[j] === "!") j++;
      if (j < n && pattern[j] === "]") j++;
      while (j < n && pattern[j] !== "]") j++;
      if (j >= n) {
        source += "\\[";
        continue;
      }
      let stuff = pattern.slice(i, j);
      if (!stuff.includes("-")) {
        stuff = stuff.replaceAll("\\", "\\\\");
      } else {
        const chunks: string[] = [];
        let k = pattern[i] === "!" ? i + 2 : i + 1;
        for (;;) {
          k = k < j ? pattern.indexOf("-", k) : -1;
          if (k < 0 || k >= j) break;
          chunks.push(pattern.slice(i, k));
          i = k + 1;
          k += 3;
        }
        const chunk = pattern.slice(i, j);
        if (chunk) chunks.push(chunk);
        else chunks[chunks.length - 1] += "-";
        // Bỏ khoảng rỗng (a > b); đoạn rỗng là IndexError ở bản gốc.
        for (let m = chunks.length - 1; m > 0; m--) {
          if (!chunks[m - 1] || !chunks[m]) throw new Error("fnmatch: empty range chunk");
          if (chunks[m - 1][chunks[m - 1].length - 1] > chunks[m][0]) {
            chunks[m - 1] = chunks[m - 1].slice(0, -1) + chunks[m].slice(1);
            chunks.splice(m, 1);
          }
        }
        stuff = chunks.map((item) => item.replaceAll("\\", "\\\\").replaceAll("-", "\\-")).join("-");
      }
      i = j + 1;
      if (!stuff) source += "(?!)";
      else if (stuff === "!") source += "[\\s\\S]";
      else {
        if (stuff[0] === "!") stuff = `^${stuff.slice(1)}`;
        else if (stuff[0] === "^" || stuff[0] === "[") stuff = `\\${stuff}`;
        source += `[${stuff.replaceAll("]", "\\]")}]`;
      }
    } else {
      source += c.replace(REGEX_SYNTAX, "\\$&");
    }
  }
  return new RegExp(`^(?:${source})$`, "u");
}

/** fnmatch.fnmatchcase. */
function fnmatch(name: string, pattern: string): boolean {
  let regex = patterns.get(pattern);
  if (!regex) patterns.set(pattern, regex = translate(pattern));
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

const HEREDOC_OP = new RegExp(`<<(-?)[ \\t]*(?:'([^']*)'|"([^"]*)"|(\\\\?)([^${PY_SPACE};&|()<>'"]+))`, "uy");

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

/** Phép thay thế lệnh mà shell mở rộng trong chữ (thân heredoc không có nháy). */
function collectSubstitutions(text: string, nested: string[]): void {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "$" && text.startsWith("$((", i)) {
      i += 3;
      continue;
    }
    if (c === "$" && text.startsWith("$(", i)) {
      const j = findParenEnd(text, i + 2);
      nested.push(text.slice(i + 2, j));
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const j = findBacktickEnd(text, i + 1);
      nested.push(text.slice(i + 1, j).replaceAll("\\`", "`"));
      i = j + 1;
      continue;
    }
    i++;
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
        if (d === "$" && text.startsWith("$((", i)) {
          out.push(SUB);
          i = findParenEnd(text, i + 3) + 2;
          continue;
        }
        if (d === "$" && text.startsWith("$(", i)) {
          const j = findParenEnd(text, i + 2);
          nested.push(text.slice(i + 2, j));
          out.push(SUB);
          i = j + 1;
          continue;
        }
        if (d === "`") {
          const j = findBacktickEnd(text, i + 1);
          nested.push(text.slice(i + 1, j).replaceAll("\\`", "`"));
          out.push(SUB);
          i = j + 1;
          continue;
        }
        out.push(d);
        i++;
      }
      add(out.join(""), true);
      i++;
      continue;
    }
    if (c === "`") {
      const j = findBacktickEnd(text, i + 1);
      nested.push(text.slice(i + 1, j).replaceAll("\\`", "`"));
      add(SUB);
      i = j + 1;
      continue;
    }
    if (c === "$" && text.startsWith("$((", i)) {
      add(SUB);
      i = findParenEnd(text, i + 3) + 2;
      continue;
    }
    if (c === "$" && text.startsWith("$(", i)) {
      const j = findParenEnd(text, i + 2);
      nested.push(text.slice(i + 2, j));
      add(SUB);
      i = j + 1;
      continue;
    }
    if ((c === "<" || c === ">") && text.startsWith("(", i + 1)) {
      const j = findParenEnd(text, i + 2);
      nested.push(text.slice(i + 2, j));
      add(SUB);
      i = j + 1;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && text.startsWith(">", i + 1))) {
      // Số fd đứng liền trước (2>) thuộc về toán tử chuyển hướng.
      if (inWord && DIGITS.test(buf.join("")) && !quoted) {
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
        const args = feeder.words.slice(1).filter((arg) => !(arg.startsWith("-") && length(arg) <= 3));
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
  } catch (error) {
    // Đối số không hợp lệ (NUL) là lỗi của guard, không phải git thất bại: để lớp ngoài cho qua như bản gốc.
    if (!osError(error) && (error as { code?: unknown }).code !== undefined) throw error;
    return undefined;
  }
}

function gitOutput(ctx: Context, cwd: string, ...args: string[]): string {
  const out = ctx.git(args, cwd);
  return typeof out === "string" ? strip(out) : "";
}

/** PI_GIT_GUARD=off (không phân biệt hoa thường) trong môi trường của tiến trình Pi tắt guard. */
export function gitGuardOff(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PI_GIT_GUARD ?? "").toLowerCase() === "off";
}

/** Danh sách nhánh được bảo vệ trước khi thêm git config của repo: biến môi trường > settings > mặc định. */
export function baseProtectedBranches(env: Record<string, string | undefined> = process.env, settings?: string[]): string[] {
  const replaced = env.PI_GIT_PROTECTED_BRANCHES;
  if (replaced) return replaced.split(",").map(strip).filter(Boolean);
  return settings ?? DEFAULT_PROTECTED_BRANCHES;
}

/** Git config của repo chỉ thêm nhánh, nên không gì ghi được từ trong phiên nới lỏng được bảo vệ. */
function protectedPatterns(ctx: Context, cwd: string): string[] {
  const extra = gitOutput(ctx, cwd, "config", "--get-all", "pi.protectedBranches");
  return [...baseProtectedBranches(ctx.env, ctx.protectedBranches), ...extra.split(/[,\n]/u).map(strip).filter(Boolean)];
}

const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;

/** Mở rộng $NAME và ${NAME} theo phép gán thấy trong lệnh này. */
function expand(word: string, env: Map<string, string>): string {
  return word.replace(VARIABLE, (match: string, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    return env.has(name) ? env.get(name) as string : match;
  });
}

const unknown = (word: string) => word.includes(SUB) || word.includes("$");

function isProtected(branch: string, patterns: string[]): boolean {
  const name = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
  return patterns.some((pattern) => fnmatch(name, pattern));
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
  return { letters, longs, positional };
}

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
  if (index >= 0 && index + 1 < globals.length) return joinPath(cwd, expandUser(globals[index + 1], ctx.env));
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
  const patterns = protectedPatterns(ctx, cwd);
  const refspecs = positional.slice(1).map((spec) => expand(spec, env));
  for (const spec of refspecs) {
    if (spec.startsWith("+")) block(`refspec '${spec}' force-updates the remote`, "Drop the leading '+'.");
    if (spec.startsWith(":")) block(`refspec '${spec}' deletes a remote branch`, "Ask the user to delete it.");
    let dst = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
    // Tên tính lúc chạy nhiều khả năng là nhánh hiện tại.
    if (dst === "HEAD" || dst === "@" || unknown(dst)) dst = gitOutput(ctx, cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (dst && isProtected(dst, patterns)) block(`direct push to protected branch '${dst}'`, "Push a feature branch and open a PR with /skill:ship.");
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
  lowered.forEach((key, index) => {
    if (!key.startsWith("pi.")) return;
    const before = new Set(lowered.slice(0, index));
    if (!has(before, ...CONFIG_READ) && (has(before, ...CONFIG_UNSET) || index + 1 < args.length)) {
      block("pi.* settings in git config belong to the user", "Ask the user to change them.");
    }
  });
  const index = lowered.indexOf("core.hookspath");
  if (index < 0) return;
  const before = new Set(lowered.slice(0, index));
  if (has(before, ...CONFIG_READ)) return;
  if (has(before, ...CONFIG_UNSET)) block("unsetting core.hooksPath can switch off the repo's hook manager", "Leave it as the repo configured it.");
  if (index + 1 >= args.length) return; // chỉ đọc
  const value = args[index + 1];
  if (has(before, "--global", "--system")) block("a global core.hooksPath changes hooks for every repo", "Set it per repo, or ask the user.");
  const top = realpath(gitOutput(ctx, cwd, "rev-parse", "--show-toplevel") || cwd);
  const target = value ? realpath(joinPath(top, expandUser(value, ctx.env))) : "";
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
  return CATASTROPHIC.has(t) || t === expandUser("~", ctx.env).replace(/\/+$/u, "");
}

function checkRm(ctx: Context, words: string[]): void {
  const { letters, longs, positional } = parseOpts(words.slice(1));
  if (!(letters.has("r") || letters.has("R") || longs.has("--recursive"))) return;
  for (const target of positional) {
    if (!target.includes(SUB) && isCatastrophic(ctx, target)) block(`rm -r ${target} would delete far more than intended`, "Delete named paths inside the project.");
  }
}

function check(ctx: Context, words: string[], sessionEnv: Map<string, string>, cwd: string): void {
  const unwrapped = unwrap(words);
  if (!unwrapped || !unwrapped.words.length) return;
  const { env, words: rest } = unwrapped;
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
    if (gitGuardOff(env) || typeof command !== "string") return undefined;
    if (!command.includes("git") && !command.includes("rm")) return undefined;
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
