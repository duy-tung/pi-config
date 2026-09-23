import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Nội dung một đường dẫn tại một thời điểm.
 * - file: nội dung nằm trong kho blob theo SHA-256.
 * - absent: đường dẫn chưa tồn tại; khôi phục về trạng thái này là xóa file.
 * - unprotected: không lưu được (quá lớn, không phải file thường...); không bao giờ khôi phục.
 */
export type FileVersion =
  | { kind: "file"; sha: string; size: number; mode: number; dir?: string }
  | { kind: "absent"; dir?: string }
  | { kind: "unprotected"; reason: string };

export const ABSENT: FileVersion = Object.freeze({ kind: "absent" });

/**
 * Thư mục cha thật của đường dẫn (realpath tổ tiên gần nhất còn tồn tại + phần còn lại).
 * Ghi lại khi chụp để lúc khôi phục phát hiện thư mục cha đã bị thay bằng symlink
 * hoặc di chuyển — tương tự realParentDir của Claude Code.
 */
export function realParent(file: string): string {
  let dir = path.dirname(path.resolve(file));
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.join(dir, ...rest.reverse());
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

export function sameVersion(a: FileVersion | undefined, b: FileVersion | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.sha === b.sha && (a.mode & 0o111) === (b.mode & 0o111);
  return a.kind === "absent";
}

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/**
 * Kho nội dung theo địa chỉ SHA-256, dùng chung giữa các phiên.
 * Ghi bằng file tạm + rename nên hai phiên Pi cùng ghi một blob vẫn an toàn.
 * mtime của blob là lần tham chiếu gần nhất; gc xóa blob quá hạn lưu giữ.
 */
export class BlobStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private blobPath(sha: string): string {
    if (!/^[a-f0-9]{64}$/u.test(sha)) throw new Error(`SHA không hợp lệ: ${sha}`);
    return path.join(this.dir, "blobs", sha.slice(0, 2), sha.slice(2));
  }

  has(sha: string): boolean {
    return fs.existsSync(this.blobPath(sha));
  }

  put(data: Buffer): string {
    const sha = sha256(data);
    const target = this.blobPath(sha);
    if (fs.existsSync(target)) {
      this.touch(sha);
      return sha;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    fs.renameSync(temporary, target);
    return sha;
  }

  read(sha: string): Buffer {
    const data = fs.readFileSync(this.blobPath(sha));
    if (sha256(data) !== sha) throw new Error(`Blob hỏng: ${sha.slice(0, 12)}`);
    return data;
  }

  touch(sha: string): void {
    const now = new Date();
    try {
      fs.utimesSync(this.blobPath(sha), now, now);
    } catch {
      /* blob đã bị gc; lần ghi sau sẽ tạo lại */
    }
  }

  /** Xóa blob không được tham chiếu trong maxAgeMs. Trả về số blob đã xóa. */
  gc(maxAgeMs: number, now = Date.now()): number {
    const root = path.join(this.dir, "blobs");
    let removed = 0;
    let shards: string[];
    try {
      shards = fs.readdirSync(root);
    } catch {
      return 0;
    }
    for (const shard of shards) {
      const dir = path.join(root, shard);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          // File tạm bị bỏ dở cũng dọn theo cùng hạn.
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(file);
            removed++;
          }
        } catch {
          /* phiên khác vừa xóa */
        }
      }
    }
    return removed;
  }
}

export interface CaptureOptions {
  maxBytes: number;
}

interface StatKey {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

/**
 * Chụp nội dung hiện tại của một đường dẫn tuyệt đối vào kho.
 * Đi theo symlink như tool write/edit của Pi (fs.writeFile ghi xuyên link).
 * Bộ nhớ đệm stat tránh đọc lại file không đổi khi chụp checkpoint.
 */
export class Capturer {
  readonly store: BlobStore;
  readonly options: CaptureOptions;
  private readonly cache = new Map<string, { key: StatKey; version: FileVersion }>();

  constructor(store: BlobStore, options: CaptureOptions) {
    this.store = store;
    this.options = options;
  }

  capture(file: string): FileVersion {
    if (isSensitive(file)) return { kind: "unprotected", reason: "file chứa bí mật không được sao lưu" };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.cache.delete(file);
        return { kind: "absent", dir: realParent(file) };
      }
      return { kind: "unprotected", reason: `không đọc được (${code ?? "lỗi"})` };
    }
    if (!stat.isFile()) return { kind: "unprotected", reason: "không phải file thường" };
    if (stat.size > this.options.maxBytes) {
      return { kind: "unprotected", reason: `lớn hơn ${Math.round(this.options.maxBytes / 1048576)} MiB` };
    }
    const key: StatKey = {
      dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode,
    };
    const cached = this.cache.get(file);
    // File vừa sửa trong cùng khoảng phân giải mtime có thể có stat giống hệt
    // bản trước ("racy git"); chỉ tin cache khi file đã yên hơn 2 giây.
    const settled = Date.now() - stat.mtimeMs > 2000;
    if (settled && cached && sameStat(cached.key, key) && cached.version.kind === "file" && this.store.has(cached.version.sha)) {
      this.store.touch(cached.version.sha);
      return cached.version;
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch (error) {
      return { kind: "unprotected", reason: `không đọc được (${(error as NodeJS.ErrnoException).code ?? "lỗi"})` };
    }
    const version: FileVersion = {
      kind: "file", sha: this.store.put(data), size: data.length, mode: stat.mode & 0o7777, dir: realParent(file),
    };
    this.cache.set(file, { key, version });
    return version;
  }

  /** Lưu nội dung đã có trong bộ nhớ (ví dụ blob lấy từ git) mà không đọc đĩa. */
  captureBuffer(data: Buffer, mode: number, file: string): FileVersion {
    if (data.length > this.options.maxBytes) {
      return { kind: "unprotected", reason: `lớn hơn ${Math.round(this.options.maxBytes / 1048576)} MiB` };
    }
    return { kind: "file", sha: this.store.put(data), size: data.length, mode, dir: realParent(file) };
  }

  forget(file: string): void {
    this.cache.delete(file);
  }
}

const SENSITIVE = [
  /^\.env(?:\..+)?$/u, /\.(?:pem|key|p12|pfx|keystore|jks)$/iu, /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u,
  /^(?:auth|credentials|\.credentials)\.json$/u, /^\.(?:netrc|npmrc|pypirc)$/u,
];

/** Không chép file chứa bí mật vào kho (kể cả qua symlink); .env.example vẫn được theo dõi. */
export function isSensitive(file: string): boolean {
  const names = [path.basename(file)];
  try {
    names.push(path.basename(fs.realpathSync.native(file)));
  } catch {
    /* chưa tồn tại */
  }
  return names.some((name) => /^\.env\.(?:example|sample|template)$/u.test(name) ? false : SENSITIVE.some((pattern) => pattern.test(name)));
}

function sameStat(a: StatKey, b: StatKey): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
}
