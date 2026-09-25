import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RewindConfig {
  enabled: boolean;
  storageDir: string;
  retentionDays: number;
  maxFileBytes: number;
  /** Tổng dung lượng blob tối đa; lần dọn hằng ngày xóa blob tham chiếu lâu nhất (best-effort). */
  maxStorageBytes: number;
  /** Tool có thể sửa file ngoài edit/write; được theo dõi bằng git status trước/sau. */
  watchTools: string[];
  /** git status + chụp file bẩn chậm hơn ngưỡng này thì ngừng theo dõi repo trong phiên. */
  watchSlowMs: number;
  /** Số file chưa commit tối đa để theo dõi bash/Agent. */
  watchMaxDirty: number;
  /** Tổng dung lượng file chưa commit cần chụp trước mỗi bash/Agent; vượt thì ngừng theo dõi repo trong phiên. */
  watchMaxBytes: number;
  /** Esc Esc mở Rewind; cần doubleEscapeAction "none" để không trùng /tree của Pi. */
  doubleEscape: boolean;
}

export const DEFAULTS: Omit<RewindConfig, "storageDir"> = {
  enabled: true,
  retentionDays: 30,
  maxFileBytes: 20 * 1024 * 1024,
  maxStorageBytes: 2 * 1024 * 1024 * 1024,
  watchTools: ["bash", "powershell", "Agent"],
  watchSlowMs: 2000,
  watchMaxDirty: 500,
  watchMaxBytes: 256 * 1024 * 1024,
  doubleEscape: true,
};

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
    maxFileBytes: number(raw.maxFileBytes, DEFAULTS.maxFileBytes),
    maxStorageBytes: number(raw.maxStorageBytes, DEFAULTS.maxStorageBytes),
    watchTools: Array.isArray(raw.watchTools) ? raw.watchTools.filter((item): item is string => typeof item === "string") : DEFAULTS.watchTools,
    watchSlowMs: number(raw.watchSlowMs, DEFAULTS.watchSlowMs),
    watchMaxDirty: number(raw.watchMaxDirty, DEFAULTS.watchMaxDirty),
    watchMaxBytes: number(raw.watchMaxBytes, DEFAULTS.watchMaxBytes),
    doubleEscape: raw.doubleEscape !== false,
    doubleEscapeAction: typeof settings.doubleEscapeAction === "string" ? settings.doubleEscapeAction : "tree",
  };
}
