import fs from "node:fs";
import { resolveShellPath } from "./paths.ts";
import { commandName, type ShellAnalysis, type SimpleCommand } from "./shell.ts";

const SEARCH = new Set(["grep", "egrep", "fgrep", "rg"]);

interface SearchPaths {
  paths: string[];
  recursive: boolean;
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
  return { paths: paths.filter((file) => file !== "-"), recursive };
}

/** Không đọc nội dung; chỉ file thường mới chứng minh được không duyệt cây thư mục. */
export function isRegularFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/**
 * Lý do không thể kiểm đủ luật đường dẫn. Không mở rộng glob/quét cây trước rồi cho shell chạy:
 * shell có quy tắc riêng và tập file có thể đổi sau lúc kiểm. Cần đích file tường minh.
 */
export function unverifiableShellPaths(analysis: ShellAnalysis, cwd: string, home: string): string | undefined {
  if (analysis.commands.some((command) => command.glob.some(Boolean) || command.redirects.some((redirect) => redirect.glob))) {
    return "shell glob expansion has no verified set of paths";
  }
  if (!analysis.plain || analysis.commands.some((command) => command.wrapped)) return "shell constructs have no verified set of paths";
  if (analysis.commands.length > 1 && analysis.commands.some((command) => ["cd", "pushd", "popd"].includes(commandName(command)))) {
    return "the command changes directory before accessing paths";
  }
  for (const command of analysis.commands) {
    const name = commandName(command);
    const args = command.words.slice(1);
    if (SEARCH.has(name)) {
      const search = searchReadPaths(command);
      if (!search || search.paths.some((file) => !isRegularFile(resolveShellPath(file, cwd, home)))) {
        return `${name} may search a directory or an unverified set of files`;
      }
    }
    // diff FILE DIR đọc DIR/basename(FILE) cả khi không có -r; --from-file/--to-file cũng nhận thư mục.
    if (name === "diff") {
      let options = true;
      for (const arg of args) {
        if (options && arg === "--") { options = false; continue; }
        if (options && arg.startsWith("-")) {
          const key = arg.split("=", 1)[0];
          if (key.length > 2 && ["--from-file", "--to-file"].some((flag) => flag.startsWith(key))) {
            return "diff uses indirect file operands";
          }
        } else if (!isRegularFile(resolveShellPath(arg, cwd, home))) {
          return "diff may read files beneath a directory operand";
        }
      }
    }
    // Danh sách tên file đến từ file/stdin không phải các đích đã kiểm trong argv.
    if (["sort", "wc"].includes(name) && args.some((arg) => {
      const key = arg.split("=", 1)[0];
      return key.length > 2 && "--files0-from".startsWith(key);
    })) return `${name} reads an indirect list of paths`;
    // Các lệnh duyệt cây còn lại chưa có cơ chế lọc từng đích ở lúc thực thi.
    if (["find", "tree", "du"].includes(name) ||
      (["ls", "diff"].includes(name) && args.some((arg) => /^-[^-]*[rR]/u.test(arg) || (arg.length > 2 && "--recursive".startsWith(arg)))) ||
      (name === "git" && args.includes("grep"))) {
      return `${name} may read descendants that have not been checked`;
    }
  }
  return undefined;
}
