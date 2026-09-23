/**
 * Phân tích lệnh shell một cách bảo thủ.
 *
 * Mục đích duy nhất là chứng minh một lệnh "an toàn" (chỉ đọc) hoặc tìm bằng chứng
 * nguy hiểm (luật deny, rm vào đường dẫn quan trọng). Cấu trúc nào không hiểu chắc
 * chắn (thay thế lệnh, biến, subshell, heredoc, điều khiển luồng...) đều làm
 * `plain = false`, và lệnh đó phải qua bộ phân loại. Không bao giờ dùng kết quả
 * ở đây để kết luận một lệnh không-plain là an toàn.
 */

export interface Redirect {
  op: string;
  fd?: number;
  target: string;
  /** Đích là chữ thuần (không có biến/thay thế). */
  literal: boolean;
}

export interface SimpleCommand {
  words: string[];
  /** Từng từ có hoàn toàn là chữ thuần không (không $, `, ...). */
  literal: boolean[];
  /** Từ có ký tự glob chưa trích dẫn (*, ?, [). */
  glob: boolean[];
  assignments: string[];
  redirects: Redirect[];
  /** Lệnh được bóc ra từ wrapper (sudo, env, xargs, bash -c...), không phải lệnh cấp cao nhất. */
  wrapped?: string;
}

export interface ShellAnalysis {
  /** Lệnh cấp cao nhất theo thứ tự, kể cả lệnh bóc từ wrapper và script lồng. */
  commands: SimpleCommand[];
  /** Mọi cấu trúc đều hiểu được và là chữ thuần. */
  plain: boolean;
  problems: string[];
  /** Nội dung $(...), `...`, <(...) và script của sh -c / eval (đã phân tích đệ quy vào commands). */
  nested: string[];
}

const KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
  "function", "select", "[[", "]]", "{", "}", "!", "coproc",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const MAX_DEPTH = 6;

interface Token {
  kind: "word" | "op" | "redir";
  value: string;
  literal: boolean;
  glob: boolean;
  fd?: number;
}

/** Tách chuỗi lệnh thành token, ghi lại vấn đề khi gặp cấu trúc không-plain. */
function lex(source: string, problems: Set<string>, nested: string[]): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let literal = true;
  let glob = false;
  let started = false;
  let index = 0;

  const flush = () => {
    if (!started) return;
    tokens.push({ kind: "word", value: word, literal, glob });
    word = "";
    literal = true;
    glob = false;
    started = false;
  };

  // Tìm dấu đóng tương ứng cho $( ... ) hoặc ( ... ), có xét nháy và lồng nhau.
  const matchParen = (start: number): number => {
    let depth = 1;
    let i = start;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'") {
        const end = source.indexOf("'", i + 1);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    return -1;
  };

  const readDollar = (inDouble: boolean): void => {
    // Đang ở ký tự '$'.
    const next = source[index + 1];
    if (next === "(") {
      if (source[index + 2] === "(") {
        problems.add("arithmetic expansion");
        const end = matchParen(index + 3);
        index = end < 0 ? source.length : end + 2;
      } else {
        const end = matchParen(index + 2);
        if (end < 0) {
          problems.add("unterminated command substitution");
          index = source.length;
        } else {
          nested.push(source.slice(index + 2, end));
          problems.add("command substitution");
          index = end + 1;
        }
      }
      literal = false;
      started = true;
      return;
    }
    if (next === "{") {
      const end = source.indexOf("}", index + 2);
      problems.add("parameter expansion");
      literal = false;
      started = true;
      word += source.slice(index, end < 0 ? source.length : end + 1);
      index = end < 0 ? source.length : end + 1;
      return;
    }
    if (next === "'" && !inDouble) {
      // ANSI-C quoting: giữ nội dung nhưng không coi là chữ thuần (có escape).
      const end = source.indexOf("'", index + 2);
      problems.add("ansi-c quoting");
      literal = false;
      started = true;
      word += source.slice(index + 2, end < 0 ? source.length : end);
      index = end < 0 ? source.length : end + 1;
      return;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9?$!#@*-]/u.exec(source.slice(index + 1));
    if (name) {
      problems.add("variable expansion");
      literal = false;
      started = true;
      word += `$${name[0]}`;
      index += 1 + name[0].length;
      return;
    }
    // '$' đứng một mình là chữ.
    word += "$";
    started = true;
    index++;
  };

  while (index < source.length) {
    const ch = source[index];
    if (ch === " " || ch === "\t") {
      flush();
      index++;
      continue;
    }
    if (ch === "\n") {
      flush();
      tokens.push({ kind: "op", value: ";", literal: true, glob: false });
      index++;
      continue;
    }
    if (ch === "#" && !started) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (ch === "\\") {
      if (source[index + 1] === "\n") {
        index += 2;
        continue;
      }
      if (index + 1 < source.length) word += source[index + 1];
      started = true;
      index += 2;
      continue;
    }
    if (ch === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) {
        problems.add("unterminated quote");
        word += source.slice(index + 1);
        index = source.length;
      } else {
        word += source.slice(index + 1, end);
        index = end + 1;
      }
      started = true;
      continue;
    }
    if (ch === '"') {
      index++;
      started = true;
      let closed = false;
      while (index < source.length) {
        const c = source[index];
        if (c === '"') {
          closed = true;
          index++;
          break;
        }
        if (c === "\\" && index + 1 < source.length && '$`"\\\n'.includes(source[index + 1])) {
          if (source[index + 1] !== "\n") word += source[index + 1];
          index += 2;
          continue;
        }
        if (c === "$") {
          readDollar(true);
          continue;
        }
        if (c === "`") {
          const end = source.indexOf("`", index + 1);
          problems.add("command substitution");
          literal = false;
          if (end < 0) {
            index = source.length;
          } else {
            nested.push(source.slice(index + 1, end));
            index = end + 1;
          }
          continue;
        }
        word += c;
        index++;
      }
      if (!closed) problems.add("unterminated quote");
      continue;
    }
    if (ch === "$") {
      readDollar(false);
      continue;
    }
    if (ch === "`") {
      const end = source.indexOf("`", index + 1);
      problems.add("command substitution");
      literal = false;
      started = true;
      if (end < 0) {
        index = source.length;
      } else {
        nested.push(source.slice(index + 1, end));
        index = end + 1;
      }
      continue;
    }
    if ((ch === "<" || ch === ">") && source[index + 1] === "(") {
      flush();
      const end = matchParen(index + 2);
      problems.add("process substitution");
      if (end >= 0) nested.push(source.slice(index + 2, end));
      tokens.push({ kind: "word", value: "", literal: false, glob: false });
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === ">" || ch === "<" || (ch === "&" && source[index + 1] === ">")) {
      // Số fd đứng liền trước (2>, 1>>...) thuộc về toán tử chuyển hướng.
      let fd: number | undefined;
      if (started && literal && /^\d+$/u.test(word)) {
        fd = Number(word);
        word = "";
        started = false;
        literal = true;
      } else {
        flush();
      }
      const op = /^(?:&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|>|<)/u.exec(source.slice(index))?.[0] ?? ch;
      index += op.length;
      if (op === "<<" || op === "<<-") problems.add("heredoc");
      if (op === "<<<") problems.add("here-string");
      tokens.push({ kind: "redir", value: op, literal: true, glob: false, fd });
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      flush();
      const op = /^(?:&&|\|\||\|&|;;&|;;|;&|\||&|;)/u.exec(source.slice(index))?.[0] ?? ch;
      if (op === "&") problems.add("background job");
      if (op.startsWith(";;") || op === ";&") problems.add("case syntax");
      tokens.push({ kind: "op", value: op, literal: true, glob: false });
      index += op.length;
      continue;
    }
    if (ch === "(" || ch === ")") {
      flush();
      problems.add("subshell or grouping");
      if (ch === "(") {
        const end = matchParen(index + 1);
        if (end >= 0) {
          nested.push(source.slice(index + 1, end));
          index = end + 1;
          continue;
        }
      }
      index++;
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[") glob = true;
    word += ch;
    started = true;
    index++;
  }
  flush();
  return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/u;

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

/** Tên chương trình (bỏ thư mục): /usr/bin/rm → rm. */
export function commandName(command: SimpleCommand): string {
  return command.words.length ? basename(command.words[0]) : "";
}

/** Tìm lệnh bên trong các wrapper phổ biến; trả về chỉ số từ bắt đầu lệnh con. */
function innerStart(words: string[]): number | undefined {
  const name = basename(words[0] ?? "");
  let i = 1;
  const skipOptions = (withValue: Set<string>) => {
    while (i < words.length && words[i].startsWith("-") && words[i] !== "--") {
      const option = words[i];
      i++;
      if (withValue.has(option) && i < words.length) i++;
    }
    if (words[i] === "--") i++;
  };
  switch (name) {
    case "sudo":
    case "doas":
      skipOptions(new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]));
      return i < words.length ? i : undefined;
    case "env":
      while (i < words.length) {
        if (words[i] === "-u" || words[i] === "--unset" || words[i] === "-C" || words[i] === "--chdir") i += 2;
        else if (words[i].startsWith("-") || ASSIGNMENT.test(words[i])) i++;
        else break;
      }
      return i < words.length ? i : undefined;
    case "nohup":
    case "time":
    case "builtin":
    case "exec":
    case "caffeinate":
    case "stdbuf":
    case "ionice":
    case "chroot":
      skipOptions(new Set(["-o", "-e", "-i", "-c", "-n", "-w", "-t"]));
      return i < words.length ? i : undefined;
    case "command":
      if (words[1] === "-v" || words[1] === "-V") return undefined;
      skipOptions(new Set());
      return i < words.length ? i : undefined;
    case "nice":
      skipOptions(new Set(["-n"]));
      return i < words.length ? i : undefined;
    case "timeout":
    case "gtimeout":
      skipOptions(new Set(["-s", "--signal", "-k", "--kill-after"]));
      i++; // thời lượng
      return i < words.length ? i : undefined;
    case "watch":
      skipOptions(new Set(["-n", "--interval", "-d"]));
      return i < words.length ? i : undefined;
    case "xargs":
      skipOptions(new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]));
      return i < words.length ? i : undefined;
    default:
      return undefined;
  }
}

/** Script của `sh -c '...'`, `bash -lc '...'` hoặc `eval ...`. */
function inlineScript(words: string[]): string | undefined {
  const name = basename(words[0] ?? "");
  if (name === "eval") return words.slice(1).join(" ");
  if (!SHELLS.has(name)) return undefined;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "--") return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/u.test(word)) return words[i + 1];
    if (!word.startsWith("-") && !word.startsWith("+")) return undefined;
  }
  return undefined;
}

function build(tokens: Token[], problems: Set<string>): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], literal: [], glob: [], assignments: [], redirects: [] };
  const finish = () => {
    if (current.words.length || current.assignments.length || current.redirects.length) commands.push(current);
    current = { words: [], literal: [], glob: [], assignments: [], redirects: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "op") {
      finish();
      continue;
    }
    if (token.kind === "redir") {
      const target = tokens[i + 1];
      if (!target || target.kind !== "word") {
        problems.add("redirect without target");
        continue;
      }
      i++;
      current.redirects.push({ op: token.value, fd: token.fd, target: target.value, literal: target.literal });
      continue;
    }
    if (!current.words.length && ASSIGNMENT.test(token.value) && token.literal) {
      current.assignments.push(token.value);
      problems.add("environment assignment");
      continue;
    }
    if (!current.words.length && KEYWORDS.has(token.value)) problems.add("shell control flow");
    current.words.push(token.value);
    current.literal.push(token.literal);
    current.glob.push(token.glob);
  }
  finish();
  return commands;
}

/** Phân tích một chuỗi lệnh, gồm cả lệnh lồng (tối đa MAX_DEPTH cấp). */
export function analyzeShell(source: string, depth = 0): ShellAnalysis {
  const problems = new Set<string>();
  const nested: string[] = [];
  const tokens = lex(source, problems, nested);
  const top = build(tokens, problems);
  const commands: SimpleCommand[] = [];
  const queue: SimpleCommand[] = [...top];
  const visit = (command: SimpleCommand) => {
    commands.push(command);
    const start = innerStart(command.words);
    if (start !== undefined) {
      queue.push({
        words: command.words.slice(start), literal: command.literal.slice(start), glob: command.glob.slice(start),
        assignments: [], redirects: [], wrapped: basename(command.words[0]),
      });
    }
    const script = inlineScript(command.words);
    if (script !== undefined) {
      nested.push(script);
      problems.add("nested shell script");
    }
  };
  while (queue.length) visit(queue.shift() as SimpleCommand);
  const scripts = [...nested];
  for (const script of scripts) {
    if (depth >= MAX_DEPTH) {
      problems.add("nesting too deep");
      break;
    }
    const inner = analyzeShell(script, depth + 1);
    for (const command of inner.commands) commands.push({ ...command, wrapped: command.wrapped ?? "nested" });
    for (const problem of inner.problems) problems.add(problem);
    nested.push(...inner.nested.filter((item) => !nested.includes(item)));
  }
  if (commands.some((command) => command.literal.some((value) => !value))) problems.add("non-literal word");
  if (commands.some((command) => command.redirects.some((redirect) => !redirect.literal))) problems.add("non-literal redirect");
  return { commands, plain: problems.size === 0, problems: [...problems], nested };
}

// ---------------------------------------------------------------------------
// Lệnh chỉ đọc
// ---------------------------------------------------------------------------

type Validator = (args: string[]) => boolean;

const always: Validator = () => true;
const noneOf = (...flags: string[]): Validator => (args) =>
  !args.some((arg) => flags.some((flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`))));
const positionals = (args: string[]) => args.filter((arg) => !arg.startsWith("-"));

const GIT_READ: Record<string, Validator> = {
  status: always,
  log: noneOf("--output", "--ext-diff"),
  diff: noneOf("--output", "--ext-diff"),
  show: noneOf("--output", "--ext-diff"),
  shortlog: always,
  blame: always,
  annotate: always,
  grep: noneOf("-O", "--open-files-in-pager"),
  "ls-files": always,
  "ls-tree": always,
  "ls-remote": always,
  "rev-parse": always,
  "rev-list": always,
  describe: always,
  "name-rev": always,
  "cat-file": (args) => args.some((arg) => ["-p", "-t", "-s", "-e"].includes(arg)),
  "merge-base": always,
  "show-ref": always,
  "for-each-ref": always,
  "count-objects": always,
  "check-ignore": always,
  "check-attr": always,
  whatchanged: always,
  version: always,
  help: always,
  reflog: (args) => positionals(args).length === 0 || args[0] === "show",
  branch: (args) =>
    positionals(args).length === 0 ||
    args.some((arg) => arg === "--list" || arg === "-l" || arg === "--contains" || arg === "--merged" || arg === "--no-merged"),
  tag: (args) => positionals(args).length === 0 || args.some((arg) => arg === "-l" || arg === "--list" || arg === "--contains"),
  remote: (args) => args.length === 0 || args.every((arg) => arg === "-v" || arg === "--verbose") ||
    ((args[0] === "show" || args[0] === "get-url") && !args.includes("--push")),
  config: (args) => {
    if (args.some((arg) => /^--(?:unset|add|replace-all|rename-section|remove-section|edit)$|^-e$/u.test(arg))) return false;
    if (args.some((arg) => /^--(?:get|get-all|get-regexp|list|show-origin|show-scope)$|^-l$/u.test(arg))) return true;
    return positionals(args).length === 1;
  },
  stash: (args) => args[0] === "list" || args[0] === "show",
  worktree: (args) => args[0] === "list",
  submodule: (args) => args[0] === "status",
};

const GIT_GLOBAL_OK = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects", "--version", "--help"]);

function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (!GIT_GLOBAL_OK.has(args[i])) return false;
    i++;
  }
  if (i >= args.length) return true;
  const validator = GIT_READ[args[i]];
  return validator ? validator(args.slice(i + 1)) : false;
}

const GH_READ: Record<string, Set<string>> = {
  pr: new Set(["view", "diff", "list", "status", "checks"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list"]),
  repo: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  workflow: new Set(["view", "list"]),
  auth: new Set(["status"]),
  search: new Set(["repos", "issues", "prs", "code", "commits"]),
};

const PACKAGE_READ: Record<string, Set<string>> = {
  npm: new Set(["ls", "list", "view", "info", "outdated", "why", "explain", "--version", "-v"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "--version", "-v"]),
  yarn: new Set(["list", "why", "info", "--version", "-v"]),
  bun: new Set(["--version", "pm"]),
  pip: new Set(["list", "show", "freeze", "--version"]),
  pip3: new Set(["list", "show", "freeze", "--version"]),
  cargo: new Set(["tree", "metadata", "--version", "-V"]),
  go: new Set(["version", "env", "list"]),
  brew: new Set(["list", "info", "--version", "search", "outdated", "deps", "leaves"]),
};

const VERSION_ONLY = new Set(["node", "python", "python3", "ruby", "perl", "java", "rustc", "deno", "tsc", "php", "lua", "uv", "docker", "kubectl", "terraform"]);

const READ_ONLY: Record<string, Validator> = {
  cat: always, cd: always, cut: always, echo: always, printf: always, expr: always, false: always, true: always,
  grep: always, egrep: always, fgrep: always, head: always, tail: always, id: always, ls: always, nl: always,
  paste: always, pwd: always, rev: always, seq: always, stat: always, tr: always, uname: always, wc: always,
  which: always, whereis: always, whoami: always, tac: always, numfmt: always, basename: always, dirname: always,
  realpath: always, readlink: always, file: always, du: always, df: always, cmp: always, comm: always, diff: always,
  column: always, fold: always, fmt: always, od: always, hexdump: always, strings: always, md5: always,
  md5sum: always, shasum: always, sha1sum: always, sha256sum: always, sha512sum: always, cksum: always,
  test: always, "[": always, type: always, ps: always, pgrep: always, uptime: always, sw_vers: always,
  arch: always, nproc: always, getconf: always, locale: always, jq: always, pushd: always, popd: always, dirs: always,
  sort: noneOf("-o", "--output", "--compress-program"),
  uniq: (args) => positionals(args).length <= 1,
  tree: noneOf("-o", "-R"),
  base64: (args) => !args.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output=") || /^-o./u.test(arg)),
  xxd: (args) => !args.includes("-r") && !args.includes("-revert") && positionals(args).length <= 1,
  yq: noneOf("-i", "--inplace"),
  hostname: (args) => args.length === 0,
  date: (args) => !args.some((arg) => arg === "-s" || arg.startsWith("--set")),
  find: (args) => !args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf"].includes(arg)),
  rg: (args) => !args.some((arg) => /^--(?:pre|pre-glob|hostname-bin|search-zip)(?:=|$)|^-z$/u.test(arg)),
  sed: (args) => {
    if (args[0] !== "-n") return false;
    const script = args[1];
    return typeof script === "string" && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/u.test(script) && args.slice(2).every((arg) => !arg.startsWith("-"));
  },
  git: gitReadOnly,
  gh: (args) => {
    const allowed = GH_READ[args[0] ?? ""];
    return !!allowed && allowed.has(args[1] ?? "") && !args.some((arg) => arg === "--web" || arg === "-w");
  },
  command: (args) => args[0] === "-v" || args[0] === "-V",
};

const SAFE_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** Chuyển hướng không ghi file: tới /dev/null, gộp fd (2>&1), hoặc đọc từ file (<). */
export function redirectIsSafe(redirect: Redirect): boolean {
  if (!redirect.literal) return false;
  if (redirect.op === "<") return true;
  if (redirect.op === ">&" || redirect.op === "<&") return /^\d+$|^-$/u.test(redirect.target);
  if ([">", ">>", ">|", "&>", "&>>"].includes(redirect.op)) return SAFE_REDIRECT_TARGETS.has(redirect.target);
  return false;
}

/** Lệnh đơn chỉ đọc: tên trong bảng, đối số hợp lệ và chuyển hướng không ghi file. */
export function isReadOnlyCommand(command: SimpleCommand): boolean {
  if (!command.words.length || command.assignments.length) return false;
  if (!command.literal.every(Boolean)) return false;
  if (!command.redirects.every(redirectIsSafe)) return false;
  const name = command.words[0];
  // Đường dẫn tuyệt đối/tương đối tới chương trình có thể là file bất kỳ cùng tên.
  if (name.includes("/")) return false;
  const args = command.words.slice(1);
  if (VERSION_ONLY.has(name)) return args.length === 1 && ["--version", "-v", "-V", "version"].includes(args[0]);
  const table = PACKAGE_READ[name];
  if (table) return args.length > 0 && table.has(args[0]) && !args.includes("-g") && !args.includes("--global");
  const validator = READ_ONLY[name];
  return validator ? validator(args) : false;
}

/** Cả chuỗi lệnh chỉ đọc: plain, và mọi lệnh cấp cao nhất đều chỉ đọc. */
export function isReadOnlyShell(analysis: ShellAnalysis): boolean {
  return analysis.plain && analysis.commands.length > 0 && analysis.commands.every(isReadOnlyCommand);
}

/** Chuỗi chuẩn hóa của lệnh (các từ nối bằng một khoảng trắng) để khớp luật. */
export function commandText(command: SimpleCommand): string {
  return command.words.join(" ");
}
