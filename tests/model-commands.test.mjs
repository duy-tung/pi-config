import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildConfiguration} from '../lib/config.mjs';
import {mergesConfig} from '../lib/resources.mjs';
import {defaultsFile, planConfigFile} from '../runtime/merge.mjs';
import {ROLES, changedRoles, resolveModelRoles} from '../runtime/model-roles.mjs';
import {planModelFiles, runModels, whenApplied, writeModelFiles} from '../runtime/models.mjs';
import {claudeOnly, defaults, readJson, simulatedInstall as install, snapshot} from './install-fixture.mjs';
import {saveClassifier} from '../assets/extensions/pi-auto-mode/lib/config.ts';

test('áp ghi đè mới vào bản cài: giữ phần người dùng sửa, vai không đổi giữ giá trị đổi qua /model; cài lại sau đó không đổi gì', t => {
  const f = install(t);
  // Pi đổi theme, người dùng sửa tools của worker, /model lưu Sonnet vào executor của advisor.
  const settings = readJson(f.file('settings.json'));
  settings.theme = 'rose-pine-dawn';
  fs.writeFileSync(f.file('settings.json'), JSON.stringify(settings));
  const worker = f.file('agents/worker.md');
  fs.writeFileSync(worker, fs.readFileSync(worker, 'utf8').replace(/^tools: .*$/mu, 'tools: "read, bash"'));
  const advisor = readJson(f.file('advisor.json'));
  advisor.executor = 'anthropic/claude-sonnet-5-5';
  fs.writeFileSync(f.file('advisor.json'), JSON.stringify(advisor, null, 2));
  const before = resolveModelRoles(defaults).roles;
  const after = resolveModelRoles(defaults, {roles: claudeOnly}).roles;
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
  assert.deepEqual([advisorNow.executor, advisorNow.advisor], ['anthropic/claude-sonnet-5-5', 'anthropic/claude-fable-5-1']);
  assert.ok(fs.readdirSync(path.join(f.root, 'backups')).length, 'file bị ghi đè có backup');
  // Installer chạy lại với cùng cấu hình: không file, base hay checksum nào cần ghi.
  for (const {path: file, content} of buildConfiguration({...f.options, modelRoles: after})) {
    if (mergesConfig(file, f.options)) {
      const plan = planConfigFile({root: f.root, file, content, recorded: state.files[file]});
      assert.deepEqual([plan.content, plan.base, plan.recorded], [undefined, undefined, state.files[file]], file);
    }
  }
});

test('model phân loại đổi trong /permissions: cài lại giữ giá trị của người dùng, /models không ép; mặc định mới khác thì báo xung đột', t => {
  const f = install(t);
  const settingsFile = f.file('settings.json');
  saveClassifier(settingsFile, 'openai-codex/gpt-6-astra', 'medium');
  const classifier = () => {
    const {model, stage2Reasoning} = readJson(settingsFile).autoMode;
    return [model, stage2Reasoning];
  };
  const reinstall = (edit = value => value) => {
    const entry = buildConfiguration({...f.options, modelRoles: resolveModelRoles(defaults).roles}).find(item => item.path === settingsFile);
    const content = `${JSON.stringify(edit(JSON.parse(entry.content)), null, 2)}\n`;
    return planConfigFile({root: f.root, file: settingsFile, content, recorded: f.state().files[settingsFile]});
  };
  // Cùng mặc định: gộp ba chiều giữ giá trị đã đổi, không xung đột.
  const same = reinstall();
  assert.deepEqual(same.conflicts, []);
  const kept = JSON.parse(same.content ?? fs.readFileSync(settingsFile, 'utf8')).autoMode;
  assert.deepEqual([kept.model, kept.stage2Reasoning, kept.jev], ['openai-codex/gpt-6-astra', 'medium', {model: 'jev-1.13.0'}]);
  // /models ép mọi vai: autoMode không phải một vai nên giữ nguyên.
  const {plans} = planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles: resolveModelRoles(defaults, {roles: claudeOnly}).roles, force: ROLES});
  writeModelFiles({root: f.root, statePath: f.statePath, state: f.state(), plans});
  assert.deepEqual(classifier(), ['openai-codex/gpt-6-astra', 'medium']);
  // Mặc định mới của installer đổi model phân loại: giữ của người dùng, báo xung đột kèm mặc định mới.
  const moved = reinstall(value => ({...value, autoMode: {...value.autoMode, model: 'anthropic/claude-opus-5-5'}}));
  assert.equal(JSON.parse(moved.content ?? fs.readFileSync(settingsFile, 'utf8')).autoMode.model, 'openai-codex/gpt-6-astra');
  assert.deepEqual(moved.conflicts.map(item => [item.path, item.current, item.next]), [[['autoMode', 'model'], 'openai-codex/gpt-6-astra', 'anthropic/claude-opus-5-5']]);
});

test('ép mọi vai (apply --reset): giá trị đổi ngoài model-roles.json trở về cấu hình, phần khác vẫn giữ', t => {
  const f = install(t);
  const advisor = readJson(f.file('advisor.json'));
  Object.assign(advisor, {executor: 'anthropic/claude-sonnet-5-5', alwaysOn: true});
  fs.writeFileSync(f.file('advisor.json'), JSON.stringify(advisor));
  const roles = resolveModelRoles(defaults).roles;
  const {plans} = planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles, force: ROLES});
  writeModelFiles({root: f.root, statePath: f.statePath, state: f.state(), plans});
  assert.deepEqual([readJson(f.file('advisor.json')).executor, readJson(f.file('advisor.json')).alwaysOn], ['anthropic/claude-opus-5-5', true]);
});

test('thiếu base thì báo cần chạy lại installer', t => {
  const f = install(t);
  const roles = resolveModelRoles(defaults, {roles: claudeOnly}).roles;
  fs.rmSync(defaultsFile(f.root, f.file('agents/reviewer.md')));
  assert.deepEqual(planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles}).missing, [f.file('agents/reviewer.md')]);
});

// Catalog giả như catalog của phiên Pi: biết model mặc định và model Claude; logins: openai-codex chưa đăng nhập.
const KNOWN = new Set(['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-fable-5-1', 'openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6-astra', 'opencode-go/glm-5.3-flash']);
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
    [{frobnicate: true}, /không hiểu thay đổi/u],
    [{preset: 'claude'}, /không hiểu thay đổi/u],
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
  assert.deepEqual(whenApplied(['main', 'worker', 'reviewer', 'advisor']), [
    'Có hiệu lực: main ở phiên Pi mở sau; worker, reviewer ở lần gọi Agent kế tiếp; advisor ở lần hỏi advisor kế tiếp.',
  ]);
  assert.deepEqual(whenApplied(['main', 'worker'], {main: 'ngay'}), [
    'Có hiệu lực: main ngay; worker ở lần gọi Agent kế tiếp.',
  ]);
});

test('catalog và effects của phiên: kiểm model, xem trước, ghi đè, bảng và lệch, bỏ ghi đè, đưa vai lệch về cấu hình', async t => {
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
  const preview = await run({role: 'worker', model: 'anthropic/claude-sonnet-5-5'}, true);
  assert.equal(preview.status, 0, preview.text);
  assert.match(preview.text, /^worker: openai-codex\/gpt-6.1-sol \(max\) → anthropic\/claude-sonnet-5-5 \(max\)$/mu);
  assert.match(preview.text, /^Sẽ tạo .*model-roles\.json\.$/mu);
  assert.match(preview.text, /^Sẽ cập nhật: settings\.json, agents\/worker\.md$/mu);
  assert.match(preview.text, /^cảnh báo: provider openai-codex \(worker\) chưa đăng nhập: dùng \/login\.$/mu);
  assert.deepEqual([applied, snapshot(f.root, f.agentDir)], [[], before], 'lỗi và xem trước không ghi, không gọi effects');
  const set = await run({role: 'worker', model: 'anthropic/claude-sonnet-5-5'});
  assert.equal(set.status, 0, set.text);
  assert.deepEqual(applied, [['worker']]);
  assert.match(set.text, /\náp ngay: worker$/u);
  assert.deepEqual(readJson(f.file('model-roles.json')), {roles: {worker: {model: 'anthropic/claude-sonnet-5-5'}}});
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file('model-roles.json')).mode & 0o777, 0o600);
  // worker chỉ ghi đè model; thinking theo mặc định (max). Ghi đè thinking của worker và model của advisor.
  assert.equal((await run({role: 'worker', thinking: 'high'})).status, 0);
  const advisorSet = await run({role: 'advisor', model: 'anthropic/claude-fable-5-1'});
  assert.equal(advisorSet.status, 0, advisorSet.text);
  assert.match(advisorSet.text, /^advisor: openai-codex\/gpt-6-astra \(high\) → anthropic\/claude-fable-5-1 \(high\)$/mu);
  assert.deepEqual(applied.slice(1), [['worker'], ['advisor']]);
  {
    const advisor = readJson(f.file('advisor.json'));
    assert.deepEqual([advisor.advisorMaxCallsPerSession, advisor.advisorFallbackModel, advisor.advisorDisableSameModel, advisor.advisorAgentsMdContext],
      [5, 'anthropic/claude-opus-5-5', false, false], 'gate, số lượt, fallback và AGENTS.md của advisor không đổi theo model của advisor');
  }
  // Lệch qua /agents: bảng và cảnh báo chỉ tới /models.
  fs.writeFileSync(f.file('agents/reviewer.md'), fs.readFileSync(f.file('agents/reviewer.md'), 'utf8').replace('thinking: high', 'thinking: low'));
  const shown = await run();
  assert.equal(shown.status, 0, shown.text);
  assert.match(shown.text, /^mặc định \+ ghi đè \(.*model-roles\.json\)$/mu);
  assert.match(shown.text, /^ {2}worker: anthropic\/claude-sonnet-5-5 \(high\), ghi đè$/mu);
  assert.match(shown.text, /^ {2}reviewer: openai-codex\/gpt-6-astra \(low\) theo agents\/reviewer\.md; model-roles\.json: openai-codex\/gpt-6-astra \(high\)$/mu);
  assert.match(shown.text, /^cảnh báo: reviewer đang dùng openai-codex\/gpt-6-astra \(low\) theo agents\/reviewer\.md, khác model-roles\.json \(openai-codex\/gpt-6-astra \(high\)\)\. Trong \/models: /mu);
  // Bỏ ghi đè của worker: dùng lại mặc định.
  const reset = await run({reset: 'worker'});
  assert.equal(reset.status, 0, reset.text);
  assert.deepEqual(readJson(f.file('model-roles.json')), {roles: {advisor: {model: 'anthropic/claude-fable-5-1'}}});
  assert.match(fs.readFileSync(f.file('agents/worker.md'), 'utf8'), /^model: openai-codex\/gpt-6.1-sol\nthinking: max$/mu);
  // Đưa vai lệch về model-roles.json (apply --reset trước đây): ép mọi vai, báo giá trị bị thay.
  const apply = await run({apply: true});
  assert.equal(apply.status, 0, apply.text);
  assert.match(apply.text, /^model-roles\.json không đổi\.$/mu);
  assert.match(apply.text, /^Ghi đè giá trị đổi ngoài model-roles\.json: reviewer \(agents\/reviewer\.md: openai-codex\/gpt-6-astra \(low\)\)$/mu);
  assert.match(fs.readFileSync(f.file('agents/reviewer.md'), 'utf8'), /^model: openai-codex\/gpt-6-astra\nthinking: high$/mu);
  assert.deepEqual(applied.at(-1), ['reviewer']);
  assert.doesNotMatch((await run()).text, /đang dùng/u);
  // Mọi file gốc đã khớp: đưa về cấu hình không ghi gì.
  const synced = await run({apply: true});
  assert.equal(synced.status, 0, synced.text);
  assert.match(synced.text, /^model-roles\.json không đổi\.\nFile gốc đã khớp, không cần ghi\.$/mu);
});

test('/models: ghi đè còn sót của vai đã gỡ chỉ là cảnh báo; bảng và thay đổi vẫn chạy', async t => {
  const f = install(t);
  fs.writeFileSync(f.file('model-roles.json'), JSON.stringify({roles: {auditor: {thinking: 'max'}, oracle: {model: 'openai-codex/gpt-6-astra'}}}));
  const run = runner(f);
  const warning = /^cảnh báo: .*model-roles\.json: roles: bỏ qua auditor, oracle \(vai đã gỡ khỏi pi-config\); xoá khỏi model-roles\.json để hết cảnh báo$/mu;
  const shown = await run();
  assert.equal(shown.status, 0, shown.text);
  assert.match(shown.text, warning);
  assert.doesNotMatch(shown.text, /^ {2}(auditor|oracle):/mu);
  const set = await run({role: 'worker', thinking: 'high'});
  assert.equal(set.status, 0, set.text);
  assert.match(set.text, warning);
  assert.deepEqual(readJson(f.file('model-roles.json')).roles.worker, {thinking: 'high'});
});

test('/models: khóa preset còn sót chỉ là cảnh báo; lần ghi kế tiếp (kể cả đưa vai lệch về cấu hình) bỏ khóa này', async t => {
  const f = install(t);
  fs.writeFileSync(f.file('model-roles.json'), JSON.stringify({preset: 'claude', roles: {researcher: {model: 'anthropic/claude-sonnet-5-5'}}}));
  const run = runner(f);
  const warning = /^cảnh báo: .*model-roles\.json: bỏ qua "preset": "claude" \(preset đã gỡ khỏi pi-config: mọi vai dùng mặc định, chỉ ghi đè trong roles có tác dụng\); xoá khóa này khỏi model-roles\.json để hết cảnh báo$/mu;
  const shown = await run();
  assert.equal(shown.status, 0, shown.text);
  assert.match(shown.text, warning);
  // Mặc định cùng ghi đè researcher; các file gốc của bản cài giả theo mặc định nên researcher là vai lệch duy nhất.
  assert.match(shown.text, /^ {2}worker: openai-codex\/gpt-6\.1-sol \(max\)$/mu);
  assert.match(shown.text, /^ {2}researcher: opencode-go\/glm-5\.3-flash \(max\) theo agents\/researcher\.md; model-roles\.json: anthropic\/claude-sonnet-5-5 \(max\), ghi đè$/mu);
  const before = snapshot(f.root, f.agentDir);
  const preview = await run({apply: true}, true);
  assert.equal(preview.status, 0, preview.text);
  assert.match(preview.text, /^Sẽ bỏ khóa "preset" \(đã gỡ\) khỏi model-roles\.json\.$/mu);
  assert.deepEqual(snapshot(f.root, f.agentDir), before);
  const apply = await run({apply: true});
  assert.equal(apply.status, 0, apply.text);
  assert.deepEqual(readJson(f.file('model-roles.json')), {roles: {researcher: {model: 'anthropic/claude-sonnet-5-5'}}});
  assert.match(fs.readFileSync(f.file('agents/researcher.md'), 'utf8'), /^model: anthropic\/claude-sonnet-5-5\nthinking: max$/mu);
  const after = await run();
  assert.equal(after.status, 0, after.text);
  assert.doesNotMatch(after.text, /preset|đang dùng/u);
});
