export interface LineStats {
  insertions: number;
  deletions: number;
  binary?: boolean;
}

function lines(text: string): string[] {
  if (text === "") return [];
  const result = text.split("\n");
  if (result[result.length - 1] === "") result.pop();
  return result;
}

export function isBinary(data: Buffer): boolean {
  const limit = Math.min(data.length, 8000);
  for (let i = 0; i < limit; i++) if (data[i] === 0) return true;
  return false;
}

/**
 * Số dòng thêm/xóa giữa hai văn bản theo Myers O((N+M)D).
 * Chỉ cần độ dài kịch bản sửa, không cần dựng diff; D bị chặn để file khác
 * hoàn toàn không làm treo giao diện (khi vượt ngưỡng: coi như thay toàn bộ).
 */
export function lineDiffCounts(before: string, after: string, maxEdits = 4000): LineStats {
  if (before === after) return { insertions: 0, deletions: 0 };
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0) return { insertions: m, deletions: 0 };
  if (m === 0) return { insertions: 0, deletions: n };
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const common = (n + m - d) / 2;
        return { insertions: m - common, deletions: n - common };
      }
    }
  }
  return { insertions: m, deletions: n };
}

export function bufferDiffCounts(before: Buffer | undefined, after: Buffer | undefined): LineStats {
  if ((before && isBinary(before)) || (after && isBinary(after))) {
    return { insertions: 0, deletions: 0, binary: true };
  }
  return lineDiffCounts(before?.toString("utf8") ?? "", after?.toString("utf8") ?? "");
}
