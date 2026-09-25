/**
 * Quota gói Claude (Pro/Max qua OAuth).
 * - Header anthropic-ratelimit-unified-* có trên mọi phản hồi OAuth: utilization là tỷ lệ 0..1,
 *   reset là epoch giây. Footer cập nhật từ nguồn này sau mỗi phản hồi Claude, không tốn request.
 * - GET /api/oauth/usage (endpoint Claude Code dùng cho /usage, chưa công bố) trả utilization
 *   theo phần trăm và resets_at ISO. Gọi khi người dùng chạy /claude-usage, và định kỳ khi phiên
 *   có UI đang dùng Claude mà dữ liệu cũ hơn POLL_MS (xem pollDueIn).
 */

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Chu kỳ đọc /api/oauth/usage; header mới hơn chu kỳ này thì không đọc. */
export const POLL_MS = 15 * 60_000;
/** Khoảng chờ tối đa sau khi Anthropic trả 429. */
export const MAX_POLL_MS = 60 * 60_000;

export interface QuotaWindow {
  /** Phần trăm đã dùng, 0..100. */
  usedPercent?: number;
  /** Thời điểm reset, epoch giây. */
  resetsAt?: number;
}

export interface QuotaSnapshot {
  capturedAt: number;
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  /** allowed | allowed_warning | rejected */
  status?: string;
  claim?: string;
  overageStatus?: string;
  overageInUse?: boolean;
  overageDisabledReason?: string;
}

export interface UsageReport {
  snapshot: QuotaSnapshot;
  weekly: Array<{ label: string; window: QuotaWindow }>;
  extra?: { enabled: boolean; used?: string; limit?: string; currency?: string };
}

const HEADER_PREFIX = "anthropic-ratelimit-unified-";

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function percent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function text(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  // Chuỗi từ mạng: bỏ ký tự điều khiển/ANSI trước khi đưa vào UI.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu, "").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function lowerKeys(headers: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
  }
  return result;
}

/** Đọc header quota; trả undefined khi phản hồi không phải của Claude OAuth. */
export function parseUnifiedHeaders(headers: Record<string, unknown> | undefined, now = Date.now()): QuotaSnapshot | undefined {
  const map = lowerKeys(headers);
  const get = (name: string) => map[`${HEADER_PREFIX}${name}`];
  const window = (key: string): QuotaWindow | undefined => {
    const used = finite(get(`${key}-utilization`));
    const reset = finite(get(`${key}-reset`));
    if (used === undefined && reset === undefined) return undefined;
    return {
      ...(used === undefined ? {} : { usedPercent: percent(used * 100) }),
      ...(reset === undefined ? {} : { resetsAt: Math.round(reset) }),
    };
  };
  const snapshot: QuotaSnapshot = { capturedAt: now };
  const fiveHour = window("5h");
  const sevenDay = window("7d");
  if (fiveHour) snapshot.fiveHour = fiveHour;
  if (sevenDay) snapshot.sevenDay = sevenDay;
  const status = text(get("status"), 32);
  if (status) snapshot.status = status;
  const claim = text(get("representative-claim"), 32);
  if (claim) snapshot.claim = claim;
  const overageStatus = text(get("overage-status"), 32);
  if (overageStatus) snapshot.overageStatus = overageStatus;
  const inUse = get("overage-in-use");
  if (inUse !== undefined) snapshot.overageInUse = inUse.trim().toLowerCase() === "true";
  const disabled = text(get("overage-disabled-reason"), 48);
  if (disabled) snapshot.overageDisabledReason = disabled;
  return fiveHour || sevenDay || status ? snapshot : undefined;
}

/** Thời gian chờ tới lần đọc /api/oauth/usage kế tiếp: 0 khi chưa có dữ liệu hoặc dữ liệu đã cũ hơn POLL_MS. */
export function pollDueIn(snapshot: QuotaSnapshot | undefined, now = Date.now()): number {
  if (!snapshot || !Number.isFinite(snapshot.capturedAt)) return 0;
  return Math.min(POLL_MS, Math.max(0, snapshot.capturedAt + POLL_MS - now));
}

/** Retry-After (số giây hoặc HTTP-date) đổi ra ms; giá trị không hợp lệ trả undefined. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Sau HTTP 429: gấp đôi khoảng chờ trước đó (trong [POLL_MS, MAX_POLL_MS]) và không sớm hơn Retry-After. */
export function backoffAfterRateLimit(previousMs: number, retryAfter?: number): number {
  const doubled = Math.min(MAX_POLL_MS, Math.max(POLL_MS, previousMs * 2));
  return Math.min(MAX_POLL_MS, Math.max(doubled, retryAfter ?? 0));
}

/** Phản hồi sau có thể thiếu một số header; giữ giá trị cũ cho phần không có. */
export function mergeSnapshot(previous: QuotaSnapshot | undefined, next: QuotaSnapshot): QuotaSnapshot {
  if (!previous) return next;
  const merged: QuotaSnapshot = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** Giống pi-usage: 45m, 2h10m, 4d3h. */
export function formatCountdown(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(now)) return undefined;
  const totalMinutes = Math.max(0, Math.ceil((resetsAt * 1000 - now) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : minutes > 0 ? `${minutes}m` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  return `${minutes}m`;
}

function remaining(window: QuotaWindow | undefined, now: number): { left: number; countdown?: string } | undefined {
  if (!window || window.usedPercent === undefined) return undefined;
  // Đã qua thời điểm reset: cửa sổ mới, chưa có dữ liệu dùng mới hơn.
  if (window.resetsAt !== undefined && window.resetsAt * 1000 <= now) return { left: 100 };
  return { left: Math.round(percent(100 - window.usedPercent)), countdown: formatCountdown(window.resetsAt, now) };
}

/** Footer theo kiểu Codex của pi-usage: phần trăm còn lại, ↻ đếm ngược tới reset. */
export function formatStatus(snapshot: QuotaSnapshot | undefined, now = Date.now()): string | undefined {
  if (!snapshot) return undefined;
  const parts = ["claude"];
  for (const [window, label] of [[snapshot.fiveHour, "5h"], [snapshot.sevenDay, "wk"]] as const) {
    const value = remaining(window, now);
    if (value) parts.push(`${value.left}% ${value.countdown ? `↻ ${value.countdown}` : label}`);
  }
  if (snapshot.overageInUse) parts.push("extra");
  else if (snapshot.status === "rejected") parts.push("limit");
  return parts.length > 1 ? parts.join(" ") : undefined;
}

function isoSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined;
}

function usageWindow(value: unknown, field = "utilization"): QuotaWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const used = finite(record[field]);
  const reset = isoSeconds(record.resets_at) ?? finite(record.resets_at);
  if (used === undefined && reset === undefined) return undefined;
  return {
    ...(used === undefined ? {} : { usedPercent: percent(used) }),
    ...(reset === undefined ? {} : { resetsAt: reset }),
  };
}

function money(amount: unknown, exponent: unknown): string | undefined {
  const value = finite(amount);
  if (value === undefined) return undefined;
  const digits = Math.min(6, Math.max(0, Math.trunc(finite(exponent) ?? 2)));
  return (value / 10 ** digits).toFixed(digits);
}

/** Chuẩn hóa JSON của /api/oauth/usage; trường lạ bị bỏ qua. */
export function normalizeUsagePayload(payload: unknown, now = Date.now()): UsageReport {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Phản hồi quota không hợp lệ");
  const data = payload as Record<string, unknown>;
  const snapshot: QuotaSnapshot = { capturedAt: now };
  const fiveHour = usageWindow(data.five_hour);
  const sevenDay = usageWindow(data.seven_day);
  if (fiveHour) snapshot.fiveHour = fiveHour;
  if (sevenDay) snapshot.sevenDay = sevenDay;
  const weekly: UsageReport["weekly"] = [];
  const addWeekly = (label: string | undefined, window: QuotaWindow | undefined) => {
    if (label && window && !weekly.some((entry) => entry.label.toLowerCase() === label.toLowerCase())) weekly.push({ label, window });
  };
  if (Array.isArray(data.limits)) {
    for (const limit of data.limits.slice(0, 10)) {
      if (!limit || typeof limit !== "object") continue;
      const record = limit as Record<string, unknown>;
      if (record.kind !== "weekly_scoped" && record.group !== "weekly") continue;
      const scope = record.scope as { model?: { display_name?: unknown } } | undefined;
      addWeekly(text(scope?.model?.display_name, 40), usageWindow(record, "percent"));
    }
  }
  addWeekly("Opus", usageWindow(data.seven_day_opus));
  addWeekly("Sonnet", usageWindow(data.seven_day_sonnet));
  addWeekly("OAuth apps", usageWindow(data.seven_day_oauth_apps));
  const report: UsageReport = { snapshot, weekly };
  const extra = data.extra_usage && typeof data.extra_usage === "object" ? data.extra_usage as Record<string, unknown> : undefined;
  if (extra && (extra.is_enabled === true || extra.credits_ever_enabled === true || extra.used_credits !== undefined)) {
    const spend = data.spend && typeof data.spend === "object" ? data.spend as Record<string, Record<string, unknown> | undefined> : {};
    report.extra = {
      enabled: extra.is_enabled === true,
      used: money(spend.used?.amount_minor ?? extra.used_credits, spend.used?.exponent ?? extra.decimal_places),
      limit: money(spend.limit?.amount_minor ?? extra.monthly_limit, spend.limit?.exponent ?? extra.decimal_places),
      currency: text(spend.used?.currency ?? extra.currency, 8),
    };
  }
  return report;
}

function describeWindow(window: QuotaWindow | undefined, now: number): string {
  if (!window || window.usedPercent === undefined) return "chưa có dữ liệu";
  const value = remaining(window, now);
  if (!value) return "chưa có dữ liệu";
  if (!value.countdown) return "đã reset";
  return `dùng ${Math.round(window.usedPercent)}% · còn ${value.left}% · reset sau ${value.countdown}`;
}

function describeAge(capturedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - capturedAt) / 60_000));
  return minutes === 0 ? "vừa xong" : `${minutes} phút trước`;
}

/**
 * Báo cáo cho /claude-usage (tiếng Việt, không chứa credential).
 * `report` là dữ liệu vừa đọc từ /api/oauth/usage; `snapshot` là trạng thái footer (header + lần đọc trước).
 */
export function formatReport(report: UsageReport | undefined, snapshot: QuotaSnapshot | undefined, now = Date.now(), notes: string[] = []): string {
  const lines = ["Claude usage (gói Pro/Max qua OAuth)"];
  const windows = report?.snapshot ?? snapshot;
  if (windows) {
    lines.push(`Phiên 5 giờ: ${describeWindow(windows.fiveHour, now)}`);
    lines.push(`Tuần: ${describeWindow(windows.sevenDay, now)}`);
  }
  for (const entry of report?.weekly ?? []) lines.push(`Tuần (${entry.label}): ${describeWindow(entry.window, now)}`);
  if (report?.extra) {
    const amount = report.extra.used !== undefined
      ? ` · đã dùng ${[report.extra.currency, report.extra.used].filter(Boolean).join(" ")}${report.extra.limit !== undefined ? `/${report.extra.limit}` : ""}`
      : "";
    lines.push(`Extra usage: ${report.extra.enabled ? "bật" : "tắt"}${amount}`);
  }
  if (snapshot?.status || snapshot?.overageInUse) {
    lines.push(`Trạng thái: ${[snapshot.status, snapshot.overageInUse ? "đang dùng extra usage" : undefined].filter(Boolean).join(", ")}`);
  }
  if (snapshot && !report) lines.push(`Theo header phản hồi Claude gần nhất (${describeAge(snapshot.capturedAt, now)}).`);
  if (!windows) lines.push("Chưa có dữ liệu quota: gửi một prompt bằng model Claude để Pi nhận header quota.");
  lines.push(...notes);
  return lines.join("\n");
}
