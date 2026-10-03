import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {buildConfiguration} from '../lib/config.mjs';
import {mergesConfig} from '../lib/resources.mjs';
import {defaultsFile, planConfigFile, sha256, writeAtomic, writeConfigPlan} from '../runtime/merge.mjs';
import {SUBAGENT_ROLES, rebaseModels} from '../runtime/model-roles.mjs';
import {modelDefaults, readJson, simulatedInstall as install} from './install-fixture.mjs';
import {saveClassifier} from '../assets/extensions/pi-auto-mode/lib/config.ts';

/** Mặc định với vài vai đổi model/thinking. */
const withRoles = changes => Object.fromEntries(Object.entries(modelDefaults).map(([name, value]) => [name, {...value, ...changes[name]}]));

/** Cài lại như installer với các mặc định cho trước; trả kế hoạch của từng file cấu hình đã ghi. */
function reinstall(f, defaults = modelDefaults) {
  const state = f.state(), plans = {};
  for (const {path: file, content} of buildConfiguration({...f.options, modelDefaults: defaults})) {
    if (!mergesConfig(file, f.options)) continue;
    const plan = planConfigFile({root: f.root, file, content, recorded: state.files[file]});
    if (plan.preserved) continue;
    writeConfigPlan(plan);
    state.files[file] = plan.recorded;
    plans[file] = plan;
  }
  fs.writeFileSync(f.statePath, JSON.stringify(state));
  return plans;
}
const frontmatter = (f, role) => fs.readFileSync(f.file(`agents/${role}.md`), 'utf8').split('\n---\n')[0];

test('model đổi trong file gốc (/agents, /model, /advisor-models) được giữ khi cài lại; vai chưa đổi nhận mặc định mới', t => {
  const f = install(t);
  // /agents đổi model và thinking của worker; người dùng sửa tools của reviewer; /model lưu Sonnet vào executor của
  // advisor và settings.json; /advisor-models đổi model của advisor.
  const worker = f.file('agents/worker.md'), reviewer = f.file('agents/reviewer.md');
  fs.writeFileSync(worker, fs.readFileSync(worker, 'utf8').replace(/^model: .*\nthinking: .*$/mu, 'model: anthropic/claude-opus-5-5\nthinking: high'));
  fs.writeFileSync(reviewer, fs.readFileSync(reviewer, 'utf8').replace(/^tools: .*$/mu, 'tools: "read, bash"'));
  const settings = readJson(f.file('settings.json'));
  Object.assign(settings, {defaultModel: 'claude-sonnet-5-5'});
  fs.writeFileSync(f.file('settings.json'), JSON.stringify(settings));
  const advisor = readJson(f.file('advisor.json'));
  Object.assign(advisor, {executor: 'anthropic/claude-sonnet-5-5', advisor: 'anthropic/claude-fable-5-1'});
  fs.writeFileSync(f.file('advisor.json'), JSON.stringify(advisor, null, 2));
  // Bản phát hành mới đổi model mặc định của worker, reviewer và researcher.
  const next = withRoles({
    worker: {model: 'openai-codex/gpt-6.2-sol'}, reviewer: {model: 'openai-codex/gpt-6.2-astra'}, researcher: {model: 'opencode-go/glm-5.4-flash'},
  });
  const plans = reinstall(f, next);
  // worker: người dùng đã đổi cả model lẫn thinking, mặc định mới đổi model: giữ của người dùng, báo xung đột.
  assert.match(frontmatter(f, 'worker'), /^model: anthropic\/claude-opus-5-5\nthinking: high$/mu);
  assert.deepEqual(plans[worker].conflicts.map(item => [item.path, item.current, item.next]), [[['model'], 'anthropic/claude-opus-5-5', 'openai-codex/gpt-6.2-sol']]);
  // reviewer chỉ sửa tools, researcher không sửa gì: nhận model mới.
  assert.match(frontmatter(f, 'reviewer'), /^model: openai-codex\/gpt-6\.2-astra\nthinking: high\ntools: "read, bash"$/mu);
  assert.match(frontmatter(f, 'researcher'), /^model: opencode-go\/glm-5\.4-flash\nthinking: max$/mu);
  assert.equal(readJson(f.file('settings.json')).defaultModel, 'claude-sonnet-5-5');
  assert.deepEqual([readJson(f.file('advisor.json')).executor, readJson(f.file('advisor.json')).advisor], ['anthropic/claude-sonnet-5-5', 'anthropic/claude-fable-5-1']);
  // Cài lại lần nữa với cùng mặc định: không file, base hay checksum nào cần ghi.
  const state = f.state();
  for (const {path: file, content} of buildConfiguration({...f.options, modelDefaults: next})) {
    if (!mergesConfig(file, f.options)) continue;
    const plan = planConfigFile({root: f.root, file, content, recorded: state.files[file]});
    assert.deepEqual([plan.content, plan.base, plan.recorded], [undefined, undefined, state.files[file]], file);
  }
});

test('chuyển đổi model-roles.json: ghi đè đang nằm trong file gốc được giữ ở lần cài này và các lần sau', t => {
  // Bản trước: installer sinh file gốc và base từ mặc định + ghi đè (reviewer, advisor dùng Fable; main xhigh) và ghi
  // checksum của base đó. Người dùng chưa sửa gì trong file gốc nên file gốc khớp checksum ("chưa sửa").
  const f = install(t);
  const old = withRoles({reviewer: {model: 'anthropic/claude-fable-5-1'}, advisor: {model: 'anthropic/claude-fable-5-1'}, main: {thinking: 'xhigh'}});
  const kinds = [['settings', 'settings.json'], ['advisor', 'advisor.json'], ...SUBAGENT_ROLES.map(role => [role, `agents/${role}.md`])];
  const state = f.state();
  for (const [kind, name] of kinds) {
    const file = f.file(name), baseFile = defaultsFile(f.root, file);
    let text = rebaseModels(kind, fs.readFileSync(baseFile, 'utf8'), old);
    // advisor.json của bản trước có executorEffort (thinking của phiên chính).
    if (kind === 'advisor') text = `${JSON.stringify({...JSON.parse(text), executorEffort: 'xhigh'}, null, 2)}\n`;
    for (const target of [file, baseFile]) writeAtomic(target, Buffer.from(text), 0o600);
    state.files[file] = sha256(text);
  }
  fs.writeFileSync(f.statePath, JSON.stringify(state));
  // Không chuyển đổi: file "chưa sửa" nhận nguyên mặc định mới, mất ghi đè.
  {
    const file = f.file('agents/reviewer.md');
    const content = buildConfiguration({...f.options, modelDefaults}).find(entry => entry.path === file).content;
    const plan = planConfigFile({root: f.root, file, content, recorded: f.state().files[file]});
    assert.match(plan.content, /^model: openai-codex\/gpt-6-astra$/mu);
  }
  // Chuyển đổi như installer: base về mặc định thuần (của bản trước), checksum theo base đó.
  const migrated = f.state();
  for (const [kind, name] of kinds) {
    const file = f.file(name), baseFile = defaultsFile(f.root, file);
    const base = rebaseModels(kind, fs.readFileSync(baseFile, 'utf8'), modelDefaults);
    writeAtomic(baseFile, Buffer.from(base), 0o600);
    migrated.files[file] = sha256(base);
  }
  fs.writeFileSync(f.statePath, JSON.stringify(migrated));
  const plans = reinstall(f);
  assert.match(frontmatter(f, 'reviewer'), /^model: anthropic\/claude-fable-5-1\nthinking: high$/mu);
  assert.match(frontmatter(f, 'worker'), /^model: openai-codex\/gpt-6\.1-sol\nthinking: max$/mu);
  const advisor = readJson(f.file('advisor.json'));
  assert.deepEqual([advisor.executor, advisor.advisor, advisor.executorEffort], ['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1', undefined]);
  const settings = readJson(f.file('settings.json'));
  assert.deepEqual([settings.defaultModel, settings.defaultThinkingLevel], ['claude-opus-5-5', 'xhigh']);
  assert.ok(settings.enabledModels.includes('anthropic/claude-fable-5-1'), 'model người dùng đã chọn vẫn trong Ctrl+P');
  assert.ok(Object.values(plans).every(plan => !plan.conflicts.length), 'không xung đột');
  // Lần cài sau: base là mặc định mới, ghi đè vẫn là giá trị người dùng đã chọn.
  reinstall(f);
  assert.match(frontmatter(f, 'reviewer'), /^model: anthropic\/claude-fable-5-1$/mu);
  assert.equal(readJson(f.file('advisor.json')).advisor, 'anthropic/claude-fable-5-1');
});

test('model phân loại đổi trong /permissions: cài lại giữ giá trị của người dùng; mặc định mới khác thì báo xung đột', t => {
  const f = install(t);
  const settingsFile = f.file('settings.json');
  saveClassifier(settingsFile, 'openai-codex/gpt-6-astra', 'medium');
  const plan = (edit = value => value) => {
    const entry = buildConfiguration({...f.options, modelDefaults}).find(item => item.path === settingsFile);
    const content = `${JSON.stringify(edit(JSON.parse(entry.content)), null, 2)}\n`;
    return planConfigFile({root: f.root, file: settingsFile, content, recorded: f.state().files[settingsFile]});
  };
  // Cùng mặc định: gộp ba chiều giữ giá trị đã đổi, không xung đột.
  const same = plan();
  assert.deepEqual(same.conflicts, []);
  const kept = JSON.parse(same.content ?? fs.readFileSync(settingsFile, 'utf8')).autoMode;
  assert.deepEqual([kept.model, kept.stage2Reasoning, kept.jev], ['openai-codex/gpt-6-astra', 'medium', {model: 'jev-1.13.0'}]);
  // Mặc định mới của installer đổi model phân loại: giữ của người dùng, báo xung đột kèm mặc định mới.
  const moved = plan(value => ({...value, autoMode: {...value.autoMode, model: 'anthropic/claude-opus-5-5'}}));
  assert.equal(JSON.parse(moved.content ?? fs.readFileSync(settingsFile, 'utf8')).autoMode.model, 'openai-codex/gpt-6-astra');
  assert.deepEqual(moved.conflicts.map(item => [item.path, item.current, item.next]), [[['autoMode', 'model'], 'openai-codex/gpt-6-astra', 'anthropic/claude-opus-5-5']]);
});
