import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCountdown, formatReport, formatStatus, mergeSnapshot, normalizeUsagePayload, parseUnifiedHeaders,
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
