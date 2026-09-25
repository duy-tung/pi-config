import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  backoffAfterRateLimit, formatReport, formatStatus, mergeSnapshot, normalizeUsagePayload, parseUnifiedHeaders, POLL_MS,
  pollDueIn, type QuotaSnapshot, retryAfterMs, type UsageReport, USAGE_URL,
} from "./lib/quota.ts";

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

class UsageHttpError extends Error {
  status: number;
  retryAfter: number | undefined;
  constructor(status: number, retryAfter: number | undefined) {
    super(status === 429 ? "Anthropic giới hạn tần suất (HTTP 429), thử lại sau" : `HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function fetchUsage(token: string): Promise<unknown> {
  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new UsageHttpError(response.status, retryAfterMs(response.headers.get("retry-after")));
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_CHARS) throw new Error("phản hồi quá lớn");
  return JSON.parse(body);
}

type Poll = { ctx: ExtensionContext; timer?: ReturnType<typeof setTimeout>; busy: boolean; backoff: number };

/**
 * Quota Claude cho footer và /claude-usage. pi-usage chưa hỗ trợ Anthropic.
 * - Footer cập nhật từ header anthropic-ratelimit-unified-* của chính các phản hồi Claude.
 * - Phiên có UI đang dùng Claude (có đăng nhập OAuth) đọc /api/oauth/usage khi bắt đầu hoặc khi chuyển
 *   sang Claude, rồi 15 phút một lần nếu không có header mới hơn; bị 429 thì giãn dần tới 60 phút.
 *   Agent con và chế độ print không có footer nên không đọc.
 * Status key riêng "claude-usage" tránh tranh chấp với key "usage" do pi-usage xóa/ghi.
 */
export default function claudeUsage(pi: ExtensionAPI) {
  let snapshot: QuotaSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: Poll | undefined;

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

  const stopPolling = () => {
    if (poll?.timer) clearTimeout(poll.timer);
    poll = undefined;
  };
  const schedule = (state: Poll, delay: number) => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void refresh(state), delay);
    state.timer.unref?.();
  };
  /** Đọc lại khi dữ liệu (header hoặc lần đọc trước) đã cũ hơn POLL_MS; lỗi thì giữ dữ liệu cũ. */
  const refresh = async (state: Poll) => {
    state.timer = undefined;
    if (poll !== state || state.busy) return;
    const wait = pollDueIn(snapshot);
    if (wait > 0) return schedule(state, wait);
    state.busy = true;
    let next = POLL_MS;
    try {
      const token = await oauthToken(state.ctx);
      // Không có OAuth (chưa đăng nhập hoặc dùng API key): dừng tới lần bắt đầu phiên hay chọn model sau.
      if (!token) {
        if (poll === state) stopPolling();
        return;
      }
      const report = normalizeUsagePayload(await fetchUsage(token));
      if (poll !== state) return;
      snapshot = mergeSnapshot(snapshot, report.snapshot);
      state.backoff = POLL_MS;
      publish(state.ctx);
    } catch (error) {
      if (error instanceof UsageHttpError && error.status === 429) next = state.backoff = backoffAfterRateLimit(state.backoff, error.retryAfter);
    } finally {
      state.busy = false;
    }
    if (poll === state) schedule(state, next);
  };
  const startPolling = (ctx: ExtensionContext, model: ModelLike = ctx.model) => {
    stopPolling();
    if (!ctx.hasUI || !isClaude(model)) return;
    const state: Poll = { ctx, busy: false, backoff: POLL_MS };
    poll = state;
    schedule(state, pollDueIn(snapshot));
  };

  pi.on("after_provider_response", (event, ctx) => {
    const parsed = parseUnifiedHeaders(event.headers);
    if (!parsed) return;
    snapshot = mergeSnapshot(snapshot, parsed);
    publish(ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    publish(ctx);
    startPolling(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    publish(ctx, event.model);
    startPolling(ctx, event.model);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearTimer();
    stopPolling();
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
