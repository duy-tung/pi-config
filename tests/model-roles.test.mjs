import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  ROLES, changedRoles, checkCatalog, driftedRoles, effectiveModelRoles, loadPresets, nativeValues, parseModelRef,
  readModelRoles, resolveModelRoles, roleModel, setRoleModel, splitRole, withPreset, withRole, withoutRoles, writeModelRoles,
} from '../runtime/model-roles.mjs';

const presets = loadPresets(fileURLToPath(new URL('../assets/configs/model-presets.json', import.meta.url)));
const table = roles => Object.fromEntries(ROLES.map(name => [name, `${roles[name].model} ${roles[name].thinking}`]));
// Lỗi của bộ preset có sẵn: mỗi preset đặt đủ model và thinking hợp lệ cho mọi vai (kiểm như ghi đè trong roles).
const presetErrors = presets => Object.entries(presets).flatMap(([name, preset]) => [
  ...resolveModelRoles(presets, {preset: name, roles: preset.roles}).errors.map(error => `${name}: ${error}`),
  ...ROLES.flatMap(role => ['model', 'thinking'].filter(field => preset.roles?.[role]?.[field] === undefined).map(field => `${name}: vai ${role} thiếu ${field}`)),
]);
const role = (model, thinking) => `---\nname: worker\ndescription: Viết code.\nmodel: ${model}\nthinking: ${thinking}\ntools: "read, bash"\n---\n\nPrompt của role.\n`;

test('preset có sẵn đặt đủ model và thinking cho mọi vai; default là bảng phân vai chuẩn', () => {
  assert.deepEqual(presetErrors(presets), []);
  assert.deepEqual(Object.keys(presets), ['default', 'claude']);
  assert.deepEqual(table(resolveModelRoles(presets).roles), {
    main: 'anthropic/claude-opus-5-5 high', researcher: 'opencode-go/glm-5.3-flash max',
    worker: 'openai-codex/gpt-6.1-sol max', debugger: 'openai-codex/gpt-6.1-sol max', reviewer: 'openai-codex/gpt-6-astra high',
    advisor: 'openai-codex/gpt-6-astra high', auditor: 'openai-codex/gpt-6-astra high', oracle: 'openai-codex/gpt-6-astra high',
    autoMode: 'anthropic/claude-sonnet-5-5 low',
  });
  // Preset claude chỉ cần đăng nhập Claude; reviewer khác model với worker.
  const claude = resolveModelRoles(presets, {preset: 'claude'}).roles;
  assert.ok(ROLES.every(name => claude[name].model.startsWith('anthropic/')));
  assert.notEqual(claude.reviewer.model, claude.worker.model);
  // Preset thiếu model hoặc thinking của một vai là lỗi.
  const broken = structuredClone(presets);
  delete broken.claude.roles.advisor.thinking;
  assert.deepEqual(presetErrors(broken), ['claude: vai advisor thiếu thinking']);
});

test('ghi đè theo vai và từng trường trên preset có sẵn', () => {
  const resolved = resolveModelRoles(presets, {
    preset: 'claude', roles: {worker: {thinking: 'max'}, researcher: {model: 'openai-codex/gpt-6.1-sol', thinking: 'low'}},
  });
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.preset, 'claude');
  assert.deepEqual([resolved.roles.worker.model, resolved.roles.worker.thinking], ['anthropic/claude-opus-5-5', 'max']);
  assert.deepEqual(resolved.roles.worker.source, {model: 'preset', thinking: 'override'});
  assert.deepEqual([resolved.roles.researcher.model, resolved.roles.researcher.thinking], ['openai-codex/gpt-6.1-sol', 'low']);
  assert.deepEqual([resolved.roles.reviewer.model, resolved.roles.reviewer.source.model], ['anthropic/claude-fable-5-1', 'preset']);
});

test('cấu hình sai: báo từng lỗi, vẫn trả đủ vai theo preset mặc định', () => {
  const resolved = resolveModelRoles(presets, {
    preset: 'claud', extra: true,
    roles: {worker: {model: 'opus', thinking: 'ultra', effort: 'high'}, coder: {}},
    presets: {mine: {extends: 'claude'}},
  });
  assert.deepEqual(resolved.errors, [
    'không có khóa "extra" (chỉ có preset, roles)',
    'không có khóa "presets" (chỉ có preset, roles)',
    'roles.worker.model phải có dạng "provider/id" (vd "anthropic/claude-opus-5-5"), đang là "opus"',
    'roles.worker.thinking phải là một trong off, minimal, low, medium, high, xhigh, max, đang là "ultra"',
    'roles.worker: không có khóa "effort" (chỉ có model, thinking)',
    'roles: không có vai "coder" (có main, researcher, worker, debugger, reviewer, advisor, auditor, oracle, autoMode)',
    'preset "claud" không có (có default, claude)',
  ]);
  assert.equal(resolved.roles.worker.model, 'openai-codex/gpt-6.1-sol');
  assert.deepEqual(resolveModelRoles(presets, []).errors, ['model-roles.json phải là một object JSON']);
  // Tên preset như "__proto__" hay "toString" không phải preset có sẵn.
  for (const name of ['__proto__', 'toString']) {
    assert.deepEqual(resolveModelRoles(presets, {preset: name}).errors, [`preset "${name}" không có (có default, claude)`]);
  }
  assert.deepEqual(parseModelRef('openrouter/anthropic/claude-sonnet-5-5'), {provider: 'openrouter', id: 'anthropic/claude-sonnet-5-5'});
  for (const bad of ['opus', '/x', 'x/', 'a /b', 42]) assert.equal(parseModelRef(bad), undefined);
});

test('giá trị cho từng file gốc: phiên chính, advisor luôn cùng model, goal không nhận max, danh sách model', () => {
  const values = nativeValues(resolveModelRoles(presets).roles);
  assert.deepEqual(values.settings, {
    defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', defaultThinkingLevel: 'high',
    modelThinkingLevels: {
      'anthropic/claude-opus-5-5': 'high', 'openai-codex/gpt-6.1-sol': 'max', 'openai-codex/gpt-6-astra': 'high', 'opencode-go/glm-5.3-flash': 'max',
    },
    enabledModels: ['anthropic/claude-opus-5-5', 'openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6-astra', 'opencode-go/glm-5.3-flash'],
  });
  assert.deepEqual(values.autoMode, {model: 'anthropic/claude-sonnet-5-5', stage2Reasoning: 'low'});
  assert.deepEqual(values.advisor, {
    executor: 'anthropic/claude-opus-5-5', executorEffort: 'high', advisor: 'openai-codex/gpt-6-astra', advisorEffort: 'high',
  });
  const custom = nativeValues(resolveModelRoles(presets, {preset: 'claude', roles: {auditor: {thinking: 'max'}, main: {thinking: 'xhigh'}}}).roles);
  assert.deepEqual(custom.goal, {
    provider: 'anthropic', model: 'claude-sonnet-5-5', thinkingLevel: 'xhigh',
    oracle: {provider: 'anthropic', model: 'claude-fable-5-1', thinkingLevel: 'high'},
  });
  assert.deepEqual([custom.advisor.executor, custom.advisor.executorEffort], ['anthropic/claude-opus-5-5', 'xhigh']);
  // Model của auto mode không vào danh sách Ctrl+P; model dùng chung chỉ xuất hiện một lần, phiên chính đứng đầu.
  assert.deepEqual(custom.settings.enabledModels, ['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1', 'anthropic/claude-sonnet-5-5']);
  assert.equal(custom.settings.modelThinkingLevels['anthropic/claude-opus-5-5'], 'xhigh');
});

test('frontmatter của file role: đặt model/thinking, giữ phần còn lại, thêm khi thiếu, CRLF', () => {
  const text = role('openai-codex/gpt-6.1-sol', 'max');
  assert.equal(setRoleModel(text, {model: 'openai-codex/gpt-6.1-sol', thinking: 'max'}), text);
  assert.equal(setRoleModel(text, {model: 'anthropic/claude-opus-5-5', thinking: 'high'}), role('anthropic/claude-opus-5-5', 'high'));
  const bare = '---\nname: worker\ndescription: Viết code.\ntools: "read, bash"\n---\n\nPrompt của role.\n';
  assert.equal(setRoleModel(bare, {model: 'openai-codex/gpt-6.1-sol', thinking: 'max'}), text);
  assert.equal(setRoleModel(text.replaceAll('\n', '\r\n'), {model: 'openai-codex/gpt-6.1-sol', thinking: 'max'}), text);
  // Dòng đã có (kể cả do người dùng dời chỗ) được sửa tại chỗ; dòng còn thiếu thêm ngay sau dòng kia.
  const moved = '---\nname: worker\ntools: read\nmodel: openai-codex/gpt-6.1-sol\n---\nPrompt.\n';
  assert.equal(setRoleModel(moved, {model: 'anthropic/claude-opus-5-5', thinking: 'high'}),
    '---\nname: worker\ntools: read\nmodel: anthropic/claude-opus-5-5\nthinking: high\n---\nPrompt.\n');
  assert.deepEqual(roleModel(text), {model: 'openai-codex/gpt-6.1-sol', thinking: 'max'});
  assert.deepEqual(splitRole(text).fields, {name: 'worker', description: 'Viết code.', model: 'openai-codex/gpt-6.1-sol', thinking: 'max', tools: '"read, bash"'});
  for (const bad of ['Không có frontmatter', '---\nname: a\n  tiếp dòng\n---\n', '---\nname: a\nname: b\n---\n']) {
    assert.equal(splitRole(bad), undefined);
    assert.throws(() => setRoleModel(bad, {model: 'a/b', thinking: 'high'}), /frontmatter/u);
  }
});

test('giá trị đang có hiệu lực theo file gốc và vai bị lệch so với cấu hình', t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-roles-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  const values = nativeValues(resolveModelRoles(presets).roles);
  const write = (name, value) => fs.writeFileSync(path.join(agentDir, name), typeof value === 'string' ? value : JSON.stringify(value));
  fs.mkdirSync(path.join(agentDir, 'agents'));
  write('settings.json', {...values.settings, defaultModel: 'claude-sonnet-5-5', autoMode: values.autoMode});
  write('advisor.json', {...values.advisor, alwaysOn: true});
  // /goal-settings ghi thinking_level; goal không nhận max nên xhigh là đúng cấu hình max.
  write('pi-goal-x-settings.json', {provider: 'openai-codex', model: 'gpt-6-astra', thinking_level: 'high', oracle: values.goal.oracle});
  for (const [name, value] of Object.entries(values.subagents)) write(`agents/${name}.md`, role(value.model, value.thinking));
  const roles = resolveModelRoles(presets).roles;
  const effective = effectiveModelRoles(agentDir);
  // advisor alwaysOn: executor thắng settings.json (Sonnet trong settings không phải model thật của phiên).
  assert.deepEqual(effective.main, {model: 'anthropic/claude-opus-5-5', thinking: 'high', file: 'advisor.json'});
  assert.deepEqual(effective.auditor, {model: 'openai-codex/gpt-6-astra', thinking: 'high', file: 'pi-goal-x-settings.json'});
  assert.deepEqual(driftedRoles(roles, effective), []);
  write('advisor.json', {...values.advisor, alwaysOn: false});
  write('agents/worker.md', role('anthropic/claude-opus-5-5', 'max'));
  assert.deepEqual(driftedRoles(roles, effectiveModelRoles(agentDir)), ['main', 'worker']);
  const maxAuditor = resolveModelRoles(presets, {roles: {auditor: {thinking: 'max'}}}).roles;
  write('pi-goal-x-settings.json', {...values.goal, thinkingLevel: 'xhigh'});
  assert.ok(!driftedRoles(maxAuditor, effectiveModelRoles(agentDir)).includes('auditor'));
  assert.deepEqual(readModelRoles(agentDir), {file: path.join(agentDir, 'model-roles.json'), exists: false, config: {preset: 'default', roles: {}}});
  write('model-roles.json', '﻿{"preset": "claude"}');
  assert.deepEqual(readModelRoles(agentDir).config, {preset: 'claude'});
  write('model-roles.json', '{"preset": ');
  assert.match(readModelRoles(agentDir).error, /model-roles\.json không phải JSON hợp lệ/u);
});

const root = process.env.PI_CONFIG_TEST_ROOT;
test('catalog của runtime: mọi preset hợp lệ, model sai tên là lỗi, mức thinking bị hạ là ghi chú, không ghi file', {skip: !root}, async t => {
  const modules = path.join(root, 'runtimes', 'current', 'node_modules');
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-catalog-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  for (const name of Object.keys(presets)) {
    assert.deepEqual(await checkCatalog({modules, agentDir, roles: resolveModelRoles(presets, {preset: name}).roles}), {errors: [], notes: [], loggedOut: []}, name);
  }
  const roles = resolveModelRoles(presets, {roles: {reviewer: {model: 'openai-codex/gpt-6-astr'}, researcher: {thinking: 'medium'}, auditor: {thinking: 'max'}}}).roles;
  assert.deepEqual(await checkCatalog({modules, agentDir, roles}), {
    errors: ['reviewer: không có model openai-codex/gpt-6-astr trong catalog của Pi; kiểm tên provider/id, hoặc khai báo model trong models.json'],
    notes: ['researcher: opencode-go/glm-5.3-flash không hỗ trợ thinking medium; Pi dùng high'],
    loggedOut: [],
  });
  // Model tự khai báo trong models.json của agent dir là hợp lệ.
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({providers: {local: {
    baseUrl: 'http://127.0.0.1:9', api: 'openai-completions', apiKey: 'unused', models: [{id: 'coder'}],
  }}}));
  const local = resolveModelRoles(presets, {roles: {worker: {model: 'local/coder', thinking: 'off'}}}).roles;
  assert.deepEqual((await checkCatalog({modules, agentDir, roles: local})).errors, []);
  assert.deepEqual(fs.readdirSync(agentDir), ['models.json']);
});

test('thay đổi của /models: chọn preset, ghi đè, bỏ ghi đè, không sửa object gốc; vai đổi giữa hai kết quả', t => {
  const config = {roles: {worker: {thinking: 'max'}}};
  assert.deepEqual(withPreset(config, 'claude'), {preset: 'claude', roles: {worker: {thinking: 'max'}}});
  assert.deepEqual(withPreset({roles: {}, preset: 'default'}, 'claude'), {roles: {}, preset: 'claude'});
  assert.deepEqual(withRole(config, 'worker', {model: 'anthropic/claude-opus-5-5'}).roles, {worker: {thinking: 'max', model: 'anthropic/claude-opus-5-5'}});
  assert.deepEqual(withRole({preset: 'claude'}, 'main', {thinking: 'xhigh'}), {preset: 'claude', roles: {main: {thinking: 'xhigh'}}});
  assert.deepEqual(withoutRoles(config, ['worker', 'main']).roles, {});
  assert.deepEqual(withRole('hỏng', 'main', {thinking: 'low'}), {preset: 'default', roles: {main: {thinking: 'low'}}});
  assert.deepEqual(config, {roles: {worker: {thinking: 'max'}}});
  const before = resolveModelRoles(presets).roles;
  assert.deepEqual(changedRoles(before, before), []);
  assert.deepEqual(changedRoles(before, resolveModelRoles(presets, {roles: {worker: {thinking: 'high'}, main: {model: 'anthropic/claude-opus-5-5'}}}).roles), ['worker']);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-write-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  const file = path.join(agentDir, 'model-roles.json');
  writeModelRoles(file, {preset: 'claude', roles: {}});
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "preset": "claude",\n  "roles": {}\n}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(agentDir), ['model-roles.json']);
});
