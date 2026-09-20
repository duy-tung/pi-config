import crypto from 'node:crypto';

export const VERSION = '2.0.0';
export const CANDIDATES = Object.freeze({
  sol: { provider: 'openai-codex', id: 'gpt-5.6-sol', thinking: 'high' },
  glm: { provider: 'opencode-go', id: 'glm-5.3-flash', thinking: 'max' },
});
export const ROLES = ['researcher', 'worker', 'debugger', 'reviewer'];
export const CLASSES = ['lookup', 'mechanical', 'engineering', 'design'];
export const DEFAULT_POLICY = {
  version: 2, mode: 'off', allowExplicitGlm: true, timeoutMs: 900000,
};
const fail = message => { throw new Error(message); };
const finite = n => typeof n === 'number' && Number.isFinite(n);
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validatePolicy(p) {
  const modes = p?.version === 1 ? ['off', 'manual', 'record', 'shadow', 'balanced'] : ['off', 'manual'];
  if (![1, 2].includes(p?.version) || !modes.includes(p.mode)) fail('Routing policy không hợp lệ.');
  if (typeof p.allowExplicitGlm !== 'boolean') fail('allowExplicitGlm phải là boolean.');
  if (!finite(p.timeoutMs) || p.timeoutMs < 1000 || p.timeoutMs > 1800000) fail('Giới hạn routing không hợp lệ.');
  if (p.writerLocksDir !== undefined && (typeof p.writerLocksDir !== 'string' || !p.writerLocksDir.trim())) fail('writerLocksDir không hợp lệ.');
  // Old experimental policies become manual; retired keys are never used or persisted.
  return { version: 2, mode: p.mode === 'off' ? 'off' : 'manual', allowExplicitGlm: p.allowExplicitGlm,
    timeoutMs: p.timeoutMs, ...(p.writerLocksDir === undefined ? {} : { writerLocksDir: p.writerLocksDir }) };
}
export function validateTask(t) {
  if (!t || !ROLES.includes(t.role) || (t.taskClass !== undefined && !CLASSES.includes(t.taskClass)) || !['auto', 'sol', 'glm'].includes(t.candidate)) fail('Role/class/candidate không hợp lệ.');
  for (const key of ['brief', 'acceptance']) if (typeof t[key] !== 'string' || !t[key].trim() || t[key].length > 12000) fail('Brief và acceptance phải đầy đủ, tối đa 12000 ký tự mỗi trường.');
  if (typeof t.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(t.requestId)) fail('requestId phải ổn định và chỉ chứa chữ, số, _ hoặc -.');
  return t;
}
export function validateRole(r, name, subagents) {
  if (!r?.enabled || !ROLES.includes(name)) fail('Role không có hoặc đã tắt.');
  const expected = ['read', 'grep', 'find', 'ls', ...(['worker', 'debugger'].includes(name) ? ['write', 'edit', 'bash'] : [])];
  const extensions = ['pi-anthropic-auth', 'pi-permission-system', ...(name === 'researcher' ? ['pi-web-access'] : [])];
  const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());
  if (!same(r.builtinToolNames, expected) || !same(r.extensions, extensions) || !same(r.extSelectors, name === 'researcher' ? ['ext:pi-web-access'] : [])) fail('Quyền role khác contract đã nghiệm thu; cần xem lại cấu hình project.');
  if (r.inheritContext !== false || r.isolated !== false || r.promptMode !== 'replace' || r.maxTurns !== 12 || r.model !== 'openai-codex/gpt-5.6-sol' || r.thinking !== 'high' || r.skills?.length || r.allowedSubagents?.length) fail('Context/model/giới hạn role đã thay đổi; từ chối fallback ngầm.');
  if (subagents.scopeModels !== true || subagents.fallbackSubagent !== 'none' || subagents.maxConcurrent !== 2 || subagents.graceTurns !== 2) fail('Giới hạn pi-subagents đã thay đổi; cần nghiệm thu lại.');
}
export function selectCandidate(task, policy) {
  if (task.taskClass === 'design') return { candidate: null, source: 'parent', reason: 'Astra giữ quyết định thiết kế.' };
  if (task.candidate !== 'auto') {
    if (task.candidate === 'glm' && (!policy.allowExplicitGlm || task.role === 'reviewer')) fail('GLM explicit không được phép cho role này.');
    return { candidate: task.candidate, source: 'explicit', reason: 'Parent chọn model tường minh; vẫn áp quyền và scope.' };
  }
  return { candidate: 'sol', source: 'default', reason: 'Mặc định Sol/high.' };
}

export function rpc(events, name, payload = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const topic = `subagents:rpc:${name}`;
    const unsubscribe = events.on(`${topic}:reply:${requestId}`, r => {
      clearTimeout(timer); unsubscribe();
      r?.success ? resolve(r.data) : reject(new Error('Pi-subagents từ chối RPC; kiểm model, scope hoặc trạng thái task.'));
    });
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Pi-subagents RPC ${name} hết thời gian.`)); }, timeoutMs);
    events.emit(topic, { ...payload, requestId });
  });
}
export async function spawnAndJoin(events, role, prompt, options, { signal, timeoutMs, onStarted = () => {}, onQueued = () => {}, onSettled = () => {} }) {
  await rpc(events, 'ping');
  if (signal?.aborted) fail('Task đã hủy.');
  return new Promise((resolve, reject) => {
    let id, settled = false, drainTimer;
    const cleanup = () => { clearTimeout(timer); clearTimeout(drainTimer); offDone(); offFail(); signal?.removeEventListener('abort', abort); };
    const stop = () => { if (id) events.emit('subagents:rpc:stop', { requestId: crypto.randomUUID(), agentId: id }); };
    const finish = event => {
      if (!id || event.id !== id) return;
      // Synchronous consumption prevents a second parent notification/turn.
      events.emit('subagents:rpc:consume', { requestId: crypto.randomUUID(), agentId: id });
      onSettled();
      if (settled) { cleanup(); return; }
      settled = true;
      cleanup(); resolve(event);
    };
    const offDone = events.on('subagents:completed', finish), offFail = events.on('subagents:failed', finish);
    const abort = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Keep a short drain listener to consume the asynchronous stopped event.
      // Otherwise cancellation would trigger a second parent notification.
      drainTimer = setTimeout(cleanup, 10000); drainTimer.unref?.();
      stop(); reject(new Error('Task đã hủy; đã yêu cầu dừng worker.'));
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    rpc(events, 'spawn', { type: role, prompt, options: { ...options, signal, onQueued: (childId, ahead) => {
      id = childId; if (settled) stop(); else onQueued(id, ahead);
    }, onSpawned: childId => {
      id = childId; if (settled) stop(); else onStarted(id);
    } } }, timeoutMs).catch(() => {
      if (settled) return;
      settled = true; stop(); cleanup(); reject(new Error('Không khởi động được worker; không tự đổi model.'));
    });
  });
}
