#!/usr/bin/env node
// Tính lại checksum bản vá sau khi đổi phiên bản package (xem docs/upgrade.md).
// Cài manifests/current vào thư mục tạm (npm ci --ignore-scripts, không sửa repo), áp từng bản vá lên source mới,
// báo neo không còn khớp. --write ghi phiên bản và checksum mới vào assets/patches.json khi mọi bản vá áp được.
// --modules <dir> dùng node_modules có sẵn thay vì cài.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, loadPatchData, sourceHash } from "../lib/patches.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const write = args.includes("--write");
const modulesIndex = args.indexOf("--modules");
const unknown = args.filter((arg, index) => !["--write", "--modules"].includes(arg) && index !== modulesIndex + 1);
if (unknown.length || (modulesIndex >= 0 && !args[modulesIndex + 1])) {
  console.error("Cách dùng: node scripts/rehash-patches.mjs [--modules <node_modules>] [--write]");
  process.exit(2);
}

function install() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-rehash-"));
  const runtime = path.join(temporary, "manifests", "current");
  fs.mkdirSync(runtime, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(repo, "manifests", "current", file), path.join(runtime, file));
  // file:../../vendor/*.tgz trong manifest tính từ manifests/current.
  fs.cpSync(path.join(repo, "vendor"), path.join(temporary, "vendor"), { recursive: true });
  console.log(`npm ci vào ${runtime} ...`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtime, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm ci thất bại (${result.status ?? result.signal}); runtime tạm ở ${temporary}`);
  return { modules: path.join(runtime, "node_modules"), temporary };
}

const { modules, temporary } = modulesIndex >= 0 ? { modules: path.resolve(args[modulesIndex + 1]) } : install();
const data = await loadPatchData();
const raw = JSON.parse(fs.readFileSync(path.join(repo, "assets", "patches.json"), "utf8"));
let failed = 0;
let changed = 0;
data.patches.forEach((spec, index) => {
  const label = `${spec.package}/${spec.file}`;
  const packageRoot = path.join(modules, spec.package);
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  } catch {
    console.log(`FAIL ${label}: không có package trong ${modules}`);
    failed++;
    return;
  }
  const source = fs.readFileSync(path.join(packageRoot, spec.file), "utf8").replace(/\r\n/g, "\n");
  const original = sourceHash(source);
  if (original === spec.patchedSha256) {
    console.log(`FAIL ${label}: source đã được vá; dùng node_modules chưa vá`);
    failed++;
    return;
  }
  let patched;
  try {
    patched = sourceHash(applyEdits(source, spec));
  } catch (error) {
    console.log(`FAIL ${label}@${version}: ${error.message}`);
    failed++;
    return;
  }
  const entry = raw.patches[index];
  const same = version === spec.versions.current && original === spec.originalSha256 && patched === spec.patchedSha256;
  if (same) {
    console.log(`OK   ${label}@${version}`);
    return;
  }
  changed++;
  console.log(`NEW  ${label}: ${spec.versions.current} → ${version}; originalSha256 ${original}; patchedSha256 ${patched}`);
  entry.versions.current = version;
  entry.originalSha256 = original;
  entry.patchedSha256 = patched;
});
if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} bản vá không áp được: sửa before/after trong assets/patches.json theo source mới rồi chạy lại.`);
  process.exit(1);
}
if (changed && write) {
  fs.writeFileSync(path.join(repo, "assets", "patches.json"), `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`Đã ghi ${changed} bản vá vào assets/patches.json.`);
} else if (changed) {
  console.log(`${changed} bản vá có checksum mới; chạy lại với --write để ghi.`);
  process.exit(1);
} else {
  console.log("Mọi bản vá khớp manifest hiện tại.");
}
