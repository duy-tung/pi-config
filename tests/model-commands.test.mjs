import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildConfiguration} from '../lib/config.mjs';
import {mergesConfig} from '../lib/resources.mjs';
import {defaultsFile, planConfigFile, reconcileConfigFile} from '../runtime/merge.mjs';
import {ROLES, changedRoles, loadPresets, resolveModelRoles} from '../runtime/model-roles.mjs';
import {planModelFiles, runModels, writeModelFiles} from '../runtime/models.mjs';

const repoDir = fileURLToPath(new URL('../', import.meta.url));
const presets = loadPresets(path.join(repoDir, 'assets', 'configs', 'model-presets.json'));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Bản cài giả: file cấu hình, base và checksum như installer ghi, cùng bản mẫu AGENTS.md và preset trong <root>/assets. */
function install(t, roles = resolveModelRoles(presets).roles) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-commands-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const root = path.join(temp, 'root'), agentDir = path.join(temp, 'agent');
  const options = {root, agentDir, binDir: path.join(temp, 'bin'), nodePath: process.execPath, home: temp, repoDir};
  const state = {files: {}};
  const reinstall = modelRoles => {
    for (const {path: file, content} of buildConfiguration({...options, modelRoles})) {
      if (mergesConfig(file, {root, agentDir})) {
        state.files[file] = reconcileConfigFile({root, file, content, recorded: state.files[file]}).recorded;
      } else {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, content);
        state.files[file] = sha256(content);
      }
    }
    for (const name of ['AGENTS.md', path.join('configs', 'model-presets.json')]) {
      const copy = path.join(root, 'assets', name);
      fs.mkdirSync(path.dirname(copy), {recursive: true});
      fs.copyFileSync(path.join(repoDir, 'assets', name), copy);
      state.files[copy] = sha256(fs.readFileSync(copy));
    }
    fs.writeFileSync(path.join(root, 'install-state.json'), JSON.stringify(state));
  };
  reinstall(roles);
  const statePath = path.join(root, 'install-state.json');
  return {root, agentDir, options, statePath, state: () => readJson(statePath), file: name => path.join(agentDir, name)};
}

function snapshot(...dirs) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes: true}) : []) {
      const file = path.join(dir, entry.name);
      // Runtime của bản cài thật được nối vào bằng symlink/junction: không thuộc phần được so.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file); else files[file] = sha256(fs.readFileSync(file));
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

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
  assert.match(fs.readFileSync(f.file('AGENTS.md'), 'utf8'), /reviewer dùng claude-fable-5-1\/high/u);
  assert.ok(fs.readdirSync(path.join(f.root, 'backups')).length, 'file bị ghi đè có backup');
  // Installer chạy lại với cùng cấu hình: không file, base hay checksum nào cần ghi.
  for (const {path: file, content} of buildConfiguration({...f.options, modelRoles: after})) {
    if (mergesConfig(file, f.options)) {
      const plan = planConfigFile({root: f.root, file, content, recorded: state.files[file]});
      assert.deepEqual([plan.content, plan.base, plan.recorded], [undefined, undefined, state.files[file]], file);
    } else if (path.basename(file) === 'AGENTS.md') {
      assert.equal(fs.readFileSync(file, 'utf8'), content);
      assert.equal(state.files[file], sha256(content));
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

test('AGENTS.md hay bản mẫu đã sửa thì giữ; thiếu base thì báo cần chạy lại installer', t => {
  const f = install(t);
  fs.appendFileSync(f.file('AGENTS.md'), '\nGhi chú của tôi.\n');
  const roles = resolveModelRoles(presets, {preset: 'claude'}).roles;
  let {plans} = planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles});
  assert.equal(plans.find(plan => plan.file === f.file('AGENTS.md')).preserved, 'edited');
  fs.appendFileSync(path.join(f.root, 'assets', 'AGENTS.md'), 'sửa\n');
  ({plans} = planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles}));
  assert.equal(plans.find(plan => plan.file === f.file('AGENTS.md')).preserved, 'template');
  fs.rmSync(defaultsFile(f.root, f.file('agents/reviewer.md')));
  assert.deepEqual(planModelFiles({root: f.root, agentDir: f.agentDir, state: f.state(), roles}).missing, [f.file('agents/reviewer.md')]);
});

test('pi-models: tham số sai và khóa của installer báo lỗi, không ghi gì', async t => {
  const f = install(t);
  const profiles = {main: {agentDir: f.agentDir, runtime: 'current'}};
  const run = async (...args) => {
    const lines = [];
    const out = {log: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line)};
    return {status: await runModels({root: f.root, profiles, args, out}), text: lines.join('\n')};
  };
  const before = snapshot(f.root, f.agentDir);
  for (const [args, message] of [
    [['frobnicate'], /không có lệnh "frobnicate"/u],
    [['set'], /pi-models set <vai>/u],
    [['set', 'coder', 'high'], /không có vai "coder"/u],
    [['set', 'worker'], /thiếu giá trị/u],
    [['set', 'worker', 'ultra'], /"ultra" không phải model dạng provider\/id hay mức thinking/u],
    [['set', 'worker', 'high', 'max'], /chỉ nêu một thinking/u],
    [['reset'], /pi-models reset <vai>\.\.\. hoặc pi-models reset --all/u],
    [['reset', 'worker', '--all'], /pi-models reset <vai>\.\.\. hoặc pi-models reset --all/u],
    [['preset'], /pi-models preset <tên>/u],
    [['apply', '--all'], /pi-models apply không nhận --all/u],
    [['list', '--dry-run'], /pi-models list không nhận --dry-run/u],
  ]) {
    const result = await run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.text, message, args.join(' '));
  }
  assert.match((await run('help')).text, /pi-models set <vai> \[provider\/id\] \[thinking\]/u);
  const lock = path.join(f.root, '.install.lock');
  fs.writeFileSync(lock, '1');
  const locked = await run('set', 'worker', 'high');
  assert.equal(locked.status, 1);
  assert.match(locked.text, /Installer hoặc pi-models khác đang chạy/u);
  assert.ok(fs.existsSync(lock), 'không xoá khóa của tiến trình khác');
  fs.rmSync(lock);
  assert.deepEqual(snapshot(f.root, f.agentDir), before);
});

const testRoot = process.env.PI_CONFIG_TEST_ROOT;
test('pi-models trên runtime thật: xem trước, preset, model sai tên, lệch rồi adopt, reset, set, apply, list', {skip: !testRoot}, async t => {
  const f = install(t);
  fs.mkdirSync(path.join(f.root, 'runtimes'));
  // Nối runtime của bản cài thật (không chép); gỡ liên kết trước khi xoá thư mục tạm để không đụng tới runtime đó.
  const link = path.join(f.root, 'runtimes', 'current');
  fs.symlinkSync(path.join(testRoot, 'runtimes', 'current'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await commands(f);
  } finally {
    fs.unlinkSync(link);
  }
});

async function commands(f) {
  const profiles = {main: {agentDir: f.agentDir, runtime: 'current'}};
  const run = async (...args) => {
    const lines = [];
    const out = {log: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line)};
    return {status: await runModels({root: f.root, profiles, args, out}), text: lines.join('\n')};
  };
  const modelRoles = f.file('model-roles.json');
  const frontmatter = role => fs.readFileSync(f.file(`agents/${role}.md`), 'utf8').split('\n---\n')[0];
  const before = snapshot(f.root, f.agentDir);
  const preview = await run('preset', 'claude', '--dry-run');
  assert.equal(preview.status, 0, preview.text);
  assert.match(preview.text, /Xem trước \(--dry-run\)/u);
  assert.match(preview.text, /preset: default → claude/u);
  assert.match(preview.text, /worker: openai-codex\/gpt-6-sol \(max\) → anthropic\/claude-opus-5-5 \(high\)/u);
  assert.match(preview.text, /Sẽ cập nhật: settings\.json, advisor\.json, pi-goal-x-settings\.json, agents\/researcher\.md, agents\/worker\.md, agents\/debugger\.md, agents\/reviewer\.md, AGENTS\.md/u);
  // Bản cài giả không có auth.json: provider của mọi vai chưa đăng nhập.
  assert.match(preview.text, /provider anthropic \(main, researcher, worker, debugger, reviewer, advisor, auditor, oracle, autoMode\) chưa đăng nhập: chạy pi-login rồi \/login/u);
  assert.deepEqual(snapshot(f.root, f.agentDir), before);
  const switched = await run('preset', 'claude');
  assert.equal(switched.status, 0, switched.text);
  assert.deepEqual(readJson(modelRoles), {preset: 'claude', roles: {}});
  assert.match(frontmatter('worker'), /^model: anthropic\/claude-opus-5-5\nthinking: high$/mu);
  assert.match(switched.text, /Vai của pi-subagents dùng model mới ở lần gọi Agent kế tiếp/u);
  assert.equal(fs.existsSync(path.join(f.root, '.install.lock')), false);
  // Model sai tên: dừng trước khi ghi.
  const unchanged = snapshot(f.root, f.agentDir);
  const wrong = await run('set', 'worker', 'anthropic/claude-opus-5-6');
  assert.equal(wrong.status, 1);
  assert.match(wrong.text, /worker: không có model anthropic\/claude-opus-5-6 trong catalog của Pi/u);
  assert.deepEqual(snapshot(f.root, f.agentDir), unchanged);
  // /model lưu Sonnet vào executor của advisor: pi-models báo lệch, adopt ghi vào model-roles.json.
  const advisor = readJson(f.file('advisor.json'));
  advisor.executor = 'anthropic/claude-sonnet-5';
  fs.writeFileSync(f.file('advisor.json'), JSON.stringify(advisor, null, 2));
  const drifted = await run();
  assert.equal(drifted.status, 0, drifted.text);
  assert.match(drifted.text, /main đang dùng anthropic\/claude-sonnet-5 \(high\) theo advisor\.json, khác model-roles\.json \(anthropic\/claude-opus-5-5 \(high\)\)\. Giữ giá trị này: pi-models adopt main/u);
  const adopted = await run('adopt');
  assert.equal(adopted.status, 0, adopted.text);
  assert.match(adopted.text, /Ghi vào model-roles\.json: main anthropic\/claude-sonnet-5/u);
  assert.deepEqual(readJson(modelRoles), {preset: 'claude', roles: {main: {model: 'anthropic/claude-sonnet-5'}}});
  assert.equal(readJson(f.file('settings.json')).defaultModel, 'claude-sonnet-5');
  assert.doesNotMatch((await run()).text, /đang dùng/u);
  assert.match((await run('adopt')).text, /Không vai nào lệch với model-roles\.json\./u);
  // reset: vai dùng lại preset, ép cả giá trị trong file gốc.
  const reset = await run('reset', 'main');
  assert.equal(reset.status, 0, reset.text);
  assert.deepEqual(readJson(modelRoles).roles, {});
  assert.equal(readJson(f.file('advisor.json')).executor, 'anthropic/claude-opus-5-5');
  const set = await run('set', 'worker', 'openai-codex/gpt-6-sol', 'max');
  assert.equal(set.status, 0, set.text);
  assert.match(set.text, /worker: anthropic\/claude-opus-5-5 \(high\) → openai-codex\/gpt-6-sol \(max\)/u);
  assert.match(frontmatter('worker'), /^model: openai-codex\/gpt-6-sol\nthinking: max$/mu);
  assert.doesNotMatch(set.text, /Ghi đè giá trị đổi ngoài/u);
  // /agents đổi model của worker; set ép vai vừa nêu và báo giá trị bị thay.
  fs.writeFileSync(f.file('agents/worker.md'), fs.readFileSync(f.file('agents/worker.md'), 'utf8').replace('model: openai-codex/gpt-6-sol', 'model: anthropic/claude-sonnet-5'));
  const forced = await run('set', 'worker', 'high');
  assert.equal(forced.status, 0, forced.text);
  assert.match(forced.text, /Ghi đè giá trị đổi ngoài model-roles\.json: worker \(agents\/worker\.md: anthropic\/claude-sonnet-5 \(max\)\)/u);
  assert.match(frontmatter('worker'), /^model: openai-codex\/gpt-6-sol\nthinking: high$/mu);
  assert.deepEqual(readJson(modelRoles).roles, {worker: {model: 'openai-codex/gpt-6-sol', thinking: 'high'}});
  const apply = await run('apply');
  assert.equal(apply.status, 0, apply.text);
  assert.match(apply.text, /model-roles\.json không đổi\.\nFile gốc đã khớp, không cần ghi\./u);
  const list = await run('list', 'anthropic');
  assert.equal(list.status, 0, list.text);
  assert.match(list.text, /^anthropic \(Anthropic\): chưa đăng nhập$/mu);
  assert.match(list.text, /^ {2}anthropic\/claude-opus-5-5 {2}thinking: low, medium, high, xhigh, max {2}← main, debugger$/mu);
  assert.equal(fs.existsSync(f.file('auth.json')), false);
}
