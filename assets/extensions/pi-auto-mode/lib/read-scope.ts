import fs from "node:fs";
import { commandName, type SimpleCommand } from "./shell.ts";

const SEARCH = new Set(["grep", "egrep", "fgrep", "rg"]);
/** Cờ ngắn của rg nhận giá trị: phần còn lại của cụm cờ là giá trị, không phải cờ khác. */
const RG_SHORT_VALUES = "ABCEefgMjmtTr";

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
  const shortValues = rg ? RG_SHORT_VALUES : "ABCDdefm";
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

/** Trả về luật deny (chuỗi gốc) chặn đọc file này, kể cả ngoại lệ !Path; undefined = được đọc. */
export type DeniedPath = (file: string) => string | undefined;

export function denies(file: string, denied: DeniedPath, link = true): { file: string; rule: string } | undefined {
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
