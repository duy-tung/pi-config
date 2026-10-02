import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RewindConfig {
  enabled: boolean;
  storageDir: string;
  retentionDays: number;
  /** git status + chụp file bẩn chậm hơn ngưỡng này thì ngừng theo dõi repo trong phiên (test đặt cao hơn). */
  watchSlowMs: number;
}

/** File lớn hơn mức này không được chụp. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Tổng dung lượng blob tối đa; lần dọn hằng ngày xóa blob tham chiếu lâu nhất (best-effort). */
export const MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
/** Tool có thể sửa file ngoài edit/write; được theo dõi bằng git status trước/sau. */
export const WATCH_TOOLS = ["bash", "powershell", "Agent"];
/** Số file chưa commit tối đa để theo dõi bash/Agent. */
export const WATCH_MAX_DIRTY = 500;
/** Tổng dung lượng file chưa commit cần chụp trước mỗi bash/Agent; vượt thì ngừng theo dõi repo trong phiên. */
export const WATCH_MAX_BYTES = 256 * 1024 * 1024;

export const DEFAULTS: Omit<RewindConfig, "storageDir"> = { enabled: true, retentionDays: 30, watchSlowMs: 2000 };

function readJson(file: string): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/**
 * Đọc khối `rewind` trong settings.json của agent (không đọc settings của project:
 * project chưa được trust không được đổi nơi lưu nội dung file).
 */
export function loadConfig(agentDir: string): RewindConfig & { doubleEscapeAction: string } {
  const settings = readJson(path.join(agentDir, "settings.json"));
  const raw = (settings.rewind && typeof settings.rewind === "object" ? settings.rewind : {}) as Record<string, unknown>;
  const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);
  const storage = typeof raw.storageDir === "string" && raw.storageDir.trim() ? expandHome(raw.storageDir.trim()) : path.join(agentDir, "rewind");
  return {
    enabled: raw.enabled !== false && process.env.PI_REWIND_DISABLE !== "1",
    storageDir: path.isAbsolute(storage) ? storage : path.resolve(agentDir, storage),
    retentionDays: number(raw.retentionDays, DEFAULTS.retentionDays),
    watchSlowMs: number(raw.watchSlowMs, DEFAULTS.watchSlowMs),
    doubleEscapeAction: typeof settings.doubleEscapeAction === "string" ? settings.doubleEscapeAction : "tree",
  };
}
