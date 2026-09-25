import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPatchData, sourceHash } from "../lib/patches.mjs";

// Bản vá file .ts không được thêm lỗi kiểu mà upstream không có. Với mỗi package có file .ts được vá, biên dịch
// source (cùng thư mục gốc với file vá) hai lần bằng TypeScript của runtime, trên type của Pi đã cài: bản đã vá
// của runtime và bản gốc dựng lại bằng cách đảo các edit. Lỗi sẵn có của upstream được bỏ qua; chỉ lỗi bản vá
// thêm vào (so theo nội dung, không theo số dòng, tính cả số lần lặp) làm test thất bại. Chạy trong smoke.
const root = process.env.PI_CONFIG_TEST_ROOT;
const modules = root ? path.join(root, "runtimes", "current", "node_modules") : "";
const { patches } = await loadPatchData();
const normalize = (text) => text.replace(/\r\n/g, "\n");

// Mỗi nhóm: một package và thư mục gốc chứa file vá (src/, extensions/, dist/).
const groups = [];
for (const spec of patches) {
  if (!spec.file.endsWith(".ts") || !Object.hasOwn(spec.versions, "current")) continue;
  const top = spec.file.split("/")[0];
  let group = groups.find((entry) => entry.package === spec.package && entry.top === top);
  if (!group) groups.push(group = { package: spec.package, top, specs: [] });
  group.specs.push(spec);
}

// Chỉ số định danh để xếp vị trí chèn lại đoạn bị xoá: vị trí gần các dòng chứa định danh hiếm của đoạn đó trước.
const keywords = new Set("const let var if else return function true false null undefined new this typeof await async for while of in void break continue throw try catch finally export import from as type interface".split(" "));
function insertionPoints(text, removed) {
  const lines = text.split("\n"), points = [];
  let offset = 0;
  for (let line = 0; line <= lines.length; line++) {
    // Đoạn kết thúc bằng xuống dòng được chèn ở đầu dòng; bắt đầu bằng xuống dòng thì ở cuối dòng; còn lại ở mọi vị trí.
    if (removed.endsWith("\n")) { if (line < lines.length) points.push({ at: offset, line: line - 0.5 }); }
    else if (removed.startsWith("\n")) { if (line < lines.length) points.push({ at: offset + lines[line].length, line: line + 0.5 }); }
    else if (line < lines.length) for (let i = 0; i <= lines[line].length; i++) points.push({ at: offset + i, line });
    if (line < lines.length) offset += lines[line].length + 1;
  }
  const code = removed.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, "");
  const weights = [];
  for (const token of new Set(code.match(/[A-Za-z_$][\w$]{2,}/gu) ?? [])) {
    if (keywords.has(token)) continue;
    const pattern = new RegExp(`(?<![\\w$])${token.replaceAll("$", "\\$")}(?![\\w$])`, "u");
    const at = lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
    if (at.length) weights.push({ at, weight: Math.log((lines.length + 1) / at.length) });
  }
  const scores = new Map();
  const score = (line) => {
    if (!scores.has(line)) scores.set(line, weights.reduce((sum, { at, weight }) => sum + weight / (1 + Math.min(...at.map((index) => Math.abs(index - line)))), 0));
    return scores.get(line);
  };
  return points.map((point) => ({ ...point, score: score(point.line) })).sort((a, b) => b.score - a.score || a.at - b.at).map((point) => point.at);
}

/**
 * Đảo các edit của spec theo thứ tự ngược, cùng ngữ nghĩa với patchSource của lib/patches.mjs: after (kể cả phần
 * insert) phải xuất hiện đúng count lần rồi được thay lại bằng before. Edit xoá (after rỗng) không để lại vị trí:
 * thử chèn lại ở các vị trí khả dĩ theo thứ tự ưu tiên, giới hạn số lần thử. Kết quả phải khớp originalSha256.
 */
export function reconstructOriginal(patched, spec) {
  const text = normalize(patched);
  if (sourceHash(text) !== spec.patchedSha256) throw new Error(`${spec.package}/${spec.file} của runtime không khớp patchedSha256`);
  const edits = spec.edits.map((edit) => ({
    before: edit.before, count: edit.count, after: edit.insert === undefined ? edit.after : edit.insert + (edit.after ?? edit.before),
  }));
  if (edits.some((edit) => edit.after === "" && edit.count !== 1)) throw new Error(`${spec.package}/${spec.file}: edit xoá có count khác 1`);
  let budget = 200_000;
  const undo = (current, index, limit) => {
    if (index < 0) { budget--; return sourceHash(current) === spec.originalSha256 ? current : undefined; }
    const { before, after, count } = edits[index];
    if (after !== "") {
      const parts = current.split(after);
      return parts.length - 1 === count ? undo(parts.join(before), index - 1, limit) : undefined;
    }
    for (const at of insertionPoints(current, before).slice(0, limit)) {
      if (budget <= 0) return undefined;
      const found = undo(current.slice(0, at) + before + current.slice(at), index - 1, limit);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (let limit = 4; budget > 0; limit *= 2) {
    const found = undo(text, edits.length - 1, limit);
    if (found !== undefined) return found;
    if (!edits.some((edit) => edit.after === "") || limit > text.length) break;
  }
  throw new Error(`${spec.package}/${spec.file}: không dựng lại được bản gốc từ các edit (originalSha256). Edit xoá khó định vị thì viết kèm một dòng ngữ cảnh trong before/after.`);
}

// Giới hạn số tsc chạy cùng lúc.
const slots = Math.max(1, Math.min(4, os.availableParallelism()));
let running = 0;
const waiting = [];
async function limited(task) {
  if (running < slots) running++;
  else await new Promise((resolve) => waiting.push(resolve)); // nhận chỗ trực tiếp từ tác vụ vừa xong
  try { return await task(); } finally { const next = waiting.shift(); if (next) next(); else running--; }
}

function compile(directory, files, bundler) {
  const earendil = path.join(modules, "@earendil-works");
  const paths = {};
  for (const name of fs.readdirSync(earendil)) {
    const dist = path.join(earendil, name, "dist");
    if (!fs.existsSync(path.join(dist, "index.d.ts"))) continue;
    paths[`@earendil-works/${name}`] = [path.join(dist, "index.d.ts")];
    paths[`@earendil-works/${name}/*`] = [path.join(dist, "*.d.ts")];
  }
  const config = path.join(directory, "tsconfig.typecheck.json");
  fs.writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: "ES2024", module: bundler ? "ESNext" : "NodeNext", moduleResolution: bundler ? "Bundler" : "NodeNext",
      strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
      types: ["node"], typeRoots: [path.join(modules, "@types")], paths,
    },
    files,
  }, null, 2));
  const tsc = path.join(modules, "typescript", "bin", "tsc");
  return limited(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, "-p", config, "--pretty", "false"], { cwd: directory, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  })).then(({ code, signal, output }) => {
    assert.equal(signal, null, `tsc bị dừng (${signal})`);
    // Mỗi lỗi: dòng "file(dòng,cột): error TSxxxx: ..." và các dòng thụt lề tiếp theo. Bỏ số dòng/cột và đường dẫn
    // tuyệt đối của bản đang biên dịch để hai bản so được với nhau.
    const variants = [directory, directory.replaceAll("\\", "/")];
    const diagnostics = [];
    for (const line of normalize(output).split("\n")) {
      if (/^\s/u.test(line) && diagnostics.length) diagnostics[diagnostics.length - 1] += ` ${line.trim()}`;
      else if (/(?:^|: )error TS\d+:/u.test(line)) diagnostics.push(line.replace(/\(\d+,\d+\): error /u, ": error "));
    }
    const counts = new Map();
    for (let diagnostic of diagnostics) {
      for (const variant of variants) diagnostic = diagnostic.replaceAll(variant, "<package>");
      counts.set(diagnostic, (counts.get(diagnostic) ?? 0) + 1);
    }
    assert.ok(code === 0 || diagnostics.length > 0, `tsc thất bại mà không có lỗi: ${output}`);
    return counts;
  });
}

function listSources(directory, top) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(file); }
      else if (/\.[cm]?ts$/u.test(entry.name) && !/\.d\.[cm]?ts$|\.test\.[cm]?ts$/u.test(entry.name)) files.push(file);
    }
  };
  walk(path.join(directory, top));
  return files.sort();
}

// Liên kết node_modules: junction trên Windows (không cần quyền admin). Gỡ liên kết trước khi xoá workspace để không
// bao giờ đụng vào node_modules của runtime.
function link(target, file, links) {
  fs.symlinkSync(target, file, "junction");
  links.push(file);
}
function unlink(file) {
  try { if (process.platform === "win32") fs.rmdirSync(file); else fs.unlinkSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Import của Pi và import tương đối phải resolve được trong bản sao, nếu không phép so sánh không còn ý nghĩa.
const unresolved = /error TS(?:2307|2792): Cannot find module '(?:@earendil-works\/|\.{1,2}\/)/u;
async function checkGroup(group, workspace, index, links) {
  const packageDir = path.join(modules, group.package);
  const originals = new Map(group.specs.map((spec) => [spec.file, reconstructOriginal(fs.readFileSync(path.join(packageDir, spec.file), "utf8"), spec)]));
  const directories = {};
  for (const variant of ["patched", "original"]) {
    const directory = directories[variant] = path.join(workspace, String(index), variant);
    fs.cpSync(packageDir, directory, { recursive: true, filter: (source) => !path.relative(packageDir, source).split(path.sep).includes("node_modules") });
    // Dependency riêng của package (nếu có) nằm cạnh bản sao; dependency chung qua node_modules của workspace.
    if (fs.existsSync(path.join(packageDir, "node_modules"))) link(path.join(packageDir, "node_modules"), path.join(directory, "node_modules"), links);
    if (variant === "original") for (const [file, text] of originals) fs.writeFileSync(path.join(directory, file), text);
  }
  const files = listSources(directories.patched, group.top).map((file) => path.relative(directories.patched, file));
  for (const spec of group.specs) assert.ok(files.includes(path.join(...spec.file.split("/"))), `${spec.file} không nằm trong chương trình biên dịch`);
  const run = (bundler) => Promise.all(["patched", "original"].map((variant) => compile(directories[variant], files, bundler)));
  let [patched, original] = await run(false);
  // Package viết cho bundler (import tương đối không có đuôi; Pi nạp extension qua jiti): NodeNext không resolve được
  // các import đó nên type thành any và che lỗi. Biên dịch lại cả hai bản với moduleResolution Bundler.
  if ([...original.keys()].some((diagnostic) => /error TS283[45]:/u.test(diagnostic))) [patched, original] = await run(true);
  assert.deepEqual([...original.keys()].filter((diagnostic) => unresolved.test(diagnostic)), [], `${group.package}: bản gốc không resolve được module`);
  const introduced = [...patched].filter(([diagnostic, count]) => count > (original.get(diagnostic) ?? 0))
    .map(([diagnostic, count]) => `${count - (original.get(diagnostic) ?? 0)}× ${diagnostic}`);
  assert.deepEqual(introduced, [], `${group.package}: bản vá thêm lỗi TypeScript mà upstream không có`);
}

test("mỗi file .ts được vá dựng lại được bản gốc theo originalSha256", { skip: !root }, () => {
  assert.equal(groups.flatMap((group) => group.specs).length, 8);
  for (const group of groups) for (const spec of group.specs) {
    const original = reconstructOriginal(fs.readFileSync(path.join(modules, group.package, spec.file), "utf8"), spec);
    assert.equal(sourceHash(original), spec.originalSha256);
  }
});

test("bản vá TypeScript không thêm lỗi kiểu so với bản gốc", { skip: !root, timeout: 600_000, concurrency: true }, async (t) => {
  assert.ok(fs.existsSync(path.join(modules, "typescript", "bin", "tsc")), "runtime thiếu TypeScript");
  // realpath: macOS đổi /var thành /private/var trong đường dẫn lỗi.
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-patch-typecheck-"))), links = [];
  t.after(() => { for (const file of links) unlink(file); fs.rmSync(workspace, { recursive: true, force: true }); });
  link(modules, path.join(workspace, "node_modules"), links);
  assert.ok(fs.existsSync(path.join(workspace, "node_modules", "typescript", "package.json")), "workspace không thấy node_modules của runtime");
  await Promise.all(groups.map((group, index) => t.test(`${group.package} (${group.top}/)`, () => checkGroup(group, workspace, index, links))));
});
