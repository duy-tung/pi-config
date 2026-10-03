import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  ROLES, changedRoles, checkCatalog, copyConfig, driftedRoles, effectiveModelRoles, loadModelDefaults, nativeValues, parseModelRef,
  readModelRoles, resolveModelRoles, roleModel, setRoleModel, splitRole, withRole, withoutRoles, writeModelRoles,
} from '../runtime/model-roles.mjs';
import {claudeOnly} from './install-fixture.mjs';

const defaults = loadModelDefaults(fileURLToPath(new URL('../', import.meta.url)));
const table = roles => Object.fromEntries(ROLES.map(name => [name, `${roles[name].model} ${roles[name].thinking}`]));
const role = (model, thinking) => `---\nname: worker\ndescription: Viết code.\nmodel: ${model}\nthinking: ${thinking}\ntools: "read, bash"\n---\n\nPrompt của role.\n`;
const presetWarning = value => `bỏ qua "preset": ${value} (preset đã gỡ khỏi pi-config: mọi vai dùng mặc định, chỉ ghi đè trong roles có tác dụng); xoá khóa này khỏi model-roles.json để hết cảnh báo`;

test('mặc định đặt đủ model và thinking hợp lệ cho mọi vai; là bảng phân vai chuẩn', () => {
  assert.deepEqual(Object.keys(defaults), ROLES);
  // Kiểm như ghi đè trong roles: cùng dạng model, mức thinking và tên trường.
  assert.deepEqual(resolveModelRoles(defaults, {roles: defaults}).errors, []);
  assert.deepEqual(table(resolveModelRoles(defaults).roles), {
    main: 'anthropic/claude-opus-5-5 high', researcher: 'opencode-go/glm-5.3-flash max',
    worker: 'openai-codex/gpt-6.1-sol max', reviewer: 'openai-codex/gpt-6-astra high',
    advisor: 'openai-codex/gpt-6-astra high', autoMode: 'anthropic/claude-sonnet-5-5 low',
  });
  assert.ok(ROLES.every(name => Object.values(resolveModelRoles(defaults).roles[name].source).every(source => source === 'default')));
  // Ghi đè chỉ dùng Claude (docs/models.md): reviewer khác model với worker.
  const claude = resolveModelRoles(defaults, {roles: claudeOnly}).roles;
  assert.ok(ROLES.every(name => claude[name].model.startsWith('anthropic/')));
  assert.notEqual(claude.reviewer.model, claude.worker.model);
});

test('ghi đè theo vai và từng trường trên mặc định', () => {
  const resolved = resolveModelRoles(defaults, {
    roles: {worker: {thinking: 'high'}, researcher: {model: 'openai-codex/gpt-6.1-sol', thinking: 'low'}},
  });
  assert.deepEqual([resolved.errors, resolved.warnings], [[], []]);
  assert.deepEqual([resolved.roles.worker.model, resolved.roles.worker.thinking], ['openai-codex/gpt-6.1-sol', 'high']);
  assert.deepEqual(resolved.roles.worker.source, {model: 'default', thinking: 'override'});
  assert.deepEqual([resolved.roles.researcher.model, resolved.roles.researcher.thinking], ['openai-codex/gpt-6.1-sol', 'low']);
  assert.deepEqual([resolved.roles.reviewer.model, resolved.roles.reviewer.source.model], ['openai-codex/gpt-6-astra', 'default']);
});

test('khóa preset còn sót (preset đã gỡ): bỏ qua kèm một dòng cảnh báo, chỉ ghi đè trong roles có tác dụng', () => {
  // Preset claude cũ cùng một ghi đè researcher: mọi vai về mặc định, trừ ghi đè đó.
  const resolved = resolveModelRoles(defaults, {preset: 'claude', roles: {researcher: {model: 'anthropic/claude-sonnet-5-5'}}});
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.warnings, [presetWarning('"claude"')]);
  assert.deepEqual(resolved.roles, resolveModelRoles(defaults, {roles: {researcher: {model: 'anthropic/claude-sonnet-5-5'}}}).roles);
  assert.deepEqual(table(resolved.roles), {
    ...table(resolveModelRoles(defaults).roles), researcher: 'anthropic/claude-sonnet-5-5 max',
  });
  // Giá trị nào cũng chỉ là cảnh báo, kể cả tên không còn hay không phải chuỗi.
  for (const [value, shown] of [['default', '"default"'], ['__proto__', '"__proto__"'], [null, 'null'], [42, '42']]) {
    const other = resolveModelRoles(defaults, {preset: value});
    assert.deepEqual([other.errors, other.warnings], [[], [presetWarning(shown)]], shown);
  }
  // Cùng lúc với ghi đè của vai đã gỡ: mỗi loại một dòng.
  assert.equal(resolveModelRoles(defaults, {preset: 'claude', roles: {debugger: {thinking: 'low'}}}).warnings.length, 2);
});

test('cấu hình sai: báo từng lỗi, vẫn trả đủ vai theo mặc định', () => {
  const resolved = resolveModelRoles(defaults, {
    extra: true,
    roles: {worker: {model: 'opus', thinking: 'ultra', effort: 'high'}, coder: {}},
    presets: {mine: {extends: 'claude'}},
  });
  assert.deepEqual(resolved.errors, [
    'không có khóa "extra" (chỉ có roles)',
    'không có khóa "presets" (chỉ có roles)',
    'roles.worker.model phải có dạng "provider/id" (vd "anthropic/claude-opus-5-5"), đang là "opus"',
    'roles.worker.thinking phải là một trong off, minimal, low, medium, high, xhigh, max, đang là "ultra"',
    'roles.worker: không có khóa "effort" (chỉ có model, thinking)',
    'roles: không có vai "coder" (có main, researcher, worker, reviewer, advisor, autoMode)',
  ]);
  assert.equal(resolved.roles.worker.model, 'openai-codex/gpt-6.1-sol');
  assert.deepEqual(resolveModelRoles(defaults, []).errors, ['model-roles.json phải là một object JSON']);
  assert.deepEqual(resolved.warnings, []);
  assert.deepEqual(parseModelRef('openrouter/anthropic/claude-sonnet-5-5'), {provider: 'openrouter', id: 'anthropic/claude-sonnet-5-5'});
  for (const bad of ['opus', '/x', 'x/', 'a /b', 42]) assert.equal(parseModelRef(bad), undefined);
});

test('ghi đè còn sót của vai đã gỡ (auditor, oracle, debugger): bỏ qua kèm một dòng cảnh báo, cấu hình vẫn dùng được', () => {
  const resolved = resolveModelRoles(defaults, {roles: {auditor: {thinking: 'max'}, oracle: {model: 'x'}, debugger: {thinking: 'low'}, worker: {thinking: 'high'}}});
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.warnings, ['roles: bỏ qua auditor, oracle, debugger (vai đã gỡ khỏi pi-config); xoá khỏi model-roles.json để hết cảnh báo']);
  assert.deepEqual(Object.keys(resolved.roles), ROLES);
  assert.deepEqual(resolved.roles, resolveModelRoles(defaults, {roles: {worker: {thinking: 'high'}}}).roles);
});

test('giá trị cho từng file gốc: phiên chính, advisor luôn cùng model, danh sách model', () => {
  const values = nativeValues(resolveModelRoles(defaults).roles);
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
  const custom = nativeValues(resolveModelRoles(defaults, {roles: {...claudeOnly, main: {thinking: 'xhigh'}}}).roles);
  assert.deepEqual(Object.keys(custom), ['settings', 'autoMode', 'subagents', 'advisor']);
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
  const values = nativeValues(resolveModelRoles(defaults).roles);
  const write = (name, value) => fs.writeFileSync(path.join(agentDir, name), typeof value === 'string' ? value : JSON.stringify(value));
  fs.mkdirSync(path.join(agentDir, 'agents'));
  write('settings.json', {...values.settings, defaultModel: 'claude-sonnet-5-5', autoMode: values.autoMode});
  write('advisor.json', {...values.advisor, alwaysOn: true});
  for (const [name, value] of Object.entries(values.subagents)) write(`agents/${name}.md`, role(value.model, value.thinking));
  const roles = resolveModelRoles(defaults).roles;
  const effective = effectiveModelRoles(agentDir);
  // advisor alwaysOn: executor thắng settings.json (Sonnet trong settings không phải model thật của phiên).
  assert.deepEqual(effective.main, {model: 'anthropic/claude-opus-5-5', thinking: 'high', file: 'advisor.json'});
  assert.deepEqual(Object.keys(effective), ROLES);
  assert.deepEqual(driftedRoles(roles, effective), []);
  write('advisor.json', {...values.advisor, alwaysOn: false});
  write('agents/worker.md', role('anthropic/claude-opus-5-5', 'max'));
  assert.deepEqual(driftedRoles(roles, effectiveModelRoles(agentDir)), ['main', 'worker']);
  assert.deepEqual(readModelRoles(agentDir), {file: path.join(agentDir, 'model-roles.json'), exists: false, config: {roles: {}}});
  write('model-roles.json', '﻿{"roles": {}}');
  assert.deepEqual(readModelRoles(agentDir).config, {roles: {}});
  write('model-roles.json', '{"roles": ');
  assert.match(readModelRoles(agentDir).error, /model-roles\.json không phải JSON hợp lệ/u);
});

const root = process.env.PI_CONFIG_TEST_ROOT;
test('catalog của runtime: mặc định và ghi đè chỉ dùng Claude hợp lệ, model sai tên là lỗi, mức thinking bị hạ là ghi chú, không ghi file', {skip: !root}, async t => {
  const modules = path.join(root, 'runtimes', 'current', 'node_modules');
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-catalog-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  for (const [name, roles] of [['mặc định', {}], ['chỉ Claude', claudeOnly]]) {
    assert.deepEqual(await checkCatalog({modules, agentDir, roles: resolveModelRoles(defaults, {roles}).roles}), {errors: [], notes: [], loggedOut: []}, name);
  }
  const roles = resolveModelRoles(defaults, {roles: {reviewer: {model: 'openai-codex/gpt-6-astr'}, researcher: {thinking: 'medium'}}}).roles;
  assert.deepEqual(await checkCatalog({modules, agentDir, roles}), {
    errors: ['reviewer: không có model openai-codex/gpt-6-astr trong catalog của Pi; kiểm tên provider/id, hoặc khai báo model trong models.json'],
    notes: ['researcher: opencode-go/glm-5.3-flash không hỗ trợ thinking medium; Pi dùng high'],
    loggedOut: [],
  });
  // Model tự khai báo trong models.json của agent dir là hợp lệ.
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({providers: {local: {
    baseUrl: 'http://127.0.0.1:9', api: 'openai-completions', apiKey: 'unused', models: [{id: 'coder'}],
  }}}));
  const local = resolveModelRoles(defaults, {roles: {worker: {model: 'local/coder', thinking: 'off'}}}).roles;
  assert.deepEqual((await checkCatalog({modules, agentDir, roles: local})).errors, []);
  assert.deepEqual(fs.readdirSync(agentDir), ['models.json']);
});

test('thay đổi của /models: ghi đè, bỏ ghi đè, bỏ khóa preset cũ, không sửa object gốc; vai đổi giữa hai kết quả', t => {
  const config = {roles: {worker: {thinking: 'max'}}};
  assert.deepEqual(withRole(config, 'worker', {model: 'anthropic/claude-opus-5-5'}).roles, {worker: {thinking: 'max', model: 'anthropic/claude-opus-5-5'}});
  assert.deepEqual(withRole({preset: 'claude'}, 'main', {thinking: 'xhigh'}), {roles: {main: {thinking: 'xhigh'}}});
  assert.deepEqual(withoutRoles({preset: 'default', ...config}, ['worker', 'main']), {roles: {}});
  assert.deepEqual(copyConfig({preset: 'claude', roles: {debugger: {thinking: 'low'}}}), {roles: {debugger: {thinking: 'low'}}});
  assert.deepEqual(withRole('hỏng', 'main', {thinking: 'low'}), {roles: {main: {thinking: 'low'}}});
  assert.deepEqual(config, {roles: {worker: {thinking: 'max'}}});
  const before = resolveModelRoles(defaults).roles;
  assert.deepEqual(changedRoles(before, before), []);
  assert.deepEqual(changedRoles(before, resolveModelRoles(defaults, {roles: {worker: {thinking: 'high'}, main: {model: 'anthropic/claude-opus-5-5'}}}).roles), ['worker']);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-write-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  const file = path.join(agentDir, 'model-roles.json');
  writeModelRoles(file, {roles: {worker: {thinking: 'high'}}});
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "roles": {\n    "worker": {\n      "thinking": "high"\n    }\n  }\n}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(agentDir), ['model-roles.json']);
});
