import fs from 'node:fs';
import path from 'node:path';

// Bản runtime/nguồn cũ (hàng trăm MB mỗi bản) và tài nguyên đã gỡ: giữ vài bản mới nhất mỗi loại để quay lại.
// Thư mục backup file cấu hình (tên theo thời điểm ISO) chứa bản sửa của người dùng nên không bao giờ bị xoá.
const GROUPS = [
  {pattern: /^runtime-(.+)-(\d+)$/u, keep: 1},
  {pattern: /^source-(.+)-(\d+)$/u, keep: 1},
  {pattern: /^resources-()(\d+)$/u, keep: 3},
];

/** Xoá bản cũ trong <root>/backups theo GROUPS; trả danh sách thư mục đã xoá. */
export function pruneBackups(root) {
  const dir = path.join(root, 'backups');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const {pattern, keep} of GROUPS) {
    const byName = new Map();
    for (const name of names) {
      const match = pattern.exec(name);
      if (!match) continue;
      const list = byName.get(match[1]) ?? [];
      list.push({name, time: Number(match[2])});
      byName.set(match[1], list);
    }
    for (const list of byName.values()) {
      list.sort((a, b) => b.time - a.time);
      for (const {name} of list.slice(keep)) {
        const target = path.join(dir, name);
        if (fs.lstatSync(target).isSymbolicLink()) continue;
        fs.rmSync(target, {recursive: true, force: true});
        removed.push(target);
      }
    }
  }
  return removed;
}
