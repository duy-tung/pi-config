import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[  -   　]/gu;

/** Cùng quy tắc resolveToCwd của tool write/edit: bỏ tiền tố @, mở rộng ~, file://, khoảng trắng Unicode. */
export function resolveToolPath(input: unknown, cwd: string): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  let value = input.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (process.platform === "win32") {
    const drive = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
    if (drive && !value.startsWith("//")) value = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) value = path.join(os.homedir(), value.slice(2));
  else if (value.startsWith("file://")) value = fileURLToPath(value);
  return path.resolve(cwd, value);
}

export function displayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}
