import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneBackups } from "../lib/backups.mjs";

test("pruneBackups giữ bản runtime/nguồn mới nhất mỗi tên, 3 bản tài nguyên, không động tới backup cấu hình", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-backups-"));
  try {
    const names = [
      "runtime-current-100", "runtime-current-300", "runtime-current-200", "runtime-firecrawl-50",
      "source-firecrawl-cli-10", "source-firecrawl-cli-20", "resources-1", "resources-2", "resources-3", "resources-4",
      "2026-09-30T08-21-01.123Z", "2025-01-01T00-00-00.000Z", "notes",
    ];
    for (const name of names) fs.mkdirSync(path.join(root, "backups", name, "node_modules"), { recursive: true });
    const removed = pruneBackups(root).map((file) => path.basename(file)).sort();
    assert.deepEqual(removed, ["resources-1", "runtime-current-100", "runtime-current-200", "source-firecrawl-cli-10"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "backups")).sort(), [
      "2025-01-01T00-00-00.000Z", "2026-09-30T08-21-01.123Z", "notes", "resources-2", "resources-3", "resources-4",
      "runtime-current-300", "runtime-firecrawl-50", "source-firecrawl-cli-20",
    ]);
    assert.deepEqual(pruneBackups(root), []);
    assert.deepEqual(pruneBackups(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
