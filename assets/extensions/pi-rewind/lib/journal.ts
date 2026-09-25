import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { alive } from "./lock.ts";
import type { PlanItem } from "./restore.ts";
import { type Capturer, type FileVersion, sameVersion } from "./store.ts";

/**
 * Nhật ký phục hồi: ghi trước khi khôi phục code, xóa khi rewind/redo xong (kể cả khi lỗi).
 * Nhật ký còn lại mà process ghi nó đã chết nghĩa là Pi thoát giữa lúc ghi file:
 * có file đã về bản đích, có file chưa. /rewind cho hoàn tất hoặc hoàn tác lần khôi phục đó.
 */
export interface Journal {
  v: 1;
  id: string;
  pid: number;
  at: number;
  sessionFile?: string;
  /** Lần rewind gây ra việc khôi phục (để ghi lại cho Redo khi hoàn tất trong cùng phiên). */
  checkpointId?: string;
  /** Mỗi file sẽ ghi: nội dung trước và sau khi khôi phục. */
  files: Record<string, { before: FileVersion; after: FileVersion }>;
}

export class JournalStore {
  readonly dir: string;

  constructor(storageDir: string) {
    this.dir = path.join(storageDir, "journal");
  }

  begin(data: Pick<Journal, "sessionFile" | "checkpointId">, plan: PlanItem[]): string {
    const id = randomUUID();
    const files: Journal["files"] = {};
    for (const item of plan) if (item.target.kind !== "unprotected" && item.current.kind !== "unprotected") files[item.file] = { before: item.current, after: item.target };
    const journal: Journal = { v: 1, id, pid: process.pid, at: Date.now(), ...data, files };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return id;
  }

  end(id: string): void {
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`));
    } catch {
      /* đã xóa */
    }
  }

  /** Mọi nhật ký đọc được, mới nhất trước. */
  all(): Journal[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const result: Journal[] = [];
    for (const name of names) {
      const journal = this.load(path.join(this.dir, name));
      if (journal) result.push(journal);
    }
    return result.sort((a, b) => b.at - a.at);
  }

  /** Nhật ký theo id; undefined khi lần khôi phục đã xong (process khác vừa hoàn tất hoặc bỏ qua). */
  read(id: string): Journal | undefined {
    return this.load(path.join(this.dir, `${id}.json`));
  }

  /** Nhật ký của process đã chết, mới nhất trước. */
  interrupted(isAlive: (pid: number) => boolean = alive): Journal[] {
    return this.all().filter((journal) => !isAlive(journal.pid));
  }

  /** SHA của blob mà nhật ký còn cần (nội dung trước và sau): dọn kho không được xóa. */
  referenced(): Set<string> {
    const result = new Set<string>();
    for (const journal of this.all()) {
      for (const { before, after } of Object.values(journal.files)) {
        for (const version of [before, after]) if (version?.kind === "file") result.add(version.sha);
      }
    }
    return result;
  }

  /** Xóa nhật ký quá hạn lưu giữ (blob của nó có thể đã bị dọn); không lần khôi phục nào kéo dài tới vậy. */
  gc(maxAgeMs: number, now = Date.now()): void {
    for (const journal of this.all()) if (now - journal.at > maxAgeMs) this.end(journal.id);
  }

  private load(file: string): Journal | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
      if (value?.v !== 1 || typeof value.id !== "string" || typeof value.pid !== "number" || !value.files || typeof value.files !== "object") return undefined;
      return value;
    } catch {
      // Chưa có, đã xóa, hỏng hoặc đang ghi.
      return undefined;
    }
  }
}

/**
 * Kế hoạch hoàn tất (finish) hoặc hoàn tác (undo) lần khôi phục bị gián đoạn. Chỉ đụng file vẫn
 * còn ở nội dung trước hoặc sau; file đã đổi theo cách khác kể từ đó được để nguyên và báo lại.
 */
export function planRecovery(journal: Journal, direction: "finish" | "undo", capturer: Capturer): { plan: PlanItem[]; changed: string[] } {
  const plan: PlanItem[] = [];
  const changed: string[] = [];
  for (const [file, { before, after }] of Object.entries(journal.files)) {
    const current = capturer.capture(file);
    if (!sameVersion(current, before) && !sameVersion(current, after)) {
      changed.push(file);
      continue;
    }
    const target = direction === "finish" ? after : before;
    if (!sameVersion(current, target)) plan.push({ file, target, current });
  }
  plan.sort((a, b) => a.file.localeCompare(b.file));
  return { plan, changed: changed.sort() };
}
