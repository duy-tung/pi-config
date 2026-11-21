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

test("footer: phần trăm còn lại và đếm ngược", () => {
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

/** Dạng thật của /api/oauth/usage ngày 2026-11-20 (rút gọn): không có phiên 5 giờ, một giới hạn tuần riêng cho "Fable". */
const scopedPayload = (at, fablePercent = 8) => ({
  five_hour: null,
  seven_day: { utilization: 8, resets_at: new Date(at + 4 * 86400_000 + 22 * 3600_000).toISOString(), limit_dollars: null },
  seven_day_oauth_apps: { utilization: 3, resets_at: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: "weekly_all", group: "weekly", percent: 8, resets_at: new Date(at + 4 * 86400_000 + 22 * 3600_000).toISOString(), scope: null, is_active: true },
    {
      kind: "weekly_scoped", group: "weekly", percent: fablePercent, severity: "normal",
      resets_at: new Date(at + 4 * 86400_000 + 22 * 3600_000 + 140).toISOString(),
      scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false,
    },
  ],
  weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 4, allowance_percent_of_weekly: 50 }],
});

test("footer: giới hạn tuần theo model lấy từ /api/oauth/usage", () => {
  const report = normalizeUsagePayload(scopedPayload(now), now);
  assert.deepEqual(report.snapshot.scoped.map((entry) => [entry.label, entry.window.usedPercent]), [["Fable", 8]]);
  assert.equal(report.snapshot.reportAt, now);
  assert.deepEqual(report.weekly.map((entry) => entry.label), ["Fable", "OAuth apps"], "OAuth apps chỉ có trong báo cáo, không vào footer");
  // Không có phiên 5 giờ; mốc reset của Fable trùng mốc tuần nên không lặp lại đếm ngược.
  assert.equal(formatStatus(report.snapshot, now), "claude 92% ↻ 4d22h fable 92%");
  assert.match(formatReport(report, report.snapshot, now), /Phiên 5 giờ: chưa có dữ liệu\nTuần: dùng 8% · còn 92% · reset sau 4d22h\nTuần \(Fable\): dùng 8% · còn 92%/u);

  // Header của phản hồi Claude không mang giới hạn theo model: giữ số của lần đọc endpoint.
  const afterHeader = mergeSnapshot(report.snapshot, parseUnifiedHeaders(unifiedHeaders(now + 60_000), now + 60_000));
  assert.equal(afterHeader.reportAt, now);
  assert.equal(formatStatus(afterHeader, now + 60_000), "claude 77% ↻ 2h10m 59% ↻ 4d3h fable 92% ↻ 4d21h", "Mốc reset khác mốc tuần thì hiện đếm ngược riêng");
  // Endpoint lỗi: /claude-usage vẫn in giới hạn theo model của lần đọc trước.
  assert.match(formatReport(undefined, afterHeader, now + 60_000), /Tuần \(Fable\): dùng 8%/u);
  // Lần đọc sau không còn giới hạn theo model thì footer bỏ phần đó.
  const cleared = mergeSnapshot(afterHeader, normalizeUsagePayload({ seven_day: { utilization: 50, resets_at: null } }, now + 120_000).snapshot);
  assert.deepEqual(cleared.scoped, []);
  assert.doesNotMatch(formatStatus(cleared, now + 120_000), /fable/u);

  // Tên từ mạng: chữ thường, không khoảng trắng, tối đa 12 ký tự; footer hiện tối đa 2 giới hạn, đã reset thì 100%.
  const many = normalizeUsagePayload({
    seven_day_opus: { utilization: 40, resets_at: new Date(now - 1000).toISOString() },
    seven_day_sonnet: { utilization: 10 },
    limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable  Extra Long\u001b[31m Name" } }, percent: 99.6 }],
  }, now);
  assert.deepEqual(many.snapshot.scoped.map((entry) => entry.label), ["Fable  Extra Long[31m Name", "Opus", "Sonnet"]);
  assert.equal(formatStatus(many.snapshot, now), "claude fable-extra 0% opus 100%");
});

test("lịch đọc khi có giới hạn theo model: tính từ lần đọc endpoint, header không làm lùi", () => {
  const snapshot = normalizeUsagePayload(scopedPayload(now), now).snapshot;
  assert.equal(pollDueIn(snapshot, now + 5 * 60_000), 10 * 60_000);
  const withHeader = mergeSnapshot(snapshot, parseUnifiedHeaders(unifiedHeaders(now + 14 * 60_000), now + 14 * 60_000));
  assert.equal(pollDueIn(withHeader, now + 14 * 60_000), 60_000);
  assert.equal(pollDueIn(withHeader, now + POLL_MS), 0);
  // Gói không có giới hạn theo model: header mới vẫn làm lùi lần đọc như trước.
  const plain = mergeSnapshot(normalizeUsagePayload({ seven_day: { utilization: 1 } }, now).snapshot,
    parseUnifiedHeaders(unifiedHeaders(now + 14 * 60_000), now + 14 * 60_000));
  assert.equal(pollDueIn(plain, now + POLL_MS), 14 * 60_000);
});

test("lịch đọc /api/oauth/usage: 15 phút, header mới thì đợi, 429 giãn tới 60 phút", () => {
  assert.equal(pollDueIn(undefined, now), 0);
  const read = now - 3600_000;
  assert.equal(pollDueIn({ capturedAt: now - 5 * 60_000, reportAt: read }, now), 10 * 60_000);
  assert.equal(pollDueIn({ capturedAt: now - POLL_MS - 1, reportAt: read }, now), 0);
  assert.equal(pollDueIn({ capturedAt: now + 3600_000, reportAt: read }, now), POLL_MS, "Đồng hồ lệch không làm dừng hẳn việc đọc");
  assert.equal(pollDueIn({ capturedAt: now }, now), 0, "Chưa đọc được endpoint lần nào thì header mới không làm lùi lần đọc");
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
  handlers.model_select({ model: { provider: "opencode-go", id: "glm-5.3" } }, context({ model: { provider: "opencode-go" } }));
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

test("claude-usage: gói có giới hạn theo model thì đọc endpoint đều 15 phút dù header vẫn về", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const handlers = {};
  claudeUsage({ on: (name, handler) => { handlers[name] = handler; }, registerCommand: () => {} });
  const requests = [];
  let fablePercent = 8;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json(scopedPayload(now, fablePercent));
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const advance = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  const statuses = [];
  const ctx = {
    hasUI: true, model: { provider: "anthropic", id: "claude-opus-5-5" }, ui: { setStatus: (key, value) => statuses.push(value) },
    modelRegistry: { getApiKeyForProvider: async () => "sk-ant-oat01-unit" },
  };
  handlers.session_start({}, ctx);
  await advance(0);
  assert.equal(requests.length, 1);
  assert.equal(statuses.at(-1), "claude 92% ↻ 4d22h fable 92%");
  // Header về liên tục (đang làm việc): footer giữ phần Fable, và endpoint vẫn được đọc ở phút 15.
  fablePercent = 30;
  await advance(5 * 60_000);
  handlers.after_provider_response({ headers: unifiedHeaders(Date.now()) }, ctx);
  assert.match(statuses.at(-1), /^claude 77% ↻ 2h10m 59% ↻ 4d3h fable 92% ↻ 4d2\dh/u);
  await advance(9 * 60_000);
  handlers.after_provider_response({ headers: unifiedHeaders(Date.now()) }, ctx);
  assert.equal(requests.length, 1);
  await advance(60_000);
  assert.equal(requests.length, 2);
  assert.match(statuses.at(-1), /fable 70%/u);
  await advance(POLL_MS);
  assert.equal(requests.length, 3);
  handlers.session_shutdown({}, ctx);
  await advance(3 * MAX_POLL_MS);
  assert.equal(requests.length, 3);
});

test("claude-usage: lần đọc endpoint đầu tiên lỗi thì header không làm lùi lần đọc lại", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const handlers = {};
  claudeUsage({ on: (name, handler) => { handlers[name] = handler; }, registerCommand: () => {} });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => (++calls === 1 ? new Response("", { status: 500 }) : Response.json(scopedPayload(Date.now())));
  t.after(() => { globalThis.fetch = originalFetch; });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const advance = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  const statuses = [];
  const ctx = {
    hasUI: true, model: { provider: "anthropic", id: "claude-opus-5-5" }, ui: { setStatus: (key, value) => statuses.push(value) },
    modelRegistry: { getApiKeyForProvider: async () => "sk-ant-oat01-unit" },
  };
  handlers.session_start({}, ctx);
  await advance(0);
  assert.equal(calls, 1);
  await advance(10 * 60_000);
  handlers.after_provider_response({ headers: unifiedHeaders(Date.now()) }, ctx);
  assert.doesNotMatch(statuses.at(-1), /fable/u);
  await advance(5 * 60_000);
  assert.equal(calls, 2, "Header về ở phút 10 không làm lùi lần đọc lại ở phút 15");
  assert.match(statuses.at(-1), /fable 92%/u);
  handlers.session_shutdown({}, ctx);
});
