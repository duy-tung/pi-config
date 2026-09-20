import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Type } from '@sinclair/typebox';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { VERSION, CANDIDATES, ROLES, CLASSES, DEFAULT_POLICY, validatePolicy, validateTask, validateRole, digest,
  selectCandidate, spawnAndJoin, rpc } from './core.mjs';
import { readJson, atomicJson, withLock, claimWriter, appendAudit } from './storage.mjs';

async function bindings(agentDir, cwd, role, trusted) {
  const projectResources = ['.pi/settings.json', '.pi/subagents.json', '.pi/agents', '.agents/agents'];
  if (!trusted && projectResources.some(file => fs.existsSync(path.join(cwd, file)))) throw new Error('Project chưa được Pi trust; chưa nạp cấu hình hoặc role của project.');
  const global = readJson(path.join(agentDir, 'settings.json'));
  const project = readJson(path.join(cwd, '.pi', 'settings.json'), {});
  // Never use a project-controlled package path as executable loader code.
  const pkg = global.packages?.find(p => typeof p === 'string' && p.replaceAll('\\', '/').endsWith('/@tintinweb/pi-subagents'));
  if (!pkg || !path.isAbsolute(pkg) || readJson(path.join(pkg, 'package.json')).version !== '0.19.0') throw new Error('Router cần pi-subagents 0.19.0 đang nạp trong profile.');
  if (project.packages && (!Array.isArray(project.packages) || !project.packages.includes(pkg))) throw new Error('Project thay package contract; router chỉ dùng bản tintin đã ghim ở global config.');
  const require = createRequire(path.join(pkg, 'package.json'));
  const jiti = require('jiti').createJiti(path.join(pkg, 'package.json'));
  const { loadCustomAgents } = await jiti.import(path.join(pkg, 'src/custom-agents.ts'));
  const { loadSettings } = await jiti.import(path.join(pkg, 'src/settings.ts'));
  const resolved = loadCustomAgents(cwd, true).get(role);
  const subagents = loadSettings(cwd);
  validateRole(resolved, role, subagents);
  const scope = project.enabledModels ?? global.enabledModels;
  if (!Array.isArray(scope)) throw new Error('Router cần enabledModels tường minh.');
  const fingerprint = digest({ role: fs.readFileSync(resolved.sourcePath, 'utf8'), subagents, scope });
  return { role: resolved, scope, fingerprint };
}
const result = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

export default function (pi) {
  const agentDir = getAgentDir();
  const policyFile = path.join(agentDir, 'routing.json');
  const stateDir = path.join(agentDir, 'routing-state');
  const jobsFile = path.join(stateDir, 'jobs.json');
  const running = new Map(), completed = new Map();
  const policy = () => validatePolicy(readJson(policyFile, DEFAULT_POLICY));
  const saveJob = (id, value) => withLock(jobsFile, () => {
    const jobs = readJson(jobsFile, {});
    jobs[id] = { ...jobs[id], ...value };
    const sorted = Object.entries(jobs).sort((a, b) => (b[1].time ?? '').localeCompare(a[1].time ?? ''));
    atomicJson(jobsFile, Object.fromEntries(sorted.slice(0, 1000)));
  });
  pi.on('session_shutdown', () => { for (const controller of running.values()) controller.abort(); completed.clear(); });
  pi.registerCommand('routing', {
    description: 'Dispatcher native: /routing status|explain <jobId>|manual|off.',
    handler: async (args, ctx) => {
      try {
        const [rawAction, id] = args.trim() ? args.trim().split(/\s+/) : ['status'];
        const action = rawAction === 'record' ? 'manual' : rawAction;
        const p = policy();
        if (['shadow', 'balanced'].includes(action)) throw new Error('Jev đã gỡ; dùng /routing manual hoặc /routing off.');
        if (['off', 'manual'].includes(action)) {
          p.mode = action; atomicJson(policyFile, p);
          if (action === 'off') for (const controller of running.values()) controller.abort();
          ctx.ui.notify(`Routing: ${action}`, 'info'); return;
        }
        if (action === 'explain') {
          if (!id || !/^[a-f0-9]{20}$/.test(id)) throw new Error('Dùng /routing explain <jobId>.');
          const job = readJson(jobsFile, {})[id];
          ctx.ui.notify(job ? JSON.stringify(job) : 'Không có task này.', 'info'); return;
        }
        if (action !== 'status') throw new Error('Dùng /routing status|explain <jobId>|manual|off.');
        ctx.ui.notify(`Dispatcher ${VERSION}: ${p.mode}; mặc định Sol/high, GLM/max khi chọn tường minh.`, 'info');
      } catch (error) { ctx.ui.notify(error.message, 'warning'); }
    },
  });
  pi.registerTool({
    name: 'dispatch_task', label: 'Giao task',
    description: 'Giao task hữu hạn cho role Pi có context riêng. Mặc định Sol/high, candidate=glm chọn GLM/max. Parent giữ thiết kế/nghiệm thu. Không đổi quyền hay gọi CLI khác. requestId ổn định chống chạy trùng. Không tự retry task bị chặn.',
    promptSnippet: 'Giao task hữu hạn qua router Pi (Sol/high, GLM/max).',
    parameters: Type.Object({
      requestId: Type.String({ maxLength: 80 }), role: Type.Union(ROLES.map(x => Type.Literal(x))),
      taskClass: Type.Optional(Type.Union(CLASSES.map(x => Type.Literal(x)))),
      candidate: Type.Optional(Type.Union(['auto', 'sol', 'glm'].map(x => Type.Literal(x)))),
      brief: Type.String({ minLength: 1, maxLength: 12000 }), acceptance: Type.String({ minLength: 1, maxLength: 12000 }),
    }, { additionalProperties: false }),
    async execute(_callId, args, signal, update, ctx) {
      const task = validateTask({ ...args, candidate: args.candidate ?? 'auto' });
      const p = policy();
      if (p.mode === 'off') throw new Error('Routing đang off. Dùng Agent như trước hoặc /routing manual.');
      const sessionId = ctx.sessionManager.getSessionId();
      const jobId = digest([sessionId, ctx.cwd, task.requestId]).slice(0, 20);
      const requestHash = digest(task);
      if (completed.has(jobId)) {
        if (completed.get(jobId).requestHash !== requestHash) throw new Error('requestId đã dùng cho task khác.');
        return completed.get(jobId).result;
      }
      withLock(jobsFile, () => {
        const jobs = readJson(jobsFile, {});
        if (jobs[jobId]) throw new Error('requestId đã được ghi nhận; xem /routing explain, không spawn lần hai.');
        jobs[jobId] = { jobId, requestHash, status: 'validating', time: new Date().toISOString(), role: task.role, taskClass: task.taskClass };
        atomicJson(jobsFile, jobs);
      });
      const controller = new AbortController(); running.set(jobId, controller);
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      const startedAt = Date.now();
      let selection, model, releaseWriter, childAllocated = false;
      try {
        const binding = await bindings(agentDir, ctx.cwd, task.role, ctx.isProjectTrusted());
        await rpc(pi.events, 'ping');
        if (controller.signal.aborted) throw new Error('Task đã hủy trước spawn.');
        selection = selectCandidate(task, p);
        saveJob(jobId, selection);
        if (!selection.candidate) {
          const output = result(selection.reason, { jobId, status: 'parent' });
          saveJob(jobId, { status: 'parent' }); completed.set(jobId, { requestHash, result: output }); return output;
        }
        const candidate = CANDIDATES[selection.candidate];
        const id = `${candidate.provider}/${candidate.id}`;
        if (!binding.scope.includes(id)) throw new Error('Candidate nằm ngoài enabledModels; không đổi sang model khác.');
        model = ctx.modelRegistry.find(candidate.provider, candidate.id);
        if (!model || model.provider !== candidate.provider || model.id !== candidate.id || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error('Model chính xác hoặc credential chưa sẵn sàng; không fallback ngầm.');
        if (!getSupportedThinkingLevels(model).includes(candidate.thinking)) throw new Error('Model không hỗ trợ effort đã ghim.');
        if (ctx.scopedModels?.length && !ctx.scopedModels.some(x => x.model.provider === model.provider && x.model.id === model.id)) throw new Error('Candidate ngoài scope của session hiện tại; mở lại Pi hoặc cập nhật scoped models.');
        const fresh = await bindings(agentDir, ctx.cwd, task.role, ctx.isProjectTrusted());
        if (fresh.fingerprint !== binding.fingerprint || digest(policy()) !== digest(p)) throw new Error('Cấu hình thay đổi trong khi routing; chưa spawn.');
        if (['worker', 'debugger'].includes(task.role)) {
          const directory = p.writerLocksDir ?? path.join(stateDir, 'writers');
          if (!path.isAbsolute(directory)) throw new Error('writerLocksDir phải là đường dẫn tuyệt đối.');
          releaseWriter = claimWriter(directory, ctx.cwd, jobId);
        }
        saveJob(jobId, { status: 'queued', model: id, thinking: candidate.thinking });
        update?.(result(`${task.role} · ${candidate.id} ${candidate.thinking} · ${selection.source}`, { jobId, status: 'queued' }));
        const prompt = `Task ID: ${task.requestId}\nMục tiêu và phạm vi:\n${task.brief}\n\nTiêu chí nghiệm thu:\n${task.acceptance}\n\nBáo file/evidence, kiểm thử thực tế và blocker. Không giao việc tiếp hoặc tự đổi model.`;
        const event = await spawnAndJoin(pi.events, task.role, prompt, {
          model, thinkingLevel: candidate.thinking, maxTurns: 12, inheritContext: false, isolated: false,
          isBackground: true, bypassQueue: false, description: `${jobId} · ${task.role} · ${candidate.id}/${candidate.thinking}`,
        }, { signal: controller.signal, timeoutMs: p.timeoutMs,
          onQueued: (childId, ahead) => { childAllocated = true; saveJob(jobId, { childId, status: 'queued', ahead }); },
          onStarted: childId => { childAllocated = true; saveJob(jobId, { childId, status: 'running' }); },
          onSettled: () => releaseWriter?.() });
        const failed = ['error', 'stopped', 'aborted'].includes(event.status);
        const status = failed ? 'blocked' : 'completed-unreviewed';
        const text = failed ? 'Worker bị chặn/lỗi. Parent kiểm evidence; không tự đổi model để vượt blocker.' : String(event.result ?? 'Worker kết thúc, chưa có báo cáo.');
        const output = result(text.length > 14000 ? text.slice(0, 14000) + '\n[Báo cáo rút gọn; xem get_subagent_result bằng childId.]' : text,
          { jobId, childId: event.id, model: id, thinking: candidate.thinking, source: selection.source, status });
        saveJob(jobId, { status, durationMs: Date.now() - startedAt });
        appendAudit(stateDir, { time: new Date().toISOString(), jobId, role: task.role, taskClass: task.taskClass, candidate: id, thinking: candidate.thinking, source: selection.source, status,
          durationMs: Date.now() - startedAt, inputTokens: event.usage?.input, outputTokens: event.usage?.output,
          cacheReadTokens: event.usage?.cacheRead, modelCostUsd: event.usage?.cost?.total, requestHash });
        completed.set(jobId, { requestHash, result: output });
        if (completed.size > 128) completed.delete(completed.keys().next().value);
        return output;
      } catch (error) {
        saveJob(jobId, { status: controller.signal.aborted ? 'cancelled' : 'blocked', durationMs: Date.now() - startedAt });
        throw error;
      } finally {
        if (!childAllocated) releaseWriter?.();
        signal?.removeEventListener('abort', abort); running.delete(jobId);
      }
    },
  });
}
