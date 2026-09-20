import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw new Error('Không đọc được cấu hình routing.'); }
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Không ghi routing state qua symlink.');
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}
export function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); }
  catch { throw new Error('Routing state đang khóa; không gửi request mới.'); }
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function claimWriter(directory, cwd, jobId) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workspace = fs.realpathSync(cwd);
  const file = path.join(directory, crypto.createHash('sha256').update(workspace).digest('hex') + '.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch { throw new Error('Workspace đang có writer hoặc lock chưa được giải phóng; không chạy hai writer cùng lúc.'); }
  try { fs.writeFileSync(fd, JSON.stringify({ jobId, pid: process.pid, createdAt: new Date().toISOString() })); }
  catch (error) { fs.unlinkSync(file); throw error; }
  finally { fs.closeSync(fd); }
  return () => {
    try { if (readJson(file).jobId === jobId) fs.unlinkSync(file); }
    catch { /* Retain an unknown lock; never unlock another job or hide a live writer. */ }
  };
}
export function appendAudit(dir, row) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'events.jsonl');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Không ghi audit qua symlink.');
  // Never store brief, worker output, tool arguments, credentials or provider error bodies.
  const fields = ['time', 'jobId', 'role', 'taskClass', 'candidate', 'thinking', 'source', 'status', 'durationMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'modelCostUsd', 'requestHash'];
  fs.appendFileSync(file, JSON.stringify(Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]))) + '\n', { mode: 0o600 });
}
