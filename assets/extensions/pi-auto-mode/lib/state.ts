import { createHash, randomUUID } from "node:crypto";

/** Giới hạn của Claude Code: 3 lần chặn liên tiếp hoặc 20 lần trong phiên thì hỏi người dùng. */
export const LIMITS = { consecutive: 3, total: 20 };

export interface DenialRecord {
  id: string;
  at: number;
  toolName: string;
  summary: string;
  reason: string;
  rule?: string;
  key: string;
  approved: boolean;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Khóa của đúng một lời gọi (tên tool + input), dùng cho duyệt một lần và chống sửa input. */
export function callKey(toolName: string, input: unknown): string {
  return createHash("sha256").update(`${toolName}\0${JSON.stringify(stable(input))}`).digest("hex");
}

export class PermissionState {
  consecutive = 0;
  total = 0;
  readonly recent: DenialRecord[] = [];
  private readonly approvals = new Map<string, number>();

  recordAllowed(): void {
    this.consecutive = 0;
  }

  /** Ghi một lần bị chặn; trả về giới hạn vừa chạm (nếu có). */
  recordDenied(record: Omit<DenialRecord, "id" | "at" | "approved">, counted: boolean): "consecutive" | "total" | undefined {
    this.recent.unshift({ ...record, id: randomUUID(), at: Date.now(), approved: false });
    if (this.recent.length > 20) this.recent.length = 20;
    if (!counted) return undefined;
    this.consecutive++;
    this.total++;
    if (this.total >= LIMITS.total) return "total";
    if (this.consecutive >= LIMITS.consecutive) return "consecutive";
    return undefined;
  }

  /** Người dùng đã xem xét sau khi chạm giới hạn. */
  resetLimit(limit: "consecutive" | "total"): void {
    this.consecutive = 0;
    if (limit === "total") this.total = 0;
  }

  /** Duyệt một lần đúng lời gọi này (qua /permissions); vẫn chịu luật deny. */
  approve(key: string): void {
    this.approvals.set(key, (this.approvals.get(key) ?? 0) + 1);
    for (const record of this.recent) if (record.key === key) record.approved = true;
  }

  consumeApproval(key: string): boolean {
    const count = this.approvals.get(key) ?? 0;
    if (!count) return false;
    if (count === 1) this.approvals.delete(key);
    else this.approvals.set(key, count - 1);
    return true;
  }
}
