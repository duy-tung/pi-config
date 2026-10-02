import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {levelOf, levelOptions, mainMenu, roleMenu} from '../assets/extensions/model-roles/lib/menu.ts';
import {linkRuntime, readJson, simulatedInstall, snapshot} from './install-fixture.mjs';

// /models (extension model-roles): menu đổi model/thinking của các vai ngay trong phiên Pi.

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
    'Đưa worker về model-roles.json',
  ]);
  assert.deepEqual(menu.actions, [{role: 'main'}, {role: 'worker'}, {preset: true}, {change: {apply: true}}]);
  assert.deepEqual(mainMenu({preset: 'claude', file: 'x', roles, names: ['main'], drifted: {}}).options.slice(1), ['Chọn preset… (đang dùng claude)']);
  const role = roleMenu('worker', roles.worker, {model: 'openai-codex/gpt-6-sol', thinking: 'max'});
  assert.deepEqual(role.options, [
    'Đổi model… (đang dùng openai-codex/gpt-6-sol)', 'Đổi thinking… (đang dùng high)', 'Bỏ ghi đè, dùng preset (openai-codex/gpt-6-sol · max)',
  ]);
  assert.deepEqual(role.actions, [{pick: 'model'}, {pick: 'thinking'}, {change: {reset: 'worker'}}]);
  assert.equal(roleMenu('main', roles.main).options.length, 2, 'vai không ghi đè thì không có mục bỏ ghi đè');
  assert.deepEqual(levelOptions(['low', 'high', 'max'], 'high'), ['low', 'high (đang dùng)', 'max']);
  assert.equal(levelOf('high (đang dùng)'), 'high');
});

const testRoot = process.env.PI_CONFIG_TEST_ROOT;
test('/models trong phiên Pi thật: menu đổi thinking, model, preset, bỏ ghi đè, đưa vai lệch về cấu hình; áp ngay cho phiên và auto mode', {skip: !testRoot, timeout: 120000}, async t => {
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
    const answers = [], keystrokes = [], notices = [], confirms = [], decisions = [], titles = [], missing = [], errors = [];
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
      // Xác nhận ghi: mặc định đồng ý; decisions xếp sẵn câu trả lời khác.
      confirm: async (title, message) => {
        confirms.push(`${title}\n${message}`);
        return decisions.shift() ?? true;
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
    const menu = async (...steps) => {
      answers.push(...steps);
      await runtime.session.prompt('/models');
      assert.deepEqual(missing, []);
    };
    assert.equal(`${runtime.session.model.provider}/${runtime.session.model.id}`, 'anthropic/claude-opus-5-5');

    // worker → đổi thinking → high, xem trước rồi xác nhận.
    await menu(/^worker +openai-codex\/gpt-6-sol · max$/u, /^Đổi thinking/u, /^high$/u);
    assert.match(titles[0], /^Model của các vai: preset default \(.*model-roles\.json\)\nPhiên này: anthropic\/claude-opus-5-5 · high$/u);
    assert.match(confirms[0], /^Ghi thay đổi này\?\nworker: openai-codex\/gpt-6-sol \(max\) → openai-codex\/gpt-6-sol \(high\)$/mu);
    assert.match(confirms[0], /^Sẽ cập nhật: .*agents\/worker\.md/mu);
    assert.match(frontmatter('worker'), /^thinking: high$/mu);
    assert.equal(last().type, 'warning', 'provider chưa đăng nhập là cảnh báo');
    assert.match(last().message, /^cảnh báo: provider openai-codex \(.*worker.*\) chưa đăng nhập: dùng \/login\.$/mu);
    assert.match(last().message, /^Có hiệu lực: worker ở lần gọi Agent kế tiếp\.$/mu);

    // Đổi model qua ô tìm: gõ để lọc cả catalog, Enter chọn, rồi chọn thinking trong các mức model hỗ trợ.
    keystrokes.push(...'anthropic/claude-sonnet-5', '\r');
    await menu(/^reviewer /u, /^Đổi model/u, /^medium$/u);
    assert.match(confirms[1], /^reviewer: openai-codex\/gpt-6-astra \(high\) → anthropic\/claude-sonnet-5 \(medium\)$/mu);
    assert.match(frontmatter('reviewer'), /^model: anthropic\/claude-sonnet-5\nthinking: medium$/mu);

    // main: ghi cấu hình rồi đổi luôn model/thinking của phiên này.
    keystrokes.push(...'anthropic/claude-sonnet-5', '\r');
    await menu(/^main /u, /^Đổi model/u, /^low$/u);
    assert.match(last().message, /^main: anthropic\/claude-opus-5-5 \(high\) → anthropic\/claude-sonnet-5 \(low\)$/mu);
    assert.match(last().message, /^Phiên này dùng anthropic\/claude-sonnet-5 · low\.$/mu);
    assert.equal(`${runtime.session.model.provider}/${runtime.session.model.id}`, 'anthropic/claude-sonnet-5');
    assert.equal(runtime.session.thinkingLevel, 'low');
    assert.deepEqual([readJson(f.file('advisor.json')).executor, readJson(f.file('settings.json')).defaultModel], ['anthropic/claude-sonnet-5', 'claude-sonnet-5']);
    assert.deepEqual(readJson(f.file('model-roles.json')).roles.main, {model: 'anthropic/claude-sonnet-5', thinking: 'low'});

    // autoMode: pi-auto-mode đọc lại model của bộ phân loại ngay trong phiên.
    keystrokes.push(...'anthropic/claude-opus-5-5', '\r');
    await menu(/^autoMode /u, /^Đổi model/u, /^high$/u);
    assert.match(last().message, /^Có hiệu lực: autoMode ở lần phân loại kế tiếp của auto mode\.$/mu);
    await runtime.session.prompt('/permissions');
    assert.match(titles.at(-1), /Classifier: .*anthropic\/claude-opus-5-5/u);

    // Chọn preset nhưng không xác nhận: chỉ xem trước, không ghi gì; tham số gõ kèm /models bị bỏ qua (huỷ menu).
    const before = snapshot(f.root, f.agentDir);
    decisions.push(false);
    await menu(/^Chọn preset/u, /^claude: /u);
    assert.match(confirms.at(-1), /^preset: default → claude$/mu);
    await runtime.session.prompt('/models preset claude');
    assert.deepEqual(snapshot(f.root, f.agentDir), before);

    // Bỏ ghi đè của worker: dùng lại thinking của preset.
    await menu(/^worker .*ghi đè/u, /^Bỏ ghi đè/u);
    assert.equal(readJson(f.file('model-roles.json')).roles.worker, undefined);
    assert.match(frontmatter('worker'), /^thinking: max$/mu);

    // debugger lệch qua /agents: menu có mục đưa vai lệch về model-roles.json.
    fs.writeFileSync(f.file('agents/debugger.md'), fs.readFileSync(f.file('agents/debugger.md'), 'utf8').replace('thinking: max', 'thinking: low'));
    await menu(/^Đưa .*debugger.* về model-roles\.json$/u);
    assert.match(confirms.at(-1), /^Ghi đè giá trị đổi ngoài model-roles\.json: debugger \(agents\/debugger\.md: openai-codex\/gpt-6-sol \(low\)\)$/mu);
    assert.match(frontmatter('debugger'), /^thinking: max$/mu);
    assert.equal(fs.existsSync(path.join(f.root, '.install.lock')), false);
    assert.deepEqual(errors, []);
  } finally {
    await runtime?.dispose();
    globalThis.fetch = saved.fetch;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    unlink();
  }
});
