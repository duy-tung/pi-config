import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Process còn chạy (EPERM: còn, nhưng thuộc người dùng khác). */
export function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Holder {
  pid?: number;
  host?: string;
  token?: string;
  at: number;
}

/** Kết quả một lần thử: release khi đã lấy được khóa; removed khi đã gỡ một khóa bỏ lại. */
interface Attempt {
  release?: () => void;
  holder?: Holder;
  removed?: boolean;
}

export interface LockOptions {
  /** Chờ khóa tối đa (ms) trước khi báo bận. */
  waitMs?: number;
  /** Khóa cũ hơn mức này coi như bị bỏ lại (ms). */
  staleMs?: number;
}

/** Token khóa process này đang giữ. Pi nạp extension không cache module (mỗi phiên, /reload một bản): dùng chung qua globalThis. */
const scope = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const held = (scope[Symbol.for("pi-rewind:held-locks")] ??= new Set<string>());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Khóa giữa các process Pi dùng chung storageDir, giữ trong lúc ghi code (rewind, Redo, Undo redo,
 * phục hồi) và lúc dọn kho. File `lock` tạo bằng O_EXCL, chứa {pid, host, token, at}.
 * Khóa bỏ lại (process đã chết trên cùng máy, hoặc cũ hơn staleMs) được gỡ và thử lại một lần.
 * Chỉ gỡ khóa đúng token của mình.
 */
export class StorageLock {
  readonly file: string;
  private readonly waitMs: number;
  private readonly staleMs: number;

  constructor(storageDir: string, options: LockOptions = {}) {
    this.file = path.join(storageDir, "lock");
    this.waitMs = options.waitMs ?? 5000;
    this.staleMs = options.staleMs ?? 10 * 60 * 1000;
  }

  /** Một lần thử, không chờ. undefined: process khác đang giữ. */
  tryAcquire(): (() => void) | undefined {
    return this.attempt(true).release;
  }

  /** Chờ tối đa waitMs; vẫn bận thì báo lỗi và không làm gì. */
  async acquire(): Promise<() => void> {
    const deadline = Date.now() + this.waitMs;
    let removeStale = true;
    for (;;) {
      let result: Attempt;
      try {
        result = this.attempt(removeStale);
      } catch (error) {
        // Windows: file khóa vừa bị xóa nhưng process khác còn mở (delete pending) báo EPERM trong chốc lát.
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM" || Date.now() >= deadline) throw error;
        await sleep(100);
        continue;
      }
      if (result.release) return result.release;
      if (result.removed) removeStale = false;
      if (Date.now() >= deadline) {
        const pid = result.holder?.pid;
        throw new Error(`Another Pi process is restoring code${pid === undefined ? "" : ` (pid ${pid})`}; try again in a moment.`);
      }
      await sleep(100);
    }
  }

  private attempt(removeStale: boolean): Attempt {
    const release = this.create();
    if (release) return { release };
    const holder = this.holder();
    if (!removeStale || !holder || !this.stale(holder)) return { holder };
    this.remove(holder);
    const retried = this.create();
    return retried ? { release: retried } : { holder: this.holder() ?? holder, removed: true };
  }

  private create(): (() => void) | undefined {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = fs.openSync(this.file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    }
    const token = randomUUID();
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: Date.now() }));
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(this.file, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    held.add(token);
    return () => this.release(token);
  }

  private holder(): Holder | undefined {
    let text: string;
    let mtimeMs: number;
    try {
      text = fs.readFileSync(this.file, "utf8");
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      return undefined;
    }
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (value && typeof value.at === "number") {
        return {
          at: value.at, pid: typeof value.pid === "number" ? value.pid : undefined,
          host: typeof value.host === "string" ? value.host : undefined, token: typeof value.token === "string" ? value.token : undefined,
        };
      }
    } catch {
      /* đang được ghi hoặc hỏng */
    }
    return { at: mtimeMs };
  }

  private stale(holder: Holder): boolean {
    if (Date.now() - holder.at > this.staleMs) return true;
    if (holder.host !== os.hostname() || holder.pid === undefined) return false;
    // Khóa của chính process này mà không còn giữ: lần gỡ trước không xóa được file (Windows đang mở nó).
    if (holder.pid === process.pid) return !holder.token || !held.has(holder.token);
    return !alive(holder.pid);
  }

  /** Gỡ đúng khóa đã xét: process khác có thể vừa gỡ nó và tạo khóa mới. */
  private remove(holder: Holder): void {
    const again = this.holder();
    if (!again || again.token !== holder.token || again.at !== holder.at) return;
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* process khác vừa gỡ */
    }
  }

  private release(token: string): void {
    held.delete(token);
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as { token?: unknown };
      if (value?.token === token) fs.unlinkSync(this.file);
    } catch {
      /* đã bị gỡ; không xóa được thì lần sau coi là khóa bỏ lại */
    }
  }
}
