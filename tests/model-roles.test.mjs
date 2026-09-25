import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  ROLES, checkCatalog, driftedRoles, effectiveModelRoles, fillRoleNames, legacyOverrides, loadPresets, nativeValues, parseModelRef, presetErrors,
  readModelRoles, resolveModelRoles, roleModel, setRoleModel, splitRole,
} from '../runtime/model-roles.mjs';

const presets = loadPresets(fileURLToPath(new URL('../assets/configs/model-presets.json', import.meta.url)));
const table = roles => Object.fromEntries(ROLES.map(name => [name, `${roles[name].model} ${roles[name].thinking}`]));
const role = (model, thinking) => `---\nname: worker\ndescription: Viết code.\nmodel: ${model}\nthinking: ${thinking}\ntools: "read, bash"\n---\n\nPrompt của role.\n`;

test('preset có sẵn đặt đủ model và thinking cho mọi vai; default là bảng phân vai chuẩn', () => {
  assert.deepEqual(presetErrors(presets), []);
  assert.deepEqual(Object.keys(presets), ['default', 'claude']);
  assert.deepEqual(table(resolveModelRoles(presets).roles), {
    main: 'anthropic/claude-opus-5-5 high', researcher: 'opencode-go/glm-5.3-flash max',
    worker: 'openai-codex/gpt-6-sol max', debugger: 'openai-codex/gpt-6-sol max', reviewer: 'openai-codex/gpt-6-astra high',
    advisor: 'openai-codex/gpt-6-astra high', auditor: 'openai-codex/gpt-6-astra high', oracle: 'openai-codex/gpt-6-astra high',
    autoMode: 'anthropic/claude-sonnet-5 low',
  });
  // Preset claude chỉ cần đăng nhập Claude; reviewer khác model với worker.
  const claude = resolveModelRoles(presets, {preset: 'claude'}).roles;
  assert.ok(ROLES.every(name => claude[name].model.startsWith('anthropic/')));
  assert.notEqual(claude.reviewer.model, claude.worker.model);
});

test('ghi đè theo vai và từng trường; preset riêng kế thừa preset có sẵn', () => {
  const resolved = resolveModelRoles(presets, {
    preset: 'mine',
    presets: {mine: {description: 'Claude, worker rẻ hơn', extends: 'claude', roles: {worker: {model: 'anthropic/claude-sonnet-5'}}}},
    roles: {worker: {thinking: 'max'}, researcher: {model: 'openai-codex/gpt-6-sol', thinking: 'low'}},
  });
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.preset, 'mine');
  assert.deepEqual([resolved.roles.worker.model, resolved.roles.worker.thinking], ['anthropic/claude-sonnet-5', 'max']);
  assert.deepEqual(resolved.roles.worker.source, {model: 'preset', thinking: 'override'});
  assert.deepEqual([resolved.roles.researcher.model, resolved.roles.researcher.thinking], ['openai-codex/gpt-6-sol', 'low']);
  assert.deepEqual([resolved.roles.reviewer.model, resolved.roles.reviewer.source.model], ['anthropic/claude-fable-5-1', 'preset']);
});

test('cấu hình sai: báo từng lỗi, vẫn trả đủ vai theo preset mặc định', () => {
  const resolved = resolveModelRoles(presets, {
    preset: 'claud', extra: true,
    roles: {worker: {model: 'opus', thinking: 'ultra', effort: 'high'}, coder: {}},
    presets: {claude: {}, mine: {extends: 'nope'}, other: 'x'},
  });
  assert.deepEqual(resolved.errors, [
    'không có khóa "extra" (chỉ có preset, roles, presets)',
    'presets.claude: trùng tên preset có sẵn, hãy đặt tên khác',
    'presets.mine.extends phải là preset có sẵn (default, claude), đang là "nope"',
    'presets.other phải là object dạng {"extends": "claude", "roles": {...}}',
    'roles.worker.model phải có dạng "provider/id" (vd "anthropic/claude-opus-5-5"), đang là "opus"',
    'roles.worker.thinking phải là một trong off, minimal, low, medium, high, xhigh, max, đang là "ultra"',
    'roles.worker: không có khóa "effort" (chỉ có model, thinking)',
    'roles: không có vai "coder" (có main, researcher, worker, debugger, reviewer, advisor, auditor, oracle, autoMode)',
    'preset "claud" không có (có default, claude)',
  ]);
  assert.equal(resolved.roles.worker.model, 'openai-codex/gpt-6-sol');
  assert.deepEqual(resolveModelRoles(presets, []).errors, ['model-roles.json phải là một object JSON']);
  // Khóa "__proto__" trong JSON là một tên preset bình thường, không đổi prototype.
  const proto = resolveModelRoles(presets, JSON.parse('{"preset": "__proto__", "presets": {"__proto__": {"roles": {"worker": {"thinking": "low"}}}}}'));
  assert.deepEqual([proto.errors, proto.roles.worker.thinking], [[], 'low']);
  assert.equal({}.roles, undefined);
  assert.deepEqual(parseModelRef('openrouter/anthropic/claude-sonnet-5'), {provider: 'openrouter', id: 'anthropic/claude-sonnet-5'});
  for (const bad of ['opus', '/x', 'x/', 'a /b', 42]) assert.equal(parseModelRef(bad), undefined);
});

test('giá trị cho từng file gốc: phiên chính, advisor luôn cùng model, goal không nhận max, danh sách model', () => {
  const values = nativeValues(resolveModelRoles(presets).roles);
  assert.deepEqual(values.settings, {
    defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', defaultThinkingLevel: 'high',
    modelThinkingLevels: {
      'anthropic/claude-opus-5-5': 'high', 'openai-codex/gpt-6-sol': 'max', 'openai-codex/gpt-6-astra': 'high', 'opencode-go/glm-5.3-flash': 'max',
    },
    enabledModels: ['anthropic/claude-opus-5-5', 'openai-codex/gpt-6-sol', 'openai-codex/gpt-6-astra', 'opencode-go/glm-5.3-flash'],
  });
  assert.deepEqual(values.autoMode, {model: 'anthropic/claude-sonnet-5', stage2Reasoning: 'low'});
  assert.deepEqual(values.advisor, {
    executor: 'anthropic/claude-opus-5-5', executorEffort: 'high', advisor: 'openai-codex/gpt-6-astra', advisorEffort: 'high',
  });
  const custom = nativeValues(resolveModelRoles(presets, {preset: 'claude', roles: {auditor: {thinking: 'max'}, main: {thinking: 'xhigh'}}}).roles);
  assert.deepEqual(custom.goal, {
    provider: 'anthropic', model: 'claude-sonnet-5', thinkingLevel: 'xhigh',
    oracle: {provider: 'anthropic', model: 'claude-fable-5-1', thinkingLevel: 'high'},
  });
  assert.deepEqual([custom.advisor.executor, custom.advisor.executorEffort], ['anthropic/claude-opus-5-5', 'xhigh']);
  // Model của auto mode không vào danh sách Ctrl+P; model dùng chung chỉ xuất hiện một lần, phiên chính đứng đầu.
  assert.deepEqual(custom.settings.enabledModels, ['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1', 'anthropic/claude-sonnet-5']);
  assert.equal(custom.settings.modelThinkingLevels['anthropic/claude-opus-5-5'], 'xhigh');
});

test('frontmatter của file role: đặt model/thinking, giữ phần còn lại, thêm khi thiếu, CRLF', () => {
  const text = role('openai-codex/gpt-6-sol', 'max');
  assert.equal(setRoleModel(text, {model: 'openai-codex/gpt-6-sol', thinking: 'max'}), text);
  assert.equal(setRoleModel(text, {model: 'anthropic/claude-opus-5-5', thinking: 'high'}), role('anthropic/claude-opus-5-5', 'high'));
  const bare = '---\nname: worker\ndescription: Viết code.\ntools: "read, bash"\n---\n\nPrompt của role.\n';
  assert.equal(setRoleModel(bare, {model: 'openai-codex/gpt-6-sol', thinking: 'max'}), text);
  assert.equal(setRoleModel(text.replaceAll('\n', '\r\n'), {model: 'openai-codex/gpt-6-sol', thinking: 'max'}), text);
  assert.deepEqual(roleModel(text), {model: 'openai-codex/gpt-6-sol', thinking: 'max'});
  assert.deepEqual(splitRole(text).fields, {name: 'worker', description: 'Viết code.', model: 'openai-codex/gpt-6-sol', thinking: 'max', tools: '"read, bash"'});
  for (const bad of ['Không có frontmatter', '---\nname: a\n  tiếp dòng\n---\n', '---\nname: a\nname: b\n---\n']) {
    assert.equal(splitRole(bad), undefined);
    assert.throws(() => setRoleModel(bad, {model: 'a/b', thinking: 'high'}), /frontmatter/u);
  }
});

test('điền model/thinking của vai vào hướng dẫn cho parent; tên vai lạ là lỗi', () => {
  const {roles} = resolveModelRoles(presets);
  assert.equal(fillRoleNames('Parent {{main}}; reviewer {{reviewer}}.', roles), 'Parent claude-opus-5-5/high; reviewer gpt-6-astra/high.');
  assert.throws(() => fillRoleNames('{{coder}}', roles), /Không có vai coder/u);
});

test('bản cài cũ: model/thinking đã sửa trong file role thành ghi đè, giá trị như mặc định thì bỏ qua', () => {
  assert.deepEqual(legacyOverrides(presets, {
    worker: role('anthropic/claude-opus-5-5', 'max'),
    debugger: role('openai-codex/gpt-6-sol', 'high'),
    reviewer: role('openai-codex/gpt-6-astra', 'high'),
    researcher: role('không hợp lệ', 'ultra'),
    main: role('anthropic/claude-sonnet-5', 'low'),
  }), {worker: {model: 'anthropic/claude-opus-5-5'}, debugger: {thinking: 'high'}});
});

test('giá trị đang có hiệu lực theo file gốc và vai bị lệch so với cấu hình', t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-roles-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  const values = nativeValues(resolveModelRoles(presets).roles);
  const write = (name, value) => fs.writeFileSync(path.join(agentDir, name), typeof value === 'string' ? value : JSON.stringify(value));
  fs.mkdirSync(path.join(agentDir, 'agents'));
  write('settings.json', {...values.settings, defaultModel: 'claude-sonnet-5', autoMode: values.autoMode});
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
    assert.deepEqual(await checkCatalog({modules, agentDir, roles: resolveModelRoles(presets, {preset: name}).roles}), {errors: [], notes: []}, name);
  }
  const roles = resolveModelRoles(presets, {roles: {reviewer: {model: 'openai-codex/gpt-6-astr'}, researcher: {thinking: 'medium'}, auditor: {thinking: 'max'}}}).roles;
  assert.deepEqual(await checkCatalog({modules, agentDir, roles}), {
    errors: ['reviewer: không có model openai-codex/gpt-6-astr trong catalog của Pi; kiểm tên provider/id, hoặc khai báo model trong models.json'],
    notes: ['researcher: opencode-go/glm-5.3-flash không hỗ trợ thinking medium; Pi dùng high'],
  });
  // Model tự khai báo trong models.json của agent dir là hợp lệ.
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({providers: {local: {
    baseUrl: 'http://127.0.0.1:9', api: 'openai-completions', apiKey: 'unused', models: [{id: 'coder'}],
  }}}));
  const local = resolveModelRoles(presets, {roles: {worker: {model: 'local/coder', thinking: 'off'}}}).roles;
  assert.deepEqual((await checkCatalog({modules, agentDir, roles: local})).errors, []);
  assert.deepEqual(fs.readdirSync(agentDir), ['models.json']);
});
