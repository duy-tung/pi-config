import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {completions, levelOf, levelOptions, mainMenu, roleMenu, splitArgs} from '../assets/extensions/model-roles/lib/menu.ts';
import {linkRuntime, readJson, simulatedInstall, snapshot} from './install-fixture.mjs';

// /models (extension model-roles): pi-models ngay trong phiên Pi.

const prefixFilter = (items, query, text) => items.filter(item => text(item).toLowerCase().startsWith(query.toLowerCase()));
const data = {
  roles: ['main', 'worker', 'reviewer'],
  presets: [{name: 'default', description: 'mặc định'}, {name: 'claude'}],
  providers: ['anthropic', 'openai-codex'],
  models: [{ref: 'anthropic/claude-opus-5-5', description: 'Claude Opus 5.5'}, {ref: 'anthropic/claude-sonnet-5'}],
  levels: ['off', 'low', 'high', 'max'],
};
const values = prefix => completions(prefix, data, prefixFilter)?.map(item => item.value) ?? null;

test('/models: gợi ý thay cả chuỗi tham số, theo từng lệnh và vị trí', () => {
  assert.deepEqual(values(''), ['show', 'list', 'preset', 'set', 'reset', 'adopt', 'apply', 'help']);
  assert.deepEqual(values('s'), ['show', 'set']);
  assert.deepEqual(values('set '), ['set main', 'set worker', 'set reviewer']);
  assert.deepEqual(values('set worker anthropic/claude-s'), ['set worker anthropic/claude-sonnet-5']);
  assert.deepEqual(values('set worker anthropic/claude-sonnet-5 h'), ['set worker anthropic/claude-sonnet-5 high']);
  // Đã nêu mức thinking: chỉ còn gợi ý model; đủ tham số thì không gợi ý.
  assert.deepEqual(values('set worker high '), ['set worker high anthropic/claude-opus-5-5', 'set worker high anthropic/claude-sonnet-5']);
  assert.equal(values('set worker anthropic/claude-sonnet-5 high '), null);
  assert.deepEqual(values('preset c'), ['preset claude']);
  assert.deepEqual(completions('preset ', data, prefixFilter)[0], {value: 'preset default', label: 'default', description: 'mặc định'});
  assert.deepEqual(values('reset worker '), ['reset worker main', 'reset worker reviewer']);
  assert.deepEqual(values('reset --'), ['reset --all', 'reset --dry-run']);
  assert.deepEqual(values('apply --reset --'), ['apply --reset --dry-run']);
  assert.deepEqual(values('list a'), ['list anthropic']);
  assert.equal(values('frobnicate '), null);
  assert.deepEqual(splitArgs('  set  worker\thigh '), ['set', 'worker', 'high']);
});

test('/models: menu các vai đánh dấu ghi đè và giá trị đang chạy khi lệch; menu của vai', () => {
  const roles = {
    main: {model: 'anthropic/claude-opus-5-5', thinking: 'high', source: {model: 'preset', thinking: 'preset'}},
    worker: {model: 'openai-codex/gpt-6-sol', thinking: 'high', source: {model: 'preset', thinking: 'override'}},
  };
  const menu = mainMenu({
    preset: 'default', file: '/agent/model-roles.json', session: 'anthropic/claude-opus-5-5 · high', roles, names: ['main', 'worker'],
    drifted: {worker: {model: 'anthropic/claude-sonnet-5', thinking: 'max', file: 'agents/worker.md'}},
  });
  assert.equal(menu.title, 'Model của các vai: preset default (/agent/model-roles.json)\nPhiên này: anthropic/claude-opus-5-5 · high');
  assert.deepEqual(menu.options, [
    'main       anthropic/claude-opus-5-5 · high',
    'worker     openai-codex/gpt-6-sol · high, ghi đè; đang chạy anthropic/claude-sonnet-5 · max theo agents/worker.md',
    'Chọn preset… (đang dùng default)',
    'Giữ giá trị đang chạy của worker (adopt)',
    'Đưa worker về model-roles.json (apply --reset)',
  ]);
  assert.deepEqual(menu.actions, [{role: 'main'}, {role: 'worker'}, {preset: true}, {args: ['adopt']}, {args: ['apply', '--reset']}]);
  assert.deepEqual(mainMenu({preset: 'claude', file: 'x', roles, names: ['main'], drifted: {}}).options.slice(1), ['Chọn preset… (đang dùng claude)']);
  const role = roleMenu('worker', roles.worker, {model: 'openai-codex/gpt-6-sol', thinking: 'max'});
  assert.deepEqual(role.options, [
    'Đổi model… (đang dùng openai-codex/gpt-6-sol)', 'Đổi thinking… (đang dùng high)', 'Bỏ ghi đè, dùng preset (openai-codex/gpt-6-sol · max)',
  ]);
  assert.deepEqual(role.actions, [{pick: 'model'}, {pick: 'thinking'}, {args: ['reset', 'worker']}]);
  assert.equal(roleMenu('main', roles.main).options.length, 2, 'vai không ghi đè thì không có mục bỏ ghi đè');
  assert.deepEqual(levelOptions(['low', 'high', 'max'], 'high'), ['low', 'high (đang dùng)', 'max']);
  assert.equal(levelOf('high (đang dùng)'), 'high');
});

const testRoot = process.env.PI_CONFIG_TEST_ROOT;
test('/models trong phiên Pi thật: menu, set áp ngay cho phiên và auto mode, lỗi, xem trước, list, gợi ý', {skip: !testRoot, timeout: 120000}, async t => {
  // Bản cài giả có extension và bin như installer; runtime nối từ bản cài thật. Chỉ nạp model-roles và pi-auto-mode,
  // model của các vai giữ như installer sinh. Chỉ Claude có key giả: Codex và OpenCode Go chưa đăng nhập.
  const f = simulatedInstall(t, {full: true});
  const unlink = linkRuntime(f.root, testRoot);
  const settingsPath = f.file('settings.json');
  const settings = readJson(settingsPath);
  settings.packages = [];
  settings.extensions = ['model-roles', 'pi-auto-mode'].map(name => path.join(f.root, 'assets', 'extensions', name));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  fs.writeFileSync(f.file('auth.json'), JSON.stringify({anthropic: {type: 'api_key', key: 'fixture-key'}}), {mode: 0o600});
  const cwd = path.join(f.temp, 'work');
  fs.mkdirSync(cwd);
  const saved = {fetch: globalThis.fetch, agentDir: process.env.PI_CODING_AGENT_DIR};
  globalThis.fetch = async () => {
    throw new Error('network is blocked in this fixture');
  };
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  let runtime;
  try {
    const modules = path.join(f.root, 'runtimes', 'current', 'node_modules');
    const sdk = await import(pathToFileURL(path.join(modules, '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')).href);
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: f.file('auth.json'), modelsPath: f.file('models.json'), refreshOnCreate: false, allowModelNetwork: false,
    });
    runtime = await sdk.createAgentSessionRuntime(async ({cwd: target, sessionManager, sessionStartEvent}) => {
      const services = await sdk.createAgentSessionServices({cwd: target, agentDir: f.agentDir, modelRuntime});
      return {...(await sdk.createAgentSessionFromServices({services, sessionManager, sessionStartEvent})), services, diagnostics: services.diagnostics};
    }, {cwd, agentDir: f.agentDir, sessionManager: sdk.SessionManager.inMemory(cwd)});
    const answers = [], keystrokes = [], notices = [], confirms = [], titles = [], missing = [], errors = [];
    const ui = {
      ...Object.fromEntries(['setStatus', 'setWorkingMessage', 'setWorkingVisible', 'setWorkingIndicator', 'setHiddenThinkingLabel', 'setWidget', 'setFooter', 'setHeader', 'setTitle', 'pasteToEditor', 'setEditorText', 'addAutocompleteProvider', 'setEditorComponent', 'setToolsExpanded'].map(key => [key, () => {}])),
      onTerminalInput: () => () => {}, input: async () => undefined, editor: async () => undefined,
      getEditorComponent: () => undefined, getAllThemes: () => [], setTheme: () => ({success: true}), getTheme: () => undefined,
      theme: {fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text, italic: text => text, dim: text => text},
      // Mỗi câu trả lời là regex của lựa chọn; hết câu trả lời thì huỷ.
      select: async (title, options) => {
        titles.push(title);
        const wanted = answers.shift();
        const found = wanted && options.find(option => wanted.test(option));
        if (wanted && !found) missing.push(`${wanted} không có trong: ${options.join(' | ')}`);
        return found;
      },
      confirm: async (title, message) => {
        confirms.push(`${title}\n${message}`);
        return true;
      },
      notify: (message, type = 'info') => notices.push({message, type}),
      // Hộp thoại riêng (ô tìm model): gõ lần lượt các phím đã xếp; hộp thoại phải tự đóng.
      custom: async factory => {
        let result, closed = false;
        const component = await factory({requestRender: () => {}}, ui.theme, undefined, value => {
          result = value;
          closed = true;
        });
        for (const key of keystrokes.splice(0)) component.handleInput(key);
        if (!closed) missing.push('hộp thoại chưa đóng');
        return result;
      },
      getToolsExpanded: () => false, getEditorText: () => '',
    };
    await runtime.session.bindExtensions({
      uiContext: ui, mode: 'tui', onError: error => errors.push(error),
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(), newSession: options => runtime.newSession(options),
        switchSession: (file, options) => runtime.switchSession(file, options), fork: (entryId, options) => runtime.fork(entryId, options),
        navigateTree: (entryId, options) => runtime.session.navigateTree(entryId, options), reload: () => runtime.session.reload(),
      },
    });
    const command = runtime.session.extensionRunner.getRegisteredCommands().find(item => item.name === 'models');
    assert.ok(command, 'Thiếu /models');
    const last = () => notices.at(-1);
    const frontmatter = role => fs.readFileSync(f.file(`agents/${role}.md`), 'utf8').split('\n---\n')[0];
    assert.equal(`${runtime.session.model.provider}/${runtime.session.model.id}`, 'anthropic/claude-opus-5-5');

    // Menu: worker → đổi thinking → high, xem trước rồi xác nhận.
    answers.push(/^worker +openai-codex\/gpt-6-sol · max$/u, /^Đổi thinking/u, /^high$/u);
    await runtime.session.prompt('/models');
    assert.deepEqual(missing, []);
    assert.match(titles[0], /^Model của các vai: preset default \(.*model-roles\.json\)\nPhiên này: anthropic\/claude-opus-5-5 · high$/u);
    assert.match(confirms[0], /^\/models set worker high\nworker: openai-codex\/gpt-6-sol \(max\) → openai-codex\/gpt-6-sol \(high\)$/mu);
    assert.match(confirms[0], /^Sẽ cập nhật: .*agents\/worker\.md/mu);
    assert.match(frontmatter('worker'), /^thinking: high$/mu);
    assert.equal(last().type, 'warning', 'provider chưa đăng nhập là cảnh báo');
    assert.match(last().message, /^cảnh báo: provider openai-codex \(.*worker.*\) chưa đăng nhập: dùng \/login\.$/mu);
    assert.match(last().message, /^Có hiệu lực: worker ở lần gọi Agent kế tiếp\.$/mu);

    // Đổi model qua ô tìm: gõ để lọc cả catalog, Enter chọn, rồi chọn thinking trong các mức model hỗ trợ.
    answers.push(/^reviewer /u, /^Đổi model/u, /^medium$/u);
    keystrokes.push(...'anthropic/claude-sonnet-5', '\r');
    await runtime.session.prompt('/models');
    assert.deepEqual(missing, []);
    assert.match(confirms[1], /^\/models set reviewer anthropic\/claude-sonnet-5 medium$/mu);
    assert.match(frontmatter('reviewer'), /^model: anthropic\/claude-sonnet-5\nthinking: medium$/mu);

    // set main: ghi cấu hình rồi đổi luôn model/thinking của phiên này.
    await runtime.session.prompt('/models set main anthropic/claude-sonnet-5 low');
    assert.match(last().message, /^main: anthropic\/claude-opus-5-5 \(high\) → anthropic\/claude-sonnet-5 \(low\)$/mu);
    assert.match(last().message, /^Phiên này dùng anthropic\/claude-sonnet-5 · low\.$/mu);
    assert.equal(`${runtime.session.model.provider}/${runtime.session.model.id}`, 'anthropic/claude-sonnet-5');
    assert.equal(runtime.session.thinkingLevel, 'low');
    assert.deepEqual([readJson(f.file('advisor.json')).executor, readJson(f.file('settings.json')).defaultModel], ['anthropic/claude-sonnet-5', 'claude-sonnet-5']);
    assert.deepEqual(readJson(f.file('model-roles.json')).roles.main, {model: 'anthropic/claude-sonnet-5', thinking: 'low'});

    // autoMode: pi-auto-mode đọc lại model của bộ phân loại ngay trong phiên.
    await runtime.session.prompt('/models set autoMode anthropic/claude-opus-5-5 high');
    assert.match(last().message, /^Có hiệu lực: autoMode ở lần phân loại kế tiếp của auto mode\.$/mu);
    await runtime.session.prompt('/permissions');
    assert.match(titles.at(-1), /Classifier: .*anthropic\/claude-opus-5-5/u);

    // Model sai tên: báo lỗi, không ghi gì; --dry-run cũng không ghi.
    const before = snapshot(f.root, f.agentDir);
    await runtime.session.prompt('/models set worker anthropic/claude-opus-9');
    assert.equal(last().type, 'error');
    assert.match(last().message, /^\/models: Model không dùng được, chưa ghi gì:\n- worker: không có model anthropic\/claude-opus-9/u);
    await runtime.session.prompt('/models preset claude --dry-run');
    assert.match(last().message, /^Xem trước \(--dry-run\), chưa ghi file nào\.\npreset: default → claude$/mu);
    assert.deepEqual(snapshot(f.root, f.agentDir), before);

    // list và bảng dùng catalog và trạng thái đăng nhập của phiên.
    await runtime.session.prompt('/models list anthropic');
    assert.match(last().message, /^anthropic \(Anthropic\): đã đăng nhập \(API key đã lưu\)$/mu);
    assert.match(last().message, /^ {2}anthropic\/claude-sonnet-5 {2}thinking: .*← main, reviewer$/mu);
    await runtime.session.prompt('/models show');
    assert.match(last().message, /^ {2}main: anthropic\/claude-sonnet-5 \(low\), ghi đè$/mu);
    assert.match(last().message, /^Phiên này: anthropic\/claude-sonnet-5 · low$/mu);

    // Gợi ý tham số từ catalog và model-roles.json của bản cài.
    const suggested = async prefix => (await command.getArgumentCompletions(prefix))?.map(item => item.value) ?? [];
    assert.ok((await suggested('set wor')).includes('set worker'));
    assert.ok((await suggested('set worker anthropic/claude-sonn')).includes('set worker anthropic/claude-sonnet-5'));
    assert.ok((await suggested('preset ')).includes('preset claude'));
    assert.equal(fs.existsSync(path.join(f.root, '.install.lock')), false);
    assert.deepEqual(errors, []);
  } finally {
    await runtime?.dispose();
    globalThis.fetch = saved.fetch;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    unlink();
  }
});
