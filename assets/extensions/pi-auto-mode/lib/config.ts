import fs from "node:fs";
import path from "node:path";

export type PermissionMode = "auto" | "bypass";

export interface AutoModeConfig {
  enabled: boolean;
  defaultMode: PermissionMode;
  disableBypass: boolean;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  /** Model phân loại "provider/id"; bỏ trống thì dùng model của phiên. */
  model?: string;
  /** Model cho giai đoạn 2 (mặc định = model). */
  stage2Model?: string;
  stage2Reasoning: string;
  timeoutMs: number;
  environment: string[];
  allowRules: string[];
  softDeny: string[];
  hardDeny: string[];
  stateDir: string;
  keys: string[];
  log: boolean;
  /** Ghi chú thêm về môi trường; nối vào slot environment. */
  source: string;
}

const DEFAULTS = {
  timeoutMs: 60_000,
  stage2Reasoning: "low",
  keys: ["shift+tab"],
};

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : undefined;
}

function mode(value: unknown): PermissionMode | undefined {
  if (value === "bypassPermissions" || value === "bypass" || value === "yolo") return "bypass";
  if (value === "auto" || value === "default" || value === "manual" || value === "acceptEdits") return "auto";
  return undefined;
}

export function parseMode(value: unknown): PermissionMode | undefined {
  return mode(typeof value === "string" ? value.trim() : value);
}

function readSettings(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Chỉ đọc settings của người dùng (agent dir). Settings của project nằm trong repo,
 * do nội dung repo điều khiển, nên không được chọn bypass hay thêm luật allow
 * (giống Claude Code chỉ nhận auto/bypass từ user/policy settings).
 */
export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): AutoModeConfig {
  const settings = readSettings(path.join(agentDir, "settings.json"));
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const auto = (settings.autoMode ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const disable = permissions.disableBypassPermissionsMode;
  const timeout = Number(auto.timeoutMs);
  return {
    enabled: env.PI_AUTO_MODE_DISABLE !== "1",
    defaultMode: mode(permissions.defaultMode) ?? "auto",
    disableBypass: disable === true || disable === "disable",
    allow: strings(permissions.allow) ?? [],
    ask: strings(permissions.ask) ?? [],
    deny: strings(permissions.deny) ?? [],
    additionalDirectories: strings(permissions.additionalDirectories) ?? [],
    model: text(auto.model),
    stage2Model: text(auto.stage2Model),
    stage2Reasoning: text(auto.stage2Reasoning) ?? DEFAULTS.stage2Reasoning,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5_000 ? timeout : DEFAULTS.timeoutMs,
    environment: strings(auto.environment) ?? ["$defaults"],
    allowRules: strings(auto.allow) ?? ["$defaults"],
    softDeny: strings(auto.soft_deny) ?? ["$defaults"],
    hardDeny: strings(auto.hard_deny) ?? ["$defaults"],
    stateDir: text(auto.stateDir) ?? path.join(agentDir, "pi-auto-mode"),
    keys: strings(auto.keys) ?? DEFAULTS.keys,
    log: auto.log === true || env.PI_AUTO_MODE_LOG === "1",
    source: path.join(agentDir, "settings.json"),
  };
}

/** Ghép danh sách người dùng với mặc định: "$defaults" chèn mặc định tại vị trí đó; không có thì thay hẳn. */
export function spliceDefaults(items: string[], defaults: string[]): string[] {
  if (!items.includes("$defaults")) return items;
  return items.flatMap((item) => (item === "$defaults" ? defaults : [item]));
}

/** Trạng thái lưu ngoài settings.json (file do bộ cài quản lý không bị sửa khi chạy). */
export interface PersistedState {
  bypassAccepted?: boolean;
  autoNoticeShown?: boolean;
}

export function readState(stateDir: string): PersistedState {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")) as PersistedState;
  } catch {
    return {};
  }
}

export function writeState(stateDir: string, state: PersistedState): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, "state.json");
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    /* không lưu được thì lần sau hỏi lại */
  }
}
