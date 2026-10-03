import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneBackups } from "../lib/backups.mjs";

test("pruneBackups xoá mọi bản runtime/nguồn cũ, giữ 3 bản tài nguyên, không xoá thư mục cấu hình rỗng sẵn hay mục lạ", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-backups-"));
  try {
    const names = [
      "runtime-current-100", "runtime-current-300", "runtime-current-200", "runtime-firecrawl-50",
      "source-firecrawl-cli-10", "source-firecrawl-cli-20", "resources-1", "resources-2", "resources-3", "resources-4",
      "2026-09-30T08-21-01.123Z", "2025-01-01T00-00-00.000Z", "notes",
    ];
    for (const name of names) fs.mkdirSync(path.join(root, "backups", name, "node_modules"), { recursive: true });
    const removed = pruneBackups(root).map((file) => path.basename(file)).sort();
    assert.deepEqual(removed, ["resources-1", "runtime-current-100", "runtime-current-200", "runtime-current-300", "runtime-firecrawl-50", "source-firecrawl-cli-10", "source-firecrawl-cli-20"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "backups")).sort(), [
      "2025-01-01T00-00-00.000Z", "2026-09-30T08-21-01.123Z", "notes", "resources-2", "resources-3", "resources-4",
    ]);
    assert.deepEqual(pruneBackups(root), []);
    assert.deepEqual(pruneBackups(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneBackups giữ 20 backup cấu hình mới nhất mỗi file, chỉ xoá thư mục thời điểm khi đã rỗng", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-backups-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backups = path.join(root, "backups");
  const write = (file, text = "x") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const settings = path.join("parent", ".pi", "agent", "settings.json");
  // 25 lần ghi đè settings.json; lần cũ nhất (00) ghi cùng lúc với AGENTS.md (chỉ 2 bản, phải giữ).
  const stamps = Array.from({ length: 25 }, (_, i) => `2026-09-${String(10 + i).padStart(2, "0")}T00-00-00.000Z`);
  for (const stamp of stamps) write(path.join(backups, stamp, settings), stamp);
  write(path.join(backups, stamps[0], "assets", "AGENTS.md"));
  write(path.join(backups, stamps[24].replace("T00", "T01"), "assets", "AGENTS.md"));
  // Mục lạ: không theo quy tắc nào, không bị xoá; symlink trong thư mục thời điểm không bị đếm hay đi theo.
  write(path.join(backups, "advisor.js"));
  write(path.join(backups, "advisor.json.user-2026-09-25"));
  write(path.join(backups, "2026-09-01-notes", settings));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const outside = path.join(root, "outside", settings);
  write(outside, "keep");
  fs.symlinkSync(path.join(root, "outside"), path.join(backups, stamps[1], "linked"), linkType);
  fs.symlinkSync(path.join(backups, stamps[2]), path.join(backups, "2026-01-01T00-00-00.000Z"), linkType);

  const removed = pruneBackups(root).map((file) => path.relative(backups, file)).sort();
  assert.deepEqual(removed, stamps.slice(0, 5).map((stamp) => path.join(stamp, settings)));
  const left = fs.readdirSync(backups).sort();
  assert.ok(left.includes(stamps[0]), "còn AGENTS.md nên giữ thư mục");
  assert.deepEqual(fs.readdirSync(path.join(backups, stamps[0])), ["assets"]);
  assert.ok(left.includes(stamps[1]) && fs.lstatSync(path.join(backups, stamps[1], "linked")).isSymbolicLink(), "symlink giữ thư mục");
  for (const stamp of stamps.slice(2, 5)) assert.ok(!left.includes(stamp), `${stamp} rỗng nên bị xoá`);
  for (const stamp of stamps.slice(5)) assert.equal(fs.readFileSync(path.join(backups, stamp, settings), "utf8"), stamp);
  for (const name of ["advisor.js", "advisor.json.user-2026-09-25", "2026-09-01-notes", "2026-01-01T00-00-00.000Z"]) assert.ok(left.includes(name), name);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.deepEqual(pruneBackups(root), []);
});
