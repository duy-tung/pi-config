import fs from "node:fs";
import path from "node:path";

/**
 * Như Claude Code: manual (mode default) hỏi người dùng thay cho bộ phân loại, kể cả sửa file; acceptEdits như manual
 * nhưng sửa file và mkdir/touch/rm/rmdir/mv/cp/sed trong workspace chạy ngay; auto: bộ phân loại duyệt; bypass: không
 * kiểm, trừ luật deny/ask và rm vào đường dẫn quan trọng.
 */
export type PermissionMode = "manual" | "acceptEdits" | "auto" | "bypass";

/**
 * Thứ tự Shift+Tab như Claude Code: manual → acceptEdits → bypass → auto → manual. Bypass chỉ có trong vòng khi phiên
 * được mở với bypass (cờ dòng lệnh hoặc defaultMode trong settings của người dùng).
 */
export const MODES: PermissionMode[] = ["manual", "acceptEdits", "bypass", "auto"];

export function availableModes(bypassAvailable: boolean): PermissionMode[] {
  return MODES.filter((mode) => mode !== "bypass" || bypassAvailable);
}

/** Mode hỏi người dùng thay cho bộ phân loại (không gọi model nào để duyệt). */
export const prompts = (mode: PermissionMode): boolean => mode === "manual" || mode === "acceptEdits";

export function nextMode(mode: PermissionMode, bypassAvailable = false): PermissionMode {
  const modes = availableModes(bypassAvailable || mode === "bypass");
  return modes[(modes.indexOf(mode) + 1) % modes.length];
}

/**
 * Giai đoạn 1 và probe prompt injection bằng Jev (System One của TypeSafe); chỉ chạy khi có API key.
 * Ngưỡng là hằng số trong code (JEV_TUNING của lib/jev.ts).
 */
export interface JevConfig {
  enabled: boolean;
  /** Model ghim phiên bản (ngưỡng được chỉnh theo phiên bản). */
  model: string;
}

export interface AutoModeConfig {
  enabled: boolean;
  defaultMode: PermissionMode;
  disableBypass: boolean;
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  /** permissions.blockReadsOutsideWorkingDirectories: tool đọc file từ chối đọc ngoài workspace ở mọi mode. */
  blockOutsideReads: boolean;
  /** Thư mục skill trong `skills` của settings (đọc tự do, như thư mục làm việc). */
  skills: string[];
  /** Model phân loại "provider/id" cho cả hai giai đoạn; bỏ trống thì dùng model của phiên. */
  model?: string;
  stage2Reasoning: string;
  timeoutMs: number;
  environment: string[];
  allowRules: string[];
  softDeny: string[];
  hardDeny: string[];
  stateDir: string;
  log: boolean;
  /** File settings.json đã đọc (hiện ở /permissions → Rules). */
  source: string;
  jev: JevConfig;
}

const DEFAULTS = {
  timeoutMs: 60_000,
  stage2Reasoning: "low",
};

export const JEV_MODEL = "jev-1.13.0";

/** `autoMode.jev`: false hoặc {enabled: false} tắt hẳn (cả giai đoạn 1 lẫn probe); `model` sai thì dùng mặc định. */
export function parseJev(value: unknown): JevConfig {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const model = typeof raw.model === "string" && raw.model.trim() && raw.model.length <= 128 ? raw.model.trim() : JEV_MODEL;
  return { enabled: value !== false && raw.enabled !== false, model };
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : undefined;
}

/**
 * `manual`, `acceptEdits`, `auto`, `bypass` và tên của Claude Code (`default` = manual, `bypassPermissions` = bypass),
 * bỏ khoảng trắng hai đầu; giá trị khác là undefined.
 */
export function parseMode(value: unknown): PermissionMode | undefined {
  const text = typeof value === "string" ? value.trim() : value;
  if (text === "bypassPermissions" || text === "bypass") return "bypass";
  if (text === "manual" || text === "default") return "manual";
  if (text === "acceptEdits") return "acceptEdits";
  if (text === "auto") return "auto";
  return undefined;
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
    defaultMode: parseMode(permissions.defaultMode) ?? "auto",
    disableBypass: disable === true || disable === "disable",
    allow: strings(permissions.allow) ?? [],
    ask: strings(permissions.ask) ?? [],
    deny: strings(permissions.deny) ?? [],
    additionalDirectories: strings(permissions.additionalDirectories) ?? [],
    blockOutsideReads: permissions.blockReadsOutsideWorkingDirectories === true,
    skills: strings(settings.skills) ?? [],
    model: text(auto.model),
    stage2Reasoning: text(auto.stage2Reasoning) ?? DEFAULTS.stage2Reasoning,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5_000 ? timeout : DEFAULTS.timeoutMs,
    environment: strings(auto.environment) ?? ["$defaults"],
    allowRules: strings(auto.allow) ?? ["$defaults"],
    softDeny: strings(auto.soft_deny) ?? ["$defaults"],
    hardDeny: strings(auto.hard_deny) ?? ["$defaults"],
    stateDir: text(auto.stateDir) ?? path.join(agentDir, "pi-auto-mode"),
    log: auto.log === true || env.PI_AUTO_MODE_LOG === "1",
    source: path.join(agentDir, "settings.json"),
    jev: parseJev(auto.jev),
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
  jevNoticeShown?: boolean;
  /** "Yes, and keep allowing any reads outside the working directories" ở lần đọc đầu của auto mode. */
  outsideReadsAccepted?: boolean;
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

// ---------------------------------------------------------------------------
// Model của bộ phân loại: chỉ đổi trong /permissions, lưu vào settings.json của agent dir
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Nội dung settings.json mới sau khi `mutate` sửa object settings; mọi khóa khác (và thứ tự khóa, BOM, newline cuối)
 * giữ nguyên. Ném lỗi khi file không phải object JSON, để không ghi đè file hỏng.
 */
export function withSettings(source: string, mutate: (settings: Record<string, unknown>) => void): string {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = source.slice(bom.length);
  const settings: unknown = body.trim() ? JSON.parse(body) : {};
  if (!isRecord(settings)) throw new Error("settings.json is not a JSON object");
  mutate(settings);
  return `${bom}${JSON.stringify(settings, null, 2)}${!body.trim() || body.endsWith("\n") ? "\n" : ""}`;
}

/** Nội dung settings.json mới với `autoMode.model` và `autoMode.stage2Reasoning` đổi. */
export function withClassifier(source: string, model: string, reasoning: string): string {
  return withSettings(source, (settings) => {
    if (!isRecord(settings.autoMode)) settings.autoMode = {};
    Object.assign(settings.autoMode as Record<string, unknown>, { model, stage2Reasoning: reasoning });
  });
}

/** Nội dung settings.json mới với `permissions.blockReadsOutsideWorkingDirectories: true`. */
export function withBlockedOutsideReads(source: string): string {
  return withSettings(source, (settings) => {
    if (!isRecord(settings.permissions)) settings.permissions = {};
    (settings.permissions as Record<string, unknown>).blockReadsOutsideWorkingDirectories = true;
  });
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Khóa `<file>.lock` theo cách proper-lockfile của SettingsManager của Pi (thư mục khóa; cũ hơn 10 giây là bị bỏ
 * lại), để không ghi xen giữa một lần Pi đọc-sửa-ghi settings.json.
 */
function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > 10_000;
      } catch {
        stale = true;
      }
      if (stale) fs.rmSync(lock, { recursive: true, force: true });
      else if (attempt >= 50) throw new Error(`${file} is locked by another process; try again`);
      else sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Sửa settings.json: đọc-sửa-ghi dưới khóa của Pi, ghi qua file tạm rồi đổi tên, giữ quyền của file (0600 khi chưa
 * có). Pi chỉ ghi lại các khóa nó đổi (đọc lại file trước khi ghi), nên không đè giá trị này.
 */
export function saveSettings(file: string, edit: (source: string) => string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(file, () => {
    let source = "";
    let mode = 0o600;
    try {
      source = fs.readFileSync(file, "utf8");
      mode = fs.statSync(file).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = edit(source);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, next, { mode });
      fs.chmodSync(temporary, mode);
      fs.renameSync(temporary, file);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  });
}

/** Lưu model của bộ phân loại vào settings.json. */
export function saveClassifier(file: string, model: string, reasoning: string): void {
  saveSettings(file, (source) => withClassifier(source, model, reasoning));
}
