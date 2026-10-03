import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  CHANGE_AT, ROLES, THINKING_LEVELS, checkCatalog, effectiveModelRoles, loadModelDefaults, nativeValues, parseModelRef, rebaseModels,
  roleModel, setRoleModel, splitRole,
} from '../runtime/model-roles.mjs';

const defaults = loadModelDefaults(fileURLToPath(new URL('../', import.meta.url)));
const table = roles => Object.fromEntries(ROLES.map(name => [name, `${roles[name].model} ${roles[name].thinking}`]));
const role = (model, thinking) => `---\nname: worker\ndescription: Viết code.\nmodel: ${model}\nthinking: ${thinking}\ntools: "read, bash"\n---\n\nPrompt của role.\n`;
/** Mặc định với vài vai đổi model/thinking. */
const withRoles = changes => Object.fromEntries(ROLES.map(name => [name, {...defaults[name], ...changes[name]}]));

test('mặc định đặt đủ model và thinking hợp lệ cho mọi vai; mỗi vai có chỗ đổi', () => {
  assert.deepEqual(Object.keys(defaults), ROLES);
  assert.deepEqual(table(defaults), {
    main: 'anthropic/claude-opus-5-5 high', researcher: 'opencode-go/glm-5.3-flash max',
    worker: 'openai-codex/gpt-6.1-sol max', reviewer: 'openai-codex/gpt-6-astra high',
    advisor: 'openai-codex/gpt-6-astra high',
  });
  for (const name of ROLES) {
    assert.deepEqual(Object.keys(defaults[name]), ['model', 'thinking'], name);
    assert.ok(parseModelRef(defaults[name].model), name);
    assert.ok(THINKING_LEVELS.includes(defaults[name].thinking), name);
  }
  assert.deepEqual(CHANGE_AT, {main: '/model', researcher: '/agents', worker: '/agents', reviewer: '/agents', advisor: '/advisor-models'});
  assert.deepEqual(parseModelRef('openrouter/anthropic/claude-sonnet-5-5'), {provider: 'openrouter', id: 'anthropic/claude-sonnet-5-5'});
  for (const bad of ['opus', '/x', 'a/', 'a /b', 42]) assert.equal(parseModelRef(bad), undefined, String(bad));
});

test('giá trị cho từng file gốc: phiên chính, advisor không đặt thinking của phiên, danh sách model', () => {
  const values = nativeValues(defaults);
  assert.deepEqual(values.settings, {
    defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', defaultThinkingLevel: 'high',
    modelThinkingLevels: {
      'anthropic/claude-opus-5-5': 'high', 'openai-codex/gpt-6.1-sol': 'max', 'openai-codex/gpt-6-astra': 'high', 'opencode-go/glm-5.3-flash': 'max',
    },
    enabledModels: ['anthropic/claude-opus-5-5', 'openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6-astra', 'opencode-go/glm-5.3-flash'],
  });
  // Không có executorEffort: advisor alwaysOn không đặt lại thinking mà /model hay /thinking của Pi đã chọn.
  assert.deepEqual(values.advisor, {executor: 'anthropic/claude-opus-5-5', advisor: 'openai-codex/gpt-6-astra', advisorEffort: 'high'});
  assert.deepEqual(values.subagents.worker, {model: 'openai-codex/gpt-6.1-sol', thinking: 'max'});
  const custom = nativeValues(withRoles({main: {thinking: 'xhigh'}, reviewer: {model: 'anthropic/claude-opus-5-5'}}));
  // Model dùng chung chỉ xuất hiện một lần, phiên chính đứng đầu và giữ thinking của phiên chính.
  assert.deepEqual(custom.settings.enabledModels, ['anthropic/claude-opus-5-5', 'openai-codex/gpt-6.1-sol', 'opencode-go/glm-5.3-flash', 'openai-codex/gpt-6-astra']);
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

test('giá trị đang có hiệu lực theo file gốc: executor của advisor thắng settings.json khi luôn bật', t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-roles-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  const values = nativeValues(defaults);
  const write = (name, value) => fs.writeFileSync(path.join(agentDir, name), typeof value === 'string' ? value : JSON.stringify(value));
  fs.mkdirSync(path.join(agentDir, 'agents'));
  write('settings.json', {...values.settings, defaultModel: 'claude-sonnet-5-5', autoMode: {model: 'anthropic/claude-haiku-4-5'}});
  write('advisor.json', {...values.advisor, alwaysOn: true});
  for (const [name, value] of Object.entries(values.subagents)) write(`agents/${name}.md`, role(value.model, value.thinking));
  const effective = effectiveModelRoles(agentDir);
  // advisor alwaysOn: executor thắng settings.json (Sonnet trong settings không phải model thật của phiên); thinking
  // theo settings.json khi advisor không có executorEffort.
  assert.deepEqual(effective.main, {model: 'anthropic/claude-opus-5-5', thinking: 'high', file: 'advisor.json'});
  assert.deepEqual(Object.keys(effective), ROLES);
  assert.deepEqual(effective.worker, {model: 'openai-codex/gpt-6.1-sol', thinking: 'max', file: 'agents/worker.md'});
  assert.deepEqual(effective.advisor, {model: 'openai-codex/gpt-6-astra', thinking: 'high', file: 'advisor.json'});
  write('advisor.json', {...values.advisor, executorEffort: 'low', alwaysOn: true});
  assert.equal(effectiveModelRoles(agentDir).main.thinking, 'low');
  write('advisor.json', {...values.advisor, alwaysOn: false});
  assert.deepEqual(effectiveModelRoles(agentDir).main, {model: 'anthropic/claude-sonnet-5-5', thinking: 'high', file: 'settings.json'});
});

test('chuyển đổi model-roles.json: base mới mang model mặc định thuần, giữ phần còn lại của base', () => {
  const overridden = nativeValues(withRoles({main: {thinking: 'xhigh'}, reviewer: {model: 'anthropic/claude-fable-5-1'}, advisor: {model: 'anthropic/claude-fable-5-1'}}));
  // Base của bản trước: advisor có executorEffort, settings có khóa khác.
  const settings = JSON.stringify({theme: 'rose-pine-moon', ...overridden.settings}, null, 2);
  const advisor = JSON.stringify({alwaysOn: true, ...overridden.advisor, executorEffort: 'xhigh'}, null, 2);
  const pure = nativeValues(defaults);
  assert.deepEqual(JSON.parse(rebaseModels('settings', settings, defaults)), {theme: 'rose-pine-moon', ...pure.settings});
  assert.deepEqual(JSON.parse(rebaseModels('advisor', advisor, defaults)), {alwaysOn: true, ...pure.advisor, executorEffort: 'xhigh'});
  assert.equal(rebaseModels('reviewer', role('anthropic/claude-fable-5-1', 'high'), defaults), role('openai-codex/gpt-6-astra', 'high'));
  assert.throws(() => rebaseModels('reviewer', 'không có frontmatter', defaults), /frontmatter/u);
});

const root = process.env.PI_CONFIG_TEST_ROOT;
test('catalog của runtime: mặc định và model chỉ Claude hợp lệ, model sai tên là lỗi kèm chỗ đổi, mức thinking bị hạ là ghi chú, không ghi file', {skip: !root}, async t => {
  const modules = path.join(root, 'runtimes', 'current', 'node_modules');
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-catalog-'));
  t.after(() => fs.rmSync(agentDir, {recursive: true, force: true}));
  const claude = withRoles({
    researcher: {model: 'anthropic/claude-sonnet-5-5', thinking: 'high'}, worker: {model: 'anthropic/claude-opus-5-5', thinking: 'high'},
    reviewer: {model: 'anthropic/claude-fable-5-1'}, advisor: {model: 'anthropic/claude-fable-5-1'},
  });
  for (const [name, roles] of [['mặc định', defaults], ['chỉ Claude', claude]]) {
    assert.deepEqual(await checkCatalog({modules, agentDir, roles}), {errors: [], notes: []}, name);
  }
  const roles = withRoles({reviewer: {model: 'openai-codex/gpt-6-astr'}, researcher: {thinking: 'medium'}});
  roles.reviewer.file = 'agents/reviewer.md';
  assert.deepEqual(await checkCatalog({modules, agentDir, roles}), {
    errors: ['reviewer: không có model openai-codex/gpt-6-astr trong catalog của Pi (theo agents/reviewer.md; đổi bằng /agents); kiểm tên provider/id, hoặc khai báo model trong models.json'],
    notes: ['researcher: opencode-go/glm-5.3-flash không hỗ trợ thinking medium; Pi dùng high'],
  });
  // Model tự khai báo trong models.json của agent dir là hợp lệ.
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({providers: {local: {
    baseUrl: 'http://127.0.0.1:9', api: 'openai-completions', apiKey: 'unused', models: [{id: 'coder'}],
  }}}));
  assert.deepEqual((await checkCatalog({modules, agentDir, roles: withRoles({worker: {model: 'local/coder', thinking: 'off'}})})).errors, []);
  assert.deepEqual(fs.readdirSync(agentDir), ['models.json']);
});
