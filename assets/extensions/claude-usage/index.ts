import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatReport, formatStatus, mergeSnapshot, normalizeUsagePayload, parseUnifiedHeaders, type QuotaSnapshot, type UsageReport, USAGE_URL } from "./lib/quota.ts";

const STATUS_KEY = "claude-usage";
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_CHARS = 256 * 1024;

type ModelLike = { provider?: string } | undefined;

const isClaude = (model: ModelLike) => model?.provider === "anthropic";

/** Chỉ trả access token OAuth của Claude (sk-ant-oat…); API key không có quota gói. */
async function oauthToken(ctx: ExtensionContext): Promise<string | undefined> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
  return typeof key === "string" && key.includes("sk-ant-oat") ? key : undefined;
}

async function fetchUsage(token: string): Promise<unknown> {
  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.status === 429 ? "Anthropic giới hạn tần suất (HTTP 429), thử lại sau" : `HTTP ${response.status}`);
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_CHARS) throw new Error("phản hồi quá lớn");
  return JSON.parse(body);
}

/**
 * Quota Claude cho footer và /claude-usage. pi-usage chưa hỗ trợ Anthropic nên footer đọc
 * header anthropic-ratelimit-unified-* của chính các phản hồi Claude, không gửi thêm request.
 * Status key riêng "claude-usage" tránh tranh chấp với key "usage" do pi-usage xóa/ghi.
 */
export default function claudeUsage(pi: ExtensionAPI) {
  let snapshot: QuotaSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const setStatus = (ctx: ExtensionContext, value: string | undefined): boolean => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
      return true;
    } catch {
      return false; // Context cũ sau /new, /resume hoặc /reload.
    }
  };
  const publish = (ctx: ExtensionContext, model: ModelLike = ctx.model) => {
    clearTimer();
    const value = isClaude(model) ? formatStatus(snapshot) : undefined;
    // Đếm ngược tới reset được làm mới mỗi phút như footer Codex của pi-usage.
    if (setStatus(ctx, value) && value) {
      timer = setTimeout(() => publish(ctx), REFRESH_MS);
      timer.unref?.();
    }
  };

  pi.on("after_provider_response", (event, ctx) => {
    const parsed = parseUnifiedHeaders(event.headers);
    if (!parsed) return;
    snapshot = mergeSnapshot(snapshot, parsed);
    publish(ctx);
  });
  pi.on("session_start", (_event, ctx) => publish(ctx));
  pi.on("model_select", (event, ctx) => publish(ctx, event.model));
  pi.on("session_shutdown", (_event, ctx) => {
    clearTimer();
    setStatus(ctx, undefined);
  });

  pi.registerCommand("claude-usage", {
    description: "Xem quota Claude: phiên 5 giờ, tuần, extra usage",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/claude-usage không nhận tham số.", "warning");
        return;
      }
      const notes: string[] = [];
      let report: UsageReport | undefined;
      const token = await oauthToken(ctx);
      if (!token) {
        notes.push("Không có đăng nhập Claude OAuth hợp lệ (/login → Anthropic). API key không có quota gói.");
      } else {
        try {
          report = normalizeUsagePayload(await fetchUsage(token));
          snapshot = mergeSnapshot(snapshot, report.snapshot);
          publish(ctx);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          notes.push(`Không đọc được quota từ Anthropic: ${reason.slice(0, 160)}`);
        }
      }
      ctx.ui.notify(formatReport(report, snapshot, Date.now(), notes), notes.length && !report && !snapshot ? "warning" : "info");
    },
  });
}
