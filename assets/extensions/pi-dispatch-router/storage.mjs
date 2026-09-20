import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJudgment } from './core.mjs';

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
export function readTypesafeKey(policyFile, policy) {
  if (!policy.jev.enabled) return undefined;
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  if (policy.typesafeKeyFile) {
    if (!path.isAbsolute(policy.typesafeKeyFile)) throw new Error('typesafeKeyFile phải tuyệt đối.');
    try {
      const stat = fs.statSync(policy.typesafeKeyFile);
      if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Credential permissions');
      const match = fs.readFileSync(policy.typesafeKeyFile, 'utf8').match(/^TYPESAFE_API_KEY=([^\r\n]+)$/m);
      if (match) return match[1].trim();
    } catch { throw new Error('Không đọc được credential TypeSafe được cấu hình.'); }
  }
  const saved = readJson(path.join(path.dirname(policyFile), 'compact-adviser.json'), {});
  return typeof saved.typesafeApiKey === 'string' ? saved.typesafeApiKey.trim() : undefined;
}
// Reserve a worst-case API context BEFORE sending. Crashed/unknown requests stay charged.
const RESERVATION_USD = 64000 * 0.042 / 1e6;
export async function callJev({ request, key, policy, ledgerFile, signal, fetchImpl = globalThis.fetch }) {
  if (!key) throw new Error('Thiếu credential TypeSafe.');
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > 32000) throw new Error('Brief vượt giới hạn Jev 32KB.');
  const ticket = crypto.randomUUID();
  withLock(ledgerFile, () => {
    const ledger = readJson(ledgerFile, { calls: 0, chargedUsd: 0, pending: {} });
    if (!Number.isSafeInteger(ledger.calls) || !Number.isFinite(ledger.chargedUsd) || ledger.calls < 0 || ledger.chargedUsd < 0) throw new Error('Budget ledger không hợp lệ.');
    if (ledger.calls >= policy.maxCalls || ledger.chargedUsd + RESERVATION_USD > policy.budgetUsd) throw new Error('Đã hết ngân sách Jev; giữ baseline.');
    ledger.calls++; ledger.chargedUsd += RESERVATION_USD; ledger.pending[ticket] = RESERVATION_USD; atomicJson(ledgerFile, ledger);
  });
  const timer = AbortSignal.timeout(policy.timeoutMs);
  let raw;
  try {
    const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timer]) : timer,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
    });
    if (!response.ok) throw new Error('HTTP failure');
    const text = await response.text();
    if (text.length > 64000) throw new Error('Response too large');
    raw = JSON.parse(text);
  } catch { throw new Error('Jev không trả kết quả; không retry, giữ khoản dự phòng ngân sách.'); }
  const judgment = parseJudgment(raw);
  withLock(ledgerFile, () => {
    const ledger = readJson(ledgerFile);
    if (ledger.pending[ticket] === undefined) throw new Error('Budget reservation không tồn tại.');
    ledger.chargedUsd = Math.max(0, ledger.chargedUsd - ledger.pending[ticket] + judgment.inputTokens * 0.042 / 1e6);
    delete ledger.pending[ticket]; atomicJson(ledgerFile, ledger);
  });
  return judgment;
}
export function appendAudit(dir, row) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'events.jsonl');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Không ghi audit qua symlink.');
  // Never store brief, worker output, tool arguments, credentials or provider error bodies.
  const fields = ['time', 'jobId', 'role', 'taskClass', 'candidate', 'thinking', 'source', 'status', 'durationMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'modelCostUsd', 'requestHash'];
  fs.appendFileSync(file, JSON.stringify(Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]))) + '\n', { mode: 0o600 });
}
