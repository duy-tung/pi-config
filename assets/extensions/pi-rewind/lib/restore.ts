import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bufferDiffCounts } from "./diff.ts";
import { type BlobStore, type Capturer, type FileVersion, realParent, sameVersion } from "./store.ts";

export interface PlanItem {
  file: string;
  target: FileVersion;
  current: FileVersion;
}

export interface DiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  skipped: { file: string; reason: string }[];
  /** partial: lỗi khi đang ghi tại chỗ, nội dung file có thể dở dang (Redo đưa về bản trước khi khôi phục). */
  failed: { file: string; reason: string; partial?: boolean }[];
}

/** Các file có nội dung hiện tại khác nội dung đích. */
export function planRestore(targets: Map<string, FileVersion>, capturer: Capturer): PlanItem[] {
  const items: PlanItem[] = [];
  for (const [file, target] of targets) {
    const current = capturer.capture(file);
    if (target.kind === "unprotected") {
      items.push({ file, target, current });
      continue;
    }
    if (current.kind === "unprotected" || !sameVersion(target, current)) items.push({ file, target, current });
  }
  items.sort((a, b) => a.file.localeCompare(b.file));
  return items;
}

function readVersion(store: BlobStore, version: FileVersion): Buffer | undefined {
  return version.kind === "file" ? store.read(version.sha) : undefined;
}

/** Thống kê "The code will be restored +X -Y in …" như Claude Code (hiện tại → đích). */
export function planStats(plan: PlanItem[], store: BlobStore): DiffStats {
  const stats: DiffStats = { filesChanged: [], insertions: 0, deletions: 0 };
  for (const item of plan) {
    if (item.target.kind === "unprotected" || item.current.kind === "unprotected") continue;
    stats.filesChanged.push(item.file);
    try {
      const counts = bufferDiffCounts(readVersion(store, item.current), readVersion(store, item.target));
      stats.insertions += counts.insertions;
      stats.deletions += counts.deletions;
    } catch {
      /* blob thiếu: vẫn liệt kê file, apply sẽ báo lỗi cụ thể */
    }
  }
  return stats;
}

export type MutationQueue = <T>(file: string, fn: () => Promise<T>) => Promise<T>;

const directQueue: MutationQueue = (_file, fn) => fn();

/** Lỗi xảy ra khi đã bắt đầu ghi đè file tại chỗ: nội dung có thể dở dang. */
class PartialWriteError extends Error {}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
// Không tạo được file tạm hoặc không đổi tên đè được (thư mục không ghi được, Windows đang khóa file):
// ghi tại chỗ như trước. Đĩa đầy thì không: ghi tại chỗ có thể để lại file dở.
const IN_PLACE_FALLBACK = new Set(["EACCES", "EPERM", "EBUSY"]);

/** Ghi file tạm cùng thư mục rồi đổi tên đè: lỗi giữa chừng để nguyên file cũ. */
async function replaceAtomically(file: string, data: Buffer, permissions: number): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.pi-rewind-${randomUUID().slice(0, 8)}.tmp`);
  // Tạo với quyền ghi (file chỉ đọc vẫn ghi được qua fd trên mọi hệ điều hành), đặt quyền đích sau khi ghi.
  let fd: number | undefined = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, permissions);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Windows: trình quét virus hoặc indexer giữ file trong chốc lát làm rename báo EPERM/EBUSY.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, file);
        return;
      } catch (error) {
        if (process.platform !== "win32" || attempt >= 3 || !IN_PLACE_FALLBACK.has(errorCode(error) ?? "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* đã đóng */
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* chưa tạo hoặc đã đổi tên */
    }
    throw error;
  }
}

/** Ghi tại chỗ, giữ inode (hard link vẫn chung nội dung). Lỗi sau khi mở file là ghi dở. */
function writeInPlace(file: string, data: Buffer, permissions: number): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.writeFileSync(fd, data);
    fs.ftruncateSync(fd, data.length);
    fs.fsyncSync(fd);
  } catch (error) {
    throw new PartialWriteError(error instanceof Error ? error.message : String(error));
  } finally {
    fs.closeSync(fd);
  }
  try {
    if ((fs.statSync(file).mode & 0o777) !== permissions) fs.chmodSync(file, permissions);
  } catch {
    /* nội dung đã về đúng; quyền là phần phụ (vd file của người dùng khác) */
  }
}

async function writeTarget(file: string, data: Buffer, mode: number, stat: fs.Stats | undefined): Promise<void> {
  const permissions = mode & 0o777;
  if (stat && stat.nlink > 1) return writeInPlace(file, data, permissions);
  try {
    await replaceAtomically(file, data, permissions);
  } catch (error) {
    if (!stat || !IN_PLACE_FALLBACK.has(errorCode(error) ?? "")) throw error;
    writeInPlace(file, data, permissions);
  }
}

/**
 * Ghi nội dung đích cho từng file. Kiểm lại trạng thái trên đĩa ngay trước khi ghi:
 * symlink, đổi kiểu file/thư mục, hoặc thư mục cha là symlink đều bị bỏ qua
 * và báo lại, không đoán. File được ghi qua file tạm rồi đổi tên (lỗi giữa chừng để nguyên
 * file cũ); file có hard link được ghi tại chỗ để các link vẫn chung nội dung.
 */
export async function applyRestore(
  plan: PlanItem[], store: BlobStore, capturer: Capturer,
  options: { queue?: MutationQueue } = {},
): Promise<RestoreResult> {
  const queue = options.queue ?? directQueue;
  const result: RestoreResult = { restored: [], deleted: [], skipped: [], failed: [] };
  for (const item of plan) {
    const { file, target } = item;
    if (target.kind === "unprotected") {
      result.skipped.push({ file, reason: `không có bản lưu (${target.reason})` });
      continue;
    }
    // Không ghi đè hoặc xóa nội dung không sao lưu được: /redo sẽ không lấy lại được.
    if (item.current.kind === "unprotected") {
      result.skipped.push({ file, reason: `nội dung hiện tại không sao lưu được (${item.current.reason})` });
      continue;
    }
    await queue(file, async () => {
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          result.failed.push({ file, reason: code ?? "không đọc được" });
          return;
        }
      }
      if (stat?.isSymbolicLink()) {
        result.skipped.push({ file, reason: "đường dẫn là symlink" });
        return;
      }
      if (stat && !stat.isFile()) {
        result.skipped.push({ file, reason: "đường dẫn không còn là file thường" });
        return;
      }
      // Thư mục cha bị thay bằng symlink hoặc chuyển chỗ: ghi sẽ đi ra ngoài vị trí cũ.
      if (target.dir && realParent(file) !== target.dir) {
        result.skipped.push({ file, reason: "thư mục chứa file đã đổi kể từ checkpoint" });
        return;
      }
      try {
        if (target.kind === "absent") {
          if (stat) {
            fs.unlinkSync(file);
            result.deleted.push(file);
          }
        } else {
          const data = store.read(target.sha);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          await writeTarget(file, data, target.mode, stat);
          result.restored.push(file);
        }
      } catch (error) {
        result.failed.push({
          file, reason: error instanceof Error ? error.message : String(error), ...(error instanceof PartialWriteError ? { partial: true } : {}),
        });
      } finally {
        capturer.forget(file);
      }
    });
  }
  return result;
}

/** Thông báo theo cách Claude Code báo khi khôi phục code. */
export function describeRestore(result: RestoreResult): { error?: string; warning?: string } {
  // File ghi dở cũng tính là đã đổi: lần khôi phục phải được ghi lại để Redo đưa nó về.
  const changed = result.restored.length + result.deleted.length + result.failed.filter((item) => item.partial).length;
  const skipped = result.skipped.length;
  if (result.failed.length && changed === 0) {
    const tail = skipped ? `, and ${skipped} ${skipped === 1 ? "path was" : "paths were"} skipped for link safety` : "";
    return {
      error: `No files were restored: ${result.failed.length} ${result.failed.length === 1 ? "file" : "files"} failed (backup missing, or the file could not be updated)${tail}`,
    };
  }
  const parts: string[] = [];
  if (skipped) {
    parts.push(`Restored the code, but skipped ${skipped} ${skipped === 1 ? "file" : "files"}: ${result.skipped.map((item) => `${path.basename(item.file)} (${item.reason})`).join(", ")}. Skipped files were left untouched.`);
  }
  if (result.failed.length) {
    parts.push(`Failed to restore ${result.failed.length} ${result.failed.length === 1 ? "file" : "files"}: ${result.failed.map((item) => `${path.basename(item.file)} (${item.partial ? "partly written: " : ""}${item.reason})`).join(", ")}.`);
  }
  return parts.length ? { warning: parts.join("\n") } : {};
}
