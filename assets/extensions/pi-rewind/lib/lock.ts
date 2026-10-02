import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Process còn chạy (EPERM: còn, nhưng thuộc người dùng khác). */
export function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Khóa giữa các process Pi dùng chung storageDir khi ghi code (rewind, Redo, Undo redo, phục hồi) và khi dọn kho:
 * file `lock` tạo bằng O_EXCL, chứa pid và một token ngẫu nhiên. Không reentrant: cùng process (kể cả bản nạp lại module sau /reload) thấy
 * pid mình còn sống nên coi là bận. Khóa của process đã chết hoặc cũ hơn staleMs được gỡ.
 */
export class StorageLock {
  readonly file: string;
  private readonly options: { waitMs?: number; staleMs?: number };
  private pid?: number;

  constructor(storageDir: string, options: { waitMs?: number; staleMs?: number } = {}) {
    this.file = path.join(storageDir, "lock");
    this.options = options;
  }

  /** Một lần thử, không chờ. undefined: process khác đang giữ. */
  tryAcquire(): (() => void) | undefined {
    return this.create() ?? (this.takeOver() ? this.create() : undefined);
  }

  /** Chờ tối đa waitMs; vẫn bận thì báo lỗi và không làm gì. */
  async acquire(): Promise<() => void> {
    const deadline = Date.now() + (this.options.waitMs ?? 5000);
    for (;;) {
      const release = this.tryAcquire();
      if (release) return release;
      if (Date.now() >= deadline) throw new Error(`Another Pi process is restoring code${this.pid ? ` (pid ${this.pid})` : ""}; try again in a moment.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private create(): (() => void) | undefined {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = fs.openSync(this.file, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code; // Windows: khóa vừa xóa còn delete pending báo EPERM
      if (code === "EEXIST" || (process.platform === "win32" && code === "EPERM")) return undefined;
      throw error;
    }
    // Token: inode có thể được dùng lại ngay cho file mới cùng tên (Linux), nên nhận diện khóa bằng nội dung.
    const content = `${process.pid}\n${randomUUID()}`;
    try {
      fs.writeFileSync(fd, content);
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(this.file, { force: true });
      throw error;
    }
    fs.closeSync(fd);
    // Chỉ gỡ đúng file mình tạo: khóa đã bị gỡ vì quá staleMs rồi thay bằng khóa khác thì để nguyên.
    return () => void (read(this.file) === content && fs.rmSync(this.file, { force: true }));
  }

  /** Gỡ khóa bỏ lại; true khi đã gỡ. Đổi tên (nguyên tử) rồi so inode và nội dung nên hai process không cùng gỡ được một khóa. */
  private takeOver(): boolean {
    let stat: fs.Stats, text: string;
    try {
      stat = fs.statSync(this.file);
      text = fs.readFileSync(this.file, "utf8");
      this.pid = Number.parseInt(text, 10) || undefined; // chưa có pid (đang ghi): chỉ xét tuổi
    } catch {
      return true; // vừa được gỡ: thử tạo lại
    }
    if (Date.now() - stat.mtimeMs <= (this.options.staleMs ?? 10 * 60 * 1000) && (!this.pid || alive(this.pid))) return false;
    const aside = `${this.file}.${randomUUID()}.stale`;
    try {
      fs.renameSync(this.file, aside);
    } catch {
      return false; // process khác vừa gỡ
    }
    const same = fs.statSync(aside).ino === stat.ino && read(aside) === text;
    try {
      if (!same) fs.linkSync(aside, this.file); // lỡ lấy phải khóa mới của process khác: trả lại, không ghi đè
    } catch {
      /* đã có khóa khác nữa */
    }
    fs.rmSync(aside, { force: true });
    return same;
  }
}
