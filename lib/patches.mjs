import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "../runtime/merge.mjs";

const patchDataUrl = new URL("../assets/patches.json", import.meta.url);
const insertRoot = fileURLToPath(new URL("../assets/patches/", import.meta.url));
const normalizeLines = (value) => value.replace(/\r\n/g, "\n");
export const sourceHash = (value) => createHash("sha256").update(normalizeLines(value)).digest("hex");

/**
 * Đọc assets/patches.json. Edit có insertFile (đường dẫn trong assets/patches/) nhận nội dung file đó làm
 * phần chèn ngay trước after (hoặc trước chuỗi neo nếu không có after); checksum kết quả vẫn ghim như cũ.
 */
export async function loadPatchData(url = patchDataUrl) {
  const data = JSON.parse(await readFile(url, "utf8"));
  for (const spec of data.patches ?? []) {
    for (const edit of spec.edits ?? []) {
      if (edit.insertFile === undefined) continue;
      const file = path.resolve(insertRoot, String(edit.insertFile));
      const relative = path.relative(insertRoot, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`insertFile phải nằm trong assets/patches: ${spec.package}/${spec.file}`);
      }
      edit.insert = normalizeLines(await readFile(file, "utf8"));
    }
  }
  return data;
}

/** Áp các edit của spec lên source đã chuẩn hoá xuống dòng; không kiểm checksum (dùng cho scripts/rehash-patches.mjs). */
export function applyEdits(original, spec) {
  let modified = original;
  spec.edits.forEach((edit, index) => {
    const after = edit.insert === undefined ? edit.after : edit.insert + (edit.after ?? edit.before);
    if (!edit.before || typeof after !== "string" || !Number.isSafeInteger(edit.count) || edit.count < 1) {
      throw new Error(`Dữ liệu bản vá không hợp lệ: ${spec.package}/${spec.file}`);
    }
    const matches = modified.split(edit.before).length - 1;
    if (matches !== edit.count) {
      throw new Error(`Không khớp source bản vá: ${spec.package}/${spec.file} (edit ${index + 1}); cần ${edit.count}, thấy ${matches}.`);
    }
    modified = modified.split(edit.before).join(after);
  });
  return modified;
}

/** Kiểm tra toàn bộ source trước khi sửa; cùng input luôn cho cùng output. */
export function patchSource(source, spec) {
  const original = normalizeLines(source);
  const currentHash = sourceHash(original);
  if (currentHash === spec.patchedSha256) return { text: original, changed: false };
  if (currentHash !== spec.originalSha256) {
    throw new Error(`Source đã thay đổi ngoài bản vá: ${spec.package}/${spec.file}; không ghi đè.`);
  }
  const modified = applyEdits(original, spec);
  if (sourceHash(modified) !== spec.patchedSha256) {
    throw new Error(`Checksum kết quả bản vá không khớp: ${spec.package}/${spec.file}`);
  }
  return { text: modified, changed: true };
}

/**
 * root là thư mục cài, chứa runtimes/current.
 */
export async function applyPatches({ root }) {
  if (!root) throw new Error("Thiếu root khi áp dụng bản vá.");
  const runtime = "current";
  const { schemaVersion, patches } = await loadPatchData();
  if (schemaVersion !== 1) throw new Error("Schema bản vá chưa được hỗ trợ.");
  const manifest = path.join(root, "patches", "manifest.json");
  const pending = [];
  // Lập kế hoạch và kiểm toàn bộ checksum trước khi sửa bất kỳ package nào.
  for (const spec of patches) {
    if (!Object.hasOwn(spec.versions, runtime)) continue;
    const packageRoot = path.join(root, "runtimes", runtime, "node_modules", spec.package);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.version !== spec.versions[runtime]) {
      throw new Error(`Sai phiên bản ${spec.package}: cần ${spec.versions[runtime]}, thấy ${metadata.version}.`);
    }
    const target = path.join(packageRoot, spec.file);
    const result = patchSource(await readFile(target, "utf8"), spec);
    pending.push({
      target,
      result,
      record: {
        runtime, package: spec.package, version: metadata.version, file: spec.file,
        originalSha256: spec.originalSha256, patchedSha256: spec.patchedSha256,
      },
    });
  }
  for (const entry of pending) {
    if (entry.result.changed) {
      const mode = (await stat(entry.target)).mode & 0o777;
      writeAtomic(entry.target, entry.result.text, mode);
    }
  }
  const records = pending.map((entry) => entry.record)
    .sort((a, b) => `${a.package}/${a.file}`.localeCompare(`${b.package}/${b.file}`));
  writeAtomic(manifest, `${JSON.stringify(records, null, 2)}\n`, 0o644);
  return records;
}
