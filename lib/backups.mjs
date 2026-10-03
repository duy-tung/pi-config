import fs from 'node:fs';
import path from 'node:path';

// Bản runtime/nguồn cũ (hàng trăm MB mỗi bản) chỉ cần trong lúc cài: cài xong thì xoá (quay lại bằng cách cài lại
// commit cũ của repo). Tài nguyên đã gỡ (nhỏ, có thể là file người dùng tham chiếu) giữ 3 bản mới nhất.
// Backup file cấu hình (backups/<thời điểm ISO>/<đường dẫn so với root>, mỗi lần ghi đè một bản) giữ 20 bản mới
// nhất cho mỗi đường dẫn; thư mục thời điểm chỉ bị xoá khi đã rỗng. Mục khác trong backups không bị động tới.
const CONFIG_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/u;
const CONFIG_KEEP = 20;
const GROUPS = [
  {pattern: /^runtime-(.+)-(\d+)$/u, keep: 0},
  {pattern: /^source-(.+)-(\d+)$/u, keep: 0},
  {pattern: /^resources-()(\d+)$/u, keep: 3},
];

/** Xoá bản cũ trong <root>/backups theo GROUPS và CONFIG_KEEP; trả danh sách thư mục/file backup đã xoá. */
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
  return [...removed, ...pruneConfigBackups(dir, names)];
}

/** Giữ CONFIG_KEEP bản mới nhất của mỗi file trong các thư mục thời điểm; chỉ xoá file thường, không theo symlink. */
function pruneConfigBackups(dir, names) {
  const byFile = new Map();
  const walk = (stamp, relative) => {
    for (const entry of fs.readdirSync(path.join(dir, stamp, relative), {withFileTypes: true})) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(stamp, child);
      else if (entry.isFile()) byFile.set(child, [...byFile.get(child) ?? [], stamp]);
    }
  };
  for (const name of names) {
    if (CONFIG_DIR.test(name) && fs.lstatSync(path.join(dir, name)).isDirectory()) walk(name, '');
  }
  const removed = [];
  for (const [relative, stamps] of byFile) {
    // Tên thời điểm ISO cùng độ dài: so chuỗi là so thời gian.
    for (const stamp of stamps.sort().reverse().slice(CONFIG_KEEP)) {
      const file = path.join(dir, stamp, relative);
      fs.unlinkSync(file);
      removed.push(file);
      // Bỏ thư mục vừa rỗng do xoá file này, lên tới chính thư mục thời điểm.
      const top = path.join(dir, stamp);
      for (let parent = path.dirname(file); !fs.readdirSync(parent).length; parent = path.dirname(parent)) {
        fs.rmdirSync(parent);
        if (parent === top) break;
      }
    }
  }
  return removed;
}
