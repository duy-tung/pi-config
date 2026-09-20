import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const patchDataUrl = new URL("../assets/patches.json", import.meta.url);
const normalizeLines = (value) => value.replace(/\r\n/g, "\n");
export const sourceHash = (value) => createHash("sha256").update(normalizeLines(value)).digest("hex");

/** Kiểm tra toàn bộ source trước khi sửa; cùng input luôn cho cùng output. */
export function patchSource(source, spec) {
  const original = normalizeLines(source);
  const currentHash = sourceHash(original);
  if (currentHash === spec.patchedSha256) return { text: original, changed: false };
  if (currentHash !== spec.originalSha256) {
    throw new Error(`Source đã thay đổi ngoài bản vá: ${spec.package}/${spec.file}; không ghi đè.`);
  }
  let modified = original;
  for (const edit of spec.edits) {
    if (!edit.before || !Number.isSafeInteger(edit.count) || edit.count < 1) {
      throw new Error(`Dữ liệu bản vá không hợp lệ: ${spec.package}/${spec.file}`);
    }
    const matches = modified.split(edit.before).length - 1;
    if (matches !== edit.count) {
      throw new Error(`Không khớp source bản vá: ${spec.package}/${spec.file}; cần ${edit.count}, thấy ${matches}.`);
    }
    modified = modified.split(edit.before).join(edit.after);
  }
  if (sourceHash(modified) !== spec.patchedSha256) {
    throw new Error(`Checksum kết quả bản vá không khớp: ${spec.package}/${spec.file}`);
  }
  return { text: modified, changed: true };
}

async function atomicWrite(filename, content, mode = 0o644) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await rename(temporary, filename);
}

/**
 * root là thư mục cài, chứa runtimes/current và runtimes/compat.
 * Bản vá auth chỉ thay tham số MẶC ĐỊNH; authPath tường minh luôn được tôn trọng.
 * pi-usage dùng readStoredCredential mặc định; worker tintin kế thừa ModelRuntime parent.
 * Không cần symlink auth.json trên Windows.
 */
export async function applyPatches({ root, runtimes = ["current", "compat"] }) {
  if (!root) throw new Error("Thiếu root khi áp dụng bản vá.");
  if (!Array.isArray(runtimes) || !runtimes.length || new Set(runtimes).size !== runtimes.length ||
      runtimes.some((runtime) => !["current", "compat"].includes(runtime))) {
    throw new Error("Runtime phải là current hoặc compat, không được lặp.");
  }
  const { schemaVersion, patches } = JSON.parse(await readFile(patchDataUrl, "utf8"));
  if (schemaVersion !== 1) throw new Error("Schema bản vá chưa được hỗ trợ.");
  const manifest = path.join(root, "patches", "manifest.json");
  let previous = [];
  try {
    previous = JSON.parse(await readFile(manifest, "utf8"));
    if (!Array.isArray(previous)) throw new Error("Manifest bản vá phải là mảng.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pending = [];
  // Lập kế hoạch và kiểm toàn bộ checksum trước khi sửa bất kỳ package nào.
  for (const runtime of runtimes) {
    for (const spec of patches) {
      const packageRoot = path.join(root, "runtimes", runtime, "node_modules", spec.package);
      const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      if (metadata.version !== spec.versions[runtime]) {
        throw new Error(`Sai phiên bản ${runtime}/${spec.package}: cần ${spec.versions[runtime]}, thấy ${metadata.version}.`);
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
  }
  for (const entry of pending) {
    if (entry.result.changed) {
      const mode = (await stat(entry.target)).mode & 0o777;
      await atomicWrite(entry.target, entry.result.text, mode);
    }
  }
  const records = pending.map((entry) => entry.record);
  const combined = [...previous.filter((record) => !runtimes.includes(record.runtime)), ...records];
  combined.sort((a, b) => `${a.runtime}/${a.package}/${a.file}`.localeCompare(`${b.runtime}/${b.package}/${b.file}`));
  await atomicWrite(manifest, `${JSON.stringify(combined, null, 2)}\n`);
  return records;
}
