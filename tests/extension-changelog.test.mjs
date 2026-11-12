import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Ở mỗi phiên mới, Pi hiện "Extension Updates" cho mọi mục changelog của package có số phiên bản lớn hơn phiên bản đã
// xem, rồi ghi lại phiên bản đang cài. Một mục đánh số cao hơn phiên bản đang cài (pi-advisor-flow giữ tiêu đề của bản
// 5.1.0 phát hành nhầm đã rút lại) vì thế "mới" mãi mãi và hiện lại ở mọi lần mở Pi. Kiểm bằng chính hàm của Pi trên
// runtime đã cài và đã vá.
const root = process.env.PI_CONFIG_TEST_ROOT;
test("không package nào có mục changelog mới hơn phiên bản đang cài (Pi sẽ hiện lại nó ở mỗi phiên mới)", { skip: !root }, async () => {
  const modules = path.join(root, "runtimes", "current", "node_modules");
  const { getNewEntries, parseChangelog } = await import(pathToFileURL(path.join(modules, "@earendil-works", "pi-coding-agent", "dist", "utils", "changelog.js")).href);
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../manifests/current/package.json", import.meta.url)), "utf8"));
  const ahead = [];
  let checked = 0;
  for (const name of Object.keys(manifest.dependencies)) {
    const dir = path.join(modules, ...name.split("/"));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    // Như Pi: CHANGELOG.md ở gốc package, hoặc pi.changelogPath ("" là tắt).
    const relative = pkg.pi?.changelogPath ?? "CHANGELOG.md";
    if (!relative || !fs.existsSync(path.join(dir, relative))) continue;
    checked += 1;
    const entries = getNewEntries(parseChangelog(path.join(dir, relative)), pkg.version) ?? [];
    for (const entry of entries) ahead.push(`${name}@${pkg.version}: mục ${entry.major}.${entry.minor}.${entry.patch}`);
  }
  assert.ok(checked >= 5, `đã kiểm ${checked} changelog`);
  assert.deepEqual(ahead, []);
});
