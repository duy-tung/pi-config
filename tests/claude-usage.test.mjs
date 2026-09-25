import assert from "node:assert/strict";
import test from "node:test";
import claudeUsage from "../assets/extensions/claude-usage/index.ts";
import {
  backoffAfterRateLimit, formatCountdown, formatReport, formatStatus, MAX_POLL_MS, mergeSnapshot, normalizeUsagePayload,
  parseUnifiedHeaders, POLL_MS, pollDueIn, retryAfterMs,
} from "../assets/extensions/claude-usage/lib/quota.ts";
import { unifiedHeaders } from "./search-fixtures.mjs";

const now = Date.UTC(2026, 8, 24, 8, 0, 0);

test("header quota Claude: tỷ lệ thành phần trăm, reset epoch giây", () => {
  const snapshot = parseUnifiedHeaders(unifiedHeaders(now), now);
  assert.deepEqual(snapshot.fiveHour, { usedPercent: 23, resetsAt: now / 1000 + 7800 });
  assert.equal(snapshot.sevenDay.usedPercent, 41);
  assert.equal(snapshot.status, "allowed");
  assert.equal(snapshot.claim, "five_hour");
  assert.equal(parseUnifiedHeaders({ "anthropic-ratelimit-requests-remaining": "10" }, now), undefined);
  assert.equal(parseUnifiedHeaders({ "Anthropic-Ratelimit-Unified-Status": "rejected" }, now).status, "rejected");
});

test("footer giống Codex: phần trăm còn lại và đếm ngược", () => {
  const snapshot = parseUnifiedHeaders(unifiedHeaders(now), now);
  assert.equal(formatStatus(snapshot, now), "claude 77% ↻ 2h10m 59% ↻ 4d3h");
  assert.equal(formatStatus(snapshot, now + 3 * 3600 * 1000), "claude 100% 5h 59% ↻ 4d");
  assert.equal(formatStatus({ ...snapshot, overageInUse: true }, now), "claude 77% ↻ 2h10m 59% ↻ 4d3h extra");
  assert.equal(formatStatus({ ...snapshot, status: "rejected" }, now), "claude 77% ↻ 2h10m 59% ↻ 4d3h limit");
  assert.equal(formatStatus({ capturedAt: now, status: "allowed" }, now), undefined);
  assert.equal(formatCountdown(now / 1000 + 45 * 60, now), "45m");
  assert.equal(formatCountdown(now / 1000 + 2 * 86400, now), "2d");
  const merged = mergeSnapshot(snapshot, { capturedAt: now + 1, status: "allowed_warning" });
  assert.equal(merged.fiveHour.usedPercent, 23);
  assert.equal(merged.status, "allowed_warning");
});

test("chuẩn hóa /api/oauth/usage và báo cáo tiếng Việt", () => {
  const report = normalizeUsagePayload({
    five_hour: { utilization: 23.4, resets_at: new Date(now + 3600_000).toISOString() },
    seven_day: { utilization: 41, resets_at: new Date(now + 86400_000).toISOString() },
    seven_day_opus: { utilization: 12, resets_at: null },
    limits: [
      { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 55, resets_at: new Date(now + 7200_000).toISOString() },
      { kind: "other", scope: { model: { display_name: "Ignored" } }, percent: 1 },
    ],
    extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 5000, currency: "USD" },
    unknown: { nested: true },
  }, now);
  assert.equal(report.snapshot.fiveHour.usedPercent, 23.4);
  assert.deepEqual(report.weekly.map((entry) => entry.label), ["Fable", "Opus"]);
  assert.deepEqual(report.extra, { enabled: true, used: "12.34", limit: "50.00", currency: "USD" });
  const text = formatReport(report, parseUnifiedHeaders(unifiedHeaders(now), now), now, ["ghi chú"]);
  assert.match(text, /Phiên 5 giờ: dùng 23% · còn 77% · reset sau 1h/u);
  assert.match(text, /Tuần \(Fable\): dùng 55%/u);
  assert.match(text, /Extra usage: bật · đã dùng USD 12\.34\/50\.00/u);
  assert.match(text, /Trạng thái: allowed/u);
  assert.match(text, /ghi chú$/u);
  assert.match(formatReport(undefined, undefined, now), /Chưa có dữ liệu quota/u);
  assert.throws(() => normalizeUsagePayload([], now), /không hợp lệ/u);
});

test("lịch đọc /api/oauth/usage: 15 phút, header mới thì đợi, 429 giãn tới 60 phút", () => {
  assert.equal(pollDueIn(undefined, now), 0);
  assert.equal(pollDueIn({ capturedAt: now - 5 * 60_000 }, now), 10 * 60_000);
  assert.equal(pollDueIn({ capturedAt: now - POLL_MS - 1 }, now), 0);
  assert.equal(pollDueIn({ capturedAt: now + 3600_000 }, now), POLL_MS, "Đồng hồ lệch không làm dừng hẳn việc đọc");
  assert.equal(retryAfterMs("120", now), 120_000);
  assert.equal(retryAfterMs(new Date(now + 90_000).toUTCString(), now), 90_000);
  assert.equal(retryAfterMs("soon", now), undefined);
  assert.equal(retryAfterMs(null, now), undefined);
  assert.equal(backoffAfterRateLimit(POLL_MS), 2 * POLL_MS);
  assert.equal(backoffAfterRateLimit(2 * POLL_MS), MAX_POLL_MS);
  assert.equal(backoffAfterRateLimit(MAX_POLL_MS), MAX_POLL_MS);
  assert.equal(backoffAfterRateLimit(POLL_MS, 45 * 60_000), 45 * 60_000);
  assert.equal(backoffAfterRateLimit(POLL_MS, 5 * 3600_000), MAX_POLL_MS);
});

test("claude-usage tự đọc quota khi phiên có UI dùng Claude, dừng khi đổi model", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const handlers = {};
  claudeUsage({ on: (name, handler) => { handlers[name] = handler; }, registerCommand: () => {} });
  const requests = [], replies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.Authorization, at: Date.now() });
    return replies.shift() ?? Response.json({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600_000).toISOString() } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const advance = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  const claude = { provider: "anthropic", id: "claude-opus-5-5" };
  const statuses = [];
  const context = (overrides = {}) => ({
    hasUI: true, model: claude, ui: { setStatus: (key, value) => statuses.push(value) },
    modelRegistry: { getApiKeyForProvider: async () => "sk-ant-oat01-unit" }, ...overrides,
  });

  // Phiên có UI đang dùng Claude: đọc ngay khi bắt đầu, rồi 15 phút một lần.
  const ctx = context();
  handlers.session_start({}, ctx);
  await advance(0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(requests[0].authorization, "Bearer sk-ant-oat01-unit");
  assert.match(statuses.at(-1), /^claude 88% ↻ 1h/u);
  await advance(POLL_MS - 1);
  assert.equal(requests.length, 1);
  await advance(1);
  assert.equal(requests.length, 2);
  // Header của phản hồi Claude mới hơn: lần đọc kế tiếp lùi lại cho đủ 15 phút tính từ header.
  await advance(5 * 60_000);
  handlers.after_provider_response({ headers: unifiedHeaders(Date.now()) }, ctx);
  await advance(10 * 60_000);
  assert.equal(requests.length, 2);
  await advance(5 * 60_000);
  assert.equal(requests.length, 3);
  // 429: 30 phút, rồi 60 phút (tối đa), Retry-After dài vẫn giữ trần 60 phút; đọc được thì về 15 phút.
  replies.push(new Response("", { status: 429 }), new Response("", { status: 429 }),
    new Response("", { status: 429, headers: { "retry-after": "18000" } }));
  await advance(POLL_MS);
  assert.equal(requests.length, 4);
  await advance(2 * POLL_MS - 1);
  assert.equal(requests.length, 4);
  await advance(1);
  assert.equal(requests.length, 5);
  await advance(MAX_POLL_MS);
  assert.equal(requests.length, 6);
  await advance(MAX_POLL_MS);
  assert.equal(requests.length, 7);
  await advance(POLL_MS);
  assert.equal(requests.length, 8);
  // Chuyển sang model khác Claude thì dừng; quay lại Claude khi dữ liệu còn mới thì chưa đọc.
  handlers.model_select({ model: { provider: "openai-codex", id: "gpt-6-sol" } }, context({ model: { provider: "openai-codex" } }));
  assert.equal(statuses.at(-1), undefined);
  await advance(3 * MAX_POLL_MS);
  assert.equal(requests.length, 8);
  handlers.model_select({ model: claude }, ctx);
  await advance(0);
  assert.equal(requests.length, 9, "Dữ liệu đã cũ hơn 15 phút nên đọc ngay");
  handlers.session_shutdown({}, ctx);
  await advance(3 * MAX_POLL_MS);
  assert.equal(requests.length, 9);

  // Agent con/chế độ print (không UI) và đăng nhập bằng API key: không đọc.
  handlers.session_start({}, context({ hasUI: false }));
  await advance(MAX_POLL_MS);
  handlers.session_start({}, context({ modelRegistry: { getApiKeyForProvider: async () => "sk-ant-api03-unit" } }));
  await advance(MAX_POLL_MS);
  assert.equal(requests.length, 9);
  handlers.session_shutdown({}, ctx);
});
