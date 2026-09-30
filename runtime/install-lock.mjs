import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Tiến trình còn chạy (EPERM: còn, nhưng thuộc người dùng khác). */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const lockPid = file => {
  try { return Number.parseInt(fs.readFileSync(file, 'utf8'), 10); } catch { return undefined; }
};

/**
 * Khóa chung <root>/.install.lock của installer và pi-models, chứa PID. Khóa của tiến trình đã chết (cài bị ngắt)
 * được gỡ: đổi tên trước rồi kiểm PID, để không xoá nhầm khóa mới một tiến trình khác vừa tạo. Trả hàm mở khóa.
 */
export function acquireInstallLock(root, log = message => console.error(message)) {
  const lock = path.join(root, '.install.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      const descriptor = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, String(process.pid)); } finally { fs.closeSync(descriptor); }
      return () => fs.rmSync(lock, {force: true});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const pid = lockPid(lock);
    if (attempt === 0 && Number.isInteger(pid) && pid > 0 && !alive(pid)) {
      const aside = `${lock}.${randomUUID()}.stale`;
      try { fs.renameSync(lock, aside); } catch { continue; }
      if (lockPid(aside) === pid) log(`Gỡ khóa cũ ${lock}: tiến trình ${pid} không còn chạy.`);
      else try { fs.linkSync(aside, lock); } catch { /* đã có khóa mới hơn */ }
      fs.rmSync(aside, {force: true});
      continue;
    }
    throw new Error(`Installer hoặc pi-models khác đang chạy${Number.isInteger(pid) ? ` (PID ${pid})` : ''}: ${lock}. ` +
      'Chờ xong rồi thử lại; nếu chắc không còn tiến trình nào thì xoá file này.');
  }
}
