import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Extension của repo (assets/extensions) chạy bằng type stripping, không ai biên dịch: kiểm kiểu strict bằng
// TypeScript (manifests/typecheck, PI_CONFIG_TSC) trên type của Pi trong runtime đã cài. Chạy trong smoke (PI_CONFIG_TEST_ROOT).
const root = process.env.PI_CONFIG_TEST_ROOT;
const tsc = process.env.PI_CONFIG_TSC ?? "";
const modules = root ? path.join(root, "runtimes", "current", "node_modules") : "";
const extensions = fileURLToPath(new URL("../assets/extensions/", import.meta.url));

test("assets/extensions không có lỗi kiểu (tsc --strict trên type của Pi đã cài)", { skip: !root, timeout: 600_000 }, (t) => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-extensions-typecheck-")));
  const link = path.join(workspace, "node_modules");
  t.after(() => {
    try { if (process.platform === "win32") fs.rmdirSync(link); else fs.unlinkSync(link); } catch { /* chưa tạo */ }
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  fs.symlinkSync(modules, link, "junction");
  fs.cpSync(extensions, path.join(workspace, "extensions"), { recursive: true });
  // Pi nạp extension như ES module.
  fs.writeFileSync(path.join(workspace, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
      module: "nodenext", moduleResolution: "nodenext", target: "es2023", types: ["node"],
    },
    include: ["extensions/**/*.ts"],
  }));
  assert.ok(fs.existsSync(tsc), "PI_CONFIG_TSC phải trỏ tới tsc của manifests/typecheck");
  const result = spawnSync(process.execPath, [tsc, "-p", workspace, "--pretty", "false"], {
    cwd: workspace, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
