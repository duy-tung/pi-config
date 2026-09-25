import { type FileVersion, sameVersion } from "./store.ts";

export const ENTRY_TYPE = "pi-rewind";

/**
 * Dữ liệu lưu trong custom entry của phiên (không vào context model).
 * Trạng thái đĩa tuyến tính theo thời gian, không theo nhánh hội thoại,
 * nên lịch sử được dựng lại theo thứ tự ghi của file phiên.
 */
export type RewindEntry =
  | {
    v: 1; kind: "checkpoint"; id: string; userEntryId: string; at: number; source?: string;
    /** File đã theo dõi có phiên bản khác lần ghi nhận trước (delta theo thời gian). */
    delta: Record<string, FileVersion>;
  }
  | {
    v: 1; kind: "touch"; checkpointId: string; file: string; via: string;
    /** Nội dung trước lần đầu agent chạm vào file chưa có trong checkpoint. */
    pre?: FileVersion;
  }
  | {
    v: 1; kind: "rewind"; id: string; at: number; checkpointId: string; mode: RestoreMode;
    fromLeafId: string | null;
    /** Phiên bản ngay trước khi khôi phục; /redo dùng để hoàn tác. */
    previous: Record<string, FileVersion>;
    /** Lần khôi phục này hoàn tác một lần Redo (mục "Undo redo"). */
    undoes?: string;
  }
  | {
    v: 1; kind: "redo"; rewindId: string; at: number;
    /** Có id và previous (bản cài mới): "Undo redo" đưa code và hội thoại về ngay trước lần Redo. */
    id?: string; previous?: Record<string, FileVersion>; fromLeafId?: string | null;
  };

export type RestoreMode = "both" | "conversation" | "code";

export interface Checkpoint {
  id: string;
  userEntryId: string;
  at: number;
  source?: string;
  /** Mọi file đã theo dõi tại thời điểm checkpoint. */
  files: Map<string, FileVersion>;
  /** File agent chạm trong lượt này; giá trị là nội dung trước lần chạm đầu (nếu file mới theo dõi). */
  touched: Map<string, FileVersion | undefined>;
  order: number;
}

export interface RewindRecord {
  id: string;
  at: number;
  checkpointId: string;
  mode: RestoreMode;
  fromLeafId: string | null;
  previous: Map<string, FileVersion>;
  redone: boolean;
  /** Thứ tự giữa các lần khôi phục (rewind, Redo) trong phiên. */
  seq: number;
}

export interface RedoRecord {
  id: string;
  rewindId: string;
  at: number;
  mode: RestoreMode;
  checkpointId: string;
  /** Leaf và phiên bản file ngay trước lần Redo. */
  fromLeafId: string | null;
  previous: Map<string, FileVersion>;
  undone: boolean;
  seq: number;
}

export interface SessionEntryLike {
  type: string;
  id: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
  timestamp?: string;
  message?: { role?: string; content?: unknown; timestamp?: number };
}

function isRewindEntry(value: unknown): value is RewindEntry {
  return !!value && typeof value === "object" && (value as { v?: unknown }).v === 1 && typeof (value as { kind?: unknown }).kind === "string";
}

/** Lịch sử checkpoint của một phiên; dựng lại từ entries và cập nhật khi ghi thêm. */
export class History {
  readonly checkpoints: Checkpoint[] = [];
  readonly byId = new Map<string, Checkpoint>();
  readonly byUserEntry = new Map<string, Checkpoint>();
  /** Phiên bản mới nhất đã biết của từng file được theo dõi (theo thời gian). */
  readonly known = new Map<string, FileVersion>();
  readonly rewinds: RewindRecord[] = [];
  readonly redos: RedoRecord[] = [];
  private seq = 0;

  static fromEntries(entries: SessionEntryLike[]): History {
    const history = new History();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && isRewindEntry(entry.data)) history.apply(entry.data);
    }
    return history;
  }

  get tracked(): string[] {
    return [...this.known.keys()];
  }

  apply(entry: RewindEntry): void {
    switch (entry.kind) {
      case "checkpoint": {
        for (const [file, version] of Object.entries(entry.delta)) this.known.set(file, version);
        const checkpoint: Checkpoint = {
          id: entry.id, userEntryId: entry.userEntryId, at: entry.at, source: entry.source,
          files: new Map(this.known), touched: new Map(), order: this.checkpoints.length,
        };
        this.checkpoints.push(checkpoint);
        this.byId.set(checkpoint.id, checkpoint);
        this.byUserEntry.set(checkpoint.userEntryId, checkpoint);
        break;
      }
      case "touch": {
        const checkpoint = this.byId.get(entry.checkpointId);
        if (!checkpoint || checkpoint.touched.has(entry.file)) break;
        checkpoint.touched.set(entry.file, entry.pre);
        if (entry.pre && !this.known.has(entry.file)) this.known.set(entry.file, entry.pre);
        break;
      }
      case "rewind": {
        this.rewinds.push({
          id: entry.id, at: entry.at, checkpointId: entry.checkpointId, mode: entry.mode, fromLeafId: entry.fromLeafId,
          previous: new Map(Object.entries(entry.previous)), redone: false, seq: ++this.seq,
        });
        const redo = entry.undoes ? this.redos.find((item) => item.id === entry.undoes) : undefined;
        if (redo) redo.undone = true;
        break;
      }
      case "redo": {
        const record = this.rewinds.find((item) => item.id === entry.rewindId);
        if (record) record.redone = true;
        if (record && entry.id && entry.previous) {
          this.redos.push({
            id: entry.id, rewindId: record.id, at: entry.at, mode: record.mode, checkpointId: record.checkpointId,
            fromLeafId: entry.fromLeafId ?? null, previous: new Map(Object.entries(entry.previous)), undone: false, seq: ++this.seq,
          });
        }
        break;
      }
    }
  }

  /** Delta cho checkpoint mới: file theo dõi có phiên bản khác lần ghi nhận trước. */
  delta(current: (file: string) => FileVersion): Record<string, FileVersion> {
    const result: Record<string, FileVersion> = {};
    for (const [file, previous] of this.known) {
      const version = current(file);
      if (!sameVersion(version, previous)) result[file] = version;
    }
    return result;
  }

  /**
   * Nội dung mọi file theo dõi tại checkpoint — cùng thuật toán với Claude Code:
   * file có trong ảnh chụp checkpoint dùng bản đó; file chỉ được theo dõi sau đó
   * dùng nội dung trước lần chạm đầu tiên kể từ checkpoint.
   */
  targetsFor(checkpoint: Checkpoint): Map<string, FileVersion> {
    const targets = new Map(checkpoint.files);
    for (const later of this.checkpoints.slice(checkpoint.order)) {
      for (const [file, pre] of later.touched) {
        if (!targets.has(file) && pre) targets.set(file, pre);
      }
    }
    return targets;
  }

  /** Các file agent đã sửa trong lượt của checkpoint, với nội dung trước/sau lượt. */
  turnChanges(checkpoint: Checkpoint, current: (file: string) => FileVersion): { file: string; before: FileVersion; after: FileVersion }[] {
    const next = this.checkpoints[checkpoint.order + 1];
    const result: { file: string; before: FileVersion; after: FileVersion }[] = [];
    for (const [file, pre] of checkpoint.touched) {
      const before = checkpoint.files.get(file) ?? pre;
      if (!before) continue;
      const after = next?.files.get(file) ?? current(file);
      if (!sameVersion(before, after)) result.push({ file, before, after });
    }
    return result;
  }

  lastUndoneRewind(): RewindRecord | undefined {
    for (let index = this.rewinds.length - 1; index >= 0; index--) {
      if (!this.rewinds[index].redone) return this.rewinds[index];
    }
    return undefined;
  }

  /** Lần Redo còn hoàn tác được: là lần khôi phục mới nhất trong phiên và chưa bị hoàn tác. */
  lastRedo(): RedoRecord | undefined {
    const redo = this.redos.at(-1);
    if (!redo || redo.undone) return undefined;
    const rewind = this.rewinds.at(-1);
    return rewind && rewind.seq > redo.seq ? undefined : redo;
  }
}
