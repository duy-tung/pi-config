import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildConfiguration} from '../lib/config.mjs';
import {mergesConfig} from '../lib/resources.mjs';
import {defaultsFile, planConfigFile} from '../runtime/merge.mjs';
import {ROLES, changedRoles, resolveModelRoles} from '../runtime/model-roles.mjs';
import {planModelFiles, runModels, whenApplied, writeModelFiles} from '../runtime/models.mjs';
import {presets, readJson, simulatedInstall as install, snapshot} from './install-fixture.mjs';

test('áp preset mới vào bản cài: giữ phần người dùng sửa, vai không đổi giữ giá trị đổi qua /model; cài lại sau đó không đổi gì', t => {
  const f = install(t);
  // Pi đổi theme, người dùng sửa tools của worker, /model lưu Sonnet vào executor của advisor.
  const settings = readJson(f.file('settings.json'));
  settings.theme = 'rose-pine-dawn';
  fs.writeFileSync(f.file('settings.json'), JSON.stringify(settings));
  const worker = f.file('agents/worker.md');
  fs.writeFileSync(worker, fs.readFileSync(worker, 'utf8').replace(/^tools: .*$/mu, 'tools: "read, bash"'));
  const advisor = readJson(f.file('advisor.json'));
  advisor.executor = 'anthropic/claude-sonnet-5';
  fs.writeFileSync(f.file('advisor.json'), JSON.stringify(advisor, null, 2));
  const before = resolveModelRoles(presets).roles;
  const after = resolveModelRoles(presets, {preset: 'claude'}).roles;
  const force = changedRoles(before, after);
  assert.ok(!force.includes('main'));
  const beforePlan = snapshot(f.root, f.agentDir);
  const {plans, missing} = planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles: after, force});
  assert.deepEqual(missing, []);
  assert.deepEqual(snapshot(f.root, f.agentDir), beforePlan, 'lập kế hoạch không ghi gì');
  const state = f.state();
  writeModelFiles({root: f.root, statePath: f.statePath, state, plans});
  assert.match(fs.readFileSync(worker, 'utf8'), /^model: anthropic\/claude-opus-5-5\nthinking: high\ntools: "read, bash"$/mu);
  assert.equal(readJson(f.file('settings.json')).theme, 'rose-pine-dawn');
  const advisorNow = readJson(f.file('advisor.json'));
  assert.deepEqual([advisorNow.executor, advisorNow.advisor], ['anthropic/claude-sonnet-5', 'anthropic/claude-fable-5-1']);
  assert.ok(fs.readdirSync(path.join(f.root, 'backups')).length, 'file bị ghi đè có backup');
  // Installer chạy lại với cùng cấu hình: không file, base hay checksum nào cần ghi.
  for (const {path: file, content} of buildConfiguration({...f.options, modelRoles: after})) {
    if (mergesConfig(file, f.options)) {
      const plan = planConfigFile({root: f.root, file, content, recorded: state.files[file]});
      assert.deepEqual([plan.content, plan.base, plan.recorded], [undefined, undefined, state.files[file]], file);
    }
  }
});

test('ép mọi vai (apply --reset): giá trị đổi ngoài model-roles.json trở về cấu hình, phần khác vẫn giữ', t => {
  const f = install(t);
  const advisor = readJson(f.file('advisor.json'));
  Object.assign(advisor, {executor: 'anthropic/claude-sonnet-5', alwaysOn: true});
  fs.writeFileSync(f.file('advisor.json'), JSON.stringify(advisor));
  const goal = readJson(f.file('pi-goal-x-settings.json'));
  Object.assign(goal, {thinking_level: 'low', maxAutonomousRuns: 3});
  delete goal.thinkingLevel;
  fs.writeFileSync(f.file('pi-goal-x-settings.json'), JSON.stringify(goal));
  const roles = resolveModelRoles(presets).roles;
  const {plans} = planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles, force: ROLES});
  writeModelFiles({root: f.root, statePath: f.statePath, state: f.state(), plans});
  assert.deepEqual([readJson(f.file('advisor.json')).executor, readJson(f.file('advisor.json')).alwaysOn], ['anthropic/claude-opus-5-5', true]);
  const goalNow = readJson(f.file('pi-goal-x-settings.json'));
  assert.deepEqual([goalNow.thinkingLevel, goalNow.thinking_level, goalNow.maxAutonomousRuns], ['high', undefined, 3]);
});

test('thiếu base thì báo cần chạy lại installer', t => {
  const f = install(t);
  const roles = resolveModelRoles(presets, {preset: 'claude'}).roles;
  fs.rmSync(defaultsFile(f.root, f.file('agents/reviewer.md')));
  assert.deepEqual(planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles}).missing, [f.file('agents/reviewer.md')]);
});

// Catalog giả như catalog của phiên Pi: biết model của mọi preset; logins: openai-codex chưa đăng nhập.
const KNOWN = new Set(['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-fable-5-1', 'openai-codex/gpt-6-sol', 'openai-codex/gpt-6-astra', 'opencode-go/glm-5.3-flash']);
const fakeCatalog = {
  check: async (roles, {logins = false} = {}) => ({
    errors: Object.entries(roles).filter(([, role]) => !KNOWN.has(role.model)).map(([name, role]) => `${name}: không có model ${role.model}`),
    notes: [], loggedOut: logins ? [{provider: 'openai-codex', roles: ['worker']}] : [],
  }),
};

/** runModels trên bản cài giả; trả {status, text}. */
function runner(f, {catalog = fakeCatalog, effects = whenApplied} = {}) {
  return async (change, dryRun = false) => {
    const lines = [];
    const out = {log: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line)};
    const status = await runModels({root: f.root, agentDir: f.agentDir, catalog, change, dryRun, out, effects});
    return {status, text: lines.join('\n')};
  };
}

test('/models: thay đổi sai và khóa của installer báo lỗi, không ghi gì', async t => {
  const f = install(t);
  const run = runner(f);
  const before = snapshot(f.root, f.agentDir);
  for (const [change, message] of [
    [{role: 'coder', thinking: 'high'}, /roles: không có vai "coder"/u],
    [{role: 'worker', thinking: 'ultra'}, /roles\.worker\.thinking phải là một trong/u],
    [{role: 'worker', model: 'opus'}, /roles\.worker\.model phải có dạng "provider\/id"/u],
    [{preset: 'mine'}, /preset "mine" không có \(có default, claude\)/u],
    [{frobnicate: true}, /không hiểu thay đổi/u],
  ]) {
    const result = await run(change);
    assert.equal(result.status, 1, JSON.stringify(change));
    assert.match(result.text, message, JSON.stringify(change));
  }
  const lock = path.join(f.root, '.install.lock');
  // Khóa của một tiến trình còn chạy (chính test này); khóa của tiến trình đã chết thì được gỡ (install-lock.test.mjs).
  fs.writeFileSync(lock, String(process.pid));
  const locked = await run({role: 'worker', thinking: 'high'});
  assert.equal(locked.status, 1);
  assert.match(locked.text, /Installer hoặc \/models khác đang chạy/u);
  assert.ok(fs.existsSync(lock), 'không xoá khóa của tiến trình khác');
  fs.rmSync(lock);
  assert.deepEqual(snapshot(f.root, f.agentDir), before);
});

test('whenApplied gom các vai theo thời điểm có hiệu lực; thời điểm riêng thay mặc định', () => {
  assert.deepEqual(whenApplied([]), []);
  assert.deepEqual(whenApplied(['main', 'worker', 'reviewer', 'advisor', 'autoMode']), [
    'Có hiệu lực: main, autoMode ở phiên Pi mở sau; worker, reviewer ở lần gọi Agent kế tiếp; advisor ở lần hỏi advisor kế tiếp.',
  ]);
  assert.deepEqual(whenApplied(['auditor', 'oracle', 'worker'], {auditor: 'ở phiên mới', oracle: 'ở phiên mới'}), [
    'Có hiệu lực: auditor, oracle ở phiên mới; worker ở lần gọi Agent kế tiếp.',
  ]);
});

test('catalog và effects của phiên: kiểm model, xem trước, ghi đè, preset, bảng và lệch, bỏ ghi đè, đưa vai lệch về cấu hình', async t => {
  // Bản cài giả không có runtime: mọi bước phải dùng catalog truyền vào.
  const f = install(t);
  const applied = [];
  const effects = async changed => {
    applied.push(changed);
    return [`áp ngay: ${changed.join(', ')}`];
  };
  const run = runner(f, {effects});
  const before = snapshot(f.root, f.agentDir);
  const wrong = await run({role: 'worker', model: 'anthropic/claude-sonnet-9'});
  assert.equal(wrong.status, 1);
  assert.match(wrong.text, /^\/models: Model không dùng được, chưa ghi gì:\n- worker: không có model anthropic\/claude-sonnet-9$/mu);
  const preview = await run({role: 'worker', model: 'anthropic/claude-sonnet-5'}, true);
  assert.equal(preview.status, 0, preview.text);
  assert.match(preview.text, /^worker: openai-codex\/gpt-6-sol \(max\) → anthropic\/claude-sonnet-5 \(max\)$/mu);
  assert.match(preview.text, /^Sẽ tạo .*model-roles\.json\.$/mu);
  assert.match(preview.text, /^Sẽ cập nhật: settings\.json, agents\/worker\.md$/mu);
  assert.match(preview.text, /^cảnh báo: provider openai-codex \(worker\) chưa đăng nhập: dùng \/login\.$/mu);
  assert.deepEqual([applied, snapshot(f.root, f.agentDir)], [[], before], 'lỗi và xem trước không ghi, không gọi effects');
  const set = await run({role: 'worker', model: 'anthropic/claude-sonnet-5'});
  assert.equal(set.status, 0, set.text);
  assert.deepEqual(applied, [['worker']]);
  assert.match(set.text, /\náp ngay: worker$/u);
  assert.deepEqual(readJson(f.file('model-roles.json')), {preset: 'default', roles: {worker: {model: 'anthropic/claude-sonnet-5'}}});
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file('model-roles.json')).mode & 0o777, 0o600);
  // Preset claude giữ main và autoMode; worker chỉ ghi đè model nên đổi thinking theo preset (max → high).
  const preset = await run({preset: 'claude'});
  assert.equal(preset.status, 0, preset.text);
  assert.match(preset.text, /^preset: default → claude$/mu);
  assert.deepEqual(applied[1], ['researcher', 'worker', 'debugger', 'reviewer', 'advisor', 'auditor', 'oracle']);
  assert.equal(readJson(f.file('advisor.json')).advisorMaxCallsPerSession, 5, 'gate và số lượt của advisor không đổi theo preset');
  // Lệch qua /agents: bảng và cảnh báo chỉ tới /models.
  fs.writeFileSync(f.file('agents/reviewer.md'), fs.readFileSync(f.file('agents/reviewer.md'), 'utf8').replace('thinking: high', 'thinking: low'));
  const shown = await run();
  assert.equal(shown.status, 0, shown.text);
  assert.match(shown.text, /^preset claude \(/u);
  assert.match(shown.text, /^ {2}worker: anthropic\/claude-sonnet-5 \(high\), ghi đè$/mu);
  assert.match(shown.text, /^cảnh báo: reviewer đang dùng anthropic\/claude-fable-5-1 \(low\) theo agents\/reviewer\.md, khác model-roles\.json \(anthropic\/claude-fable-5-1 \(high\)\)\. Trong \/models: /mu);
  // Bỏ ghi đè của worker: dùng lại preset.
  const reset = await run({reset: 'worker'});
  assert.equal(reset.status, 0, reset.text);
  assert.deepEqual(readJson(f.file('model-roles.json')), {preset: 'claude', roles: {}});
  assert.match(fs.readFileSync(f.file('agents/worker.md'), 'utf8'), /^model: anthropic\/claude-opus-5-5\nthinking: high$/mu);
  // Đưa vai lệch về model-roles.json (apply --reset trước đây): ép mọi vai, báo giá trị bị thay.
  const apply = await run({apply: true});
  assert.equal(apply.status, 0, apply.text);
  assert.match(apply.text, /^model-roles\.json không đổi\.$/mu);
  assert.match(apply.text, /^Ghi đè giá trị đổi ngoài model-roles\.json: reviewer \(agents\/reviewer\.md: anthropic\/claude-fable-5-1 \(low\)\)$/mu);
  assert.match(fs.readFileSync(f.file('agents/reviewer.md'), 'utf8'), /^thinking: high$/mu);
  assert.deepEqual(applied.at(-1), ['reviewer']);
  assert.doesNotMatch((await run()).text, /đang dùng/u);
  // Mọi file gốc đã khớp: đưa về cấu hình không ghi gì.
  const synced = await run({apply: true});
  assert.equal(synced.status, 0, synced.text);
  assert.match(synced.text, /^model-roles\.json không đổi\.\nFile gốc đã khớp, không cần ghi\.$/mu);
});
