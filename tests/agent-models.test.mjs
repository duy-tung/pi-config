import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {linkRuntime, readJson, simulatedInstall} from './install-fixture.mjs';

// Model/thinking của các vai subagent đổi trong /agents của pi-subagents (bản vá thêm Model/Thinking vào menu của
// agent); model phân loại của auto mode đổi trong /permissions. Không còn /models.

const testRoot = process.env.PI_CONFIG_TEST_ROOT;
test('/agents và /permissions trong phiên Pi thật: Model/Thinking của agent ghi frontmatter; mode và model phân loại áp ngay', {skip: !testRoot, timeout: 120000}, async t => {
  // Bản cài giả có extension như installer; runtime (đã vá) nối từ bản cài thật. Chỉ nạp pi-subagents và pi-auto-mode,
  // model của các vai giữ như installer sinh. Chỉ Claude có key giả: Codex và OpenCode Go chưa đăng nhập.
  const f = simulatedInstall(t, {full: true});
  const unlink = linkRuntime(f.root, testRoot);
  const settingsPath = f.file('settings.json');
  const settings = readJson(settingsPath);
  settings.packages = settings.packages.filter(entry => typeof entry === 'string' && entry.replaceAll('\\', '/').endsWith('/@tintinweb/pi-subagents'));
  assert.equal(settings.packages.length, 1);
  settings.extensions = [path.join(f.root, 'assets', 'extensions', 'pi-auto-mode')];
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
    // Menu của /agents dựng component của TUI (SettingsList, ô tìm model): cần theme như khi chạy trong terminal.
    sdk.initTheme('dark');
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: f.file('auth.json'), modelsPath: f.file('models.json'), refreshOnCreate: false, allowModelNetwork: false,
    });
    runtime = await sdk.createAgentSessionRuntime(async ({cwd: target, sessionManager, sessionStartEvent}) => {
      const services = await sdk.createAgentSessionServices({cwd: target, agentDir: f.agentDir, modelRuntime});
      return {...(await sdk.createAgentSessionFromServices({services, sessionManager, sessionStartEvent})), services, diagnostics: services.diagnostics};
    }, {cwd, agentDir: f.agentDir, sessionManager: sdk.SessionManager.inMemory(cwd)});
    const answers = [], keystrokes = [], notices = [], titles = [], menus = [], missing = [], errors = [];
    const ui = {
      ...Object.fromEntries(['setStatus', 'setWorkingMessage', 'setWorkingVisible', 'setWorkingIndicator', 'setHiddenThinkingLabel', 'setWidget', 'setFooter', 'setHeader', 'setTitle', 'pasteToEditor', 'setEditorText', 'addAutocompleteProvider', 'setEditorComponent', 'setToolsExpanded'].map(key => [key, () => {}])),
      onTerminalInput: () => () => {}, input: async () => undefined, editor: async () => undefined,
      getEditorComponent: () => undefined, getAllThemes: () => [], setTheme: () => ({success: true}), getTheme: () => undefined,
      theme: {fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text, italic: text => text, dim: text => text},
      // Mỗi câu trả lời là regex của lựa chọn; hết câu trả lời thì huỷ.
      select: async (title, options) => {
        titles.push(title);
        menus.push(options);
        const wanted = answers.shift();
        const found = wanted && options.find(option => wanted.test(option));
        if (wanted && !found) missing.push(`${wanted} không có trong: ${options.join(' | ')}`);
        return found;
      },
      confirm: async () => true,
      notify: (message, type = 'info') => notices.push({message, type}),
      // Hộp thoại riêng (danh sách agent, ô tìm model): mỗi lần mở lấy một bước đã xếp (danh sách phím, hoặc hàm nhận
      // các dòng đã vẽ và trả danh sách phím); hộp thoại phải tự đóng.
      custom: async factory => {
        let result, closed = false;
        const component = await factory({requestRender: () => {}}, ui.theme, undefined, value => {
          result = value;
          closed = true;
        });
        const step = keystrokes.shift() ?? [];
        for (const key of typeof step === 'function' ? step(component.render(120)) : step) component.handleInput(key);
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
    const commands = runtime.session.extensionRunner.getRegisteredCommands().map(item => item.name);
    assert.ok(commands.includes('agents'), 'Thiếu /agents');
    assert.ok(!commands.includes('models'), '/models đã gỡ: model của vai đổi trong /agents');
    const last = () => notices.at(-1);
    const workerFile = f.file('agents/worker.md'), workerBefore = fs.readFileSync(workerFile, 'utf8');
    // Danh sách Agent types: xuống tới dòng của agent rồi Enter.
    const row = name => lines => {
      const names = lines.flatMap(line => [...line.matchAll(/◦ {2}(\w+)/gu)].map(match => match[1]));
      assert.ok(names.includes(name), lines.join('\n'));
      return [...Array(names.indexOf(name)).fill('\x1b[B'), '\r'];
    };
    const agents = async (...steps) => {
      answers.push(...steps);
      await runtime.session.prompt('/agents');
      assert.deepEqual(missing, []);
    };

    // worker → Model: gõ để lọc cả catalog, Enter chọn; rồi thinking trong các mức model hỗ trợ. Menu của agent mở lại
    // với giá trị mới: Thinking → high. Đóng danh sách bằng Esc.
    keystrokes.push(row('worker'), [...'anthropic/claude-sonnet-5-5', '\r'], ['\x1b']);
    await agents(/^Agent types \(3\)$/u, /^Model: /u, /^medium$/u, /^Thinking: medium$/u, /^high$/u);
    const detail = titles.indexOf('worker');
    assert.deepEqual(menus[detail], ['Model: openai-codex/gpt-6.1-sol', 'Thinking: max', 'Edit', 'Disable', 'Delete', 'Back']);
    assert.equal(titles[detail + 1], 'Thinking for worker (anthropic/claude-sonnet-5-5)');
    assert.ok(menus[detail + 1].includes('medium') && menus[detail + 1].includes('high'), menus[detail + 1].join(' | '));
    assert.deepEqual(menus[detail + 2].slice(0, 2), ['Model: anthropic/claude-sonnet-5-5', 'Thinking: medium']);
    assert.ok(menus[detail + 3].includes('medium (current)'), menus[detail + 3].join(' | '));
    assert.deepEqual(notices.filter(item => item.message.startsWith('worker: ')).map(item => item.message), [
      'worker: anthropic/claude-sonnet-5-5 · medium, from its next run', 'worker: anthropic/claude-sonnet-5-5 · high, from its next run',
    ]);
    // Chỉ hai dòng model/thinking đổi; phần còn lại của file giữ nguyên.
    assert.equal(fs.readFileSync(workerFile, 'utf8'),
      workerBefore.replace(/^model: .*\nthinking: .*$/mu, 'model: anthropic/claude-sonnet-5-5\nthinking: high'));

    // Huỷ ở bước chọn thinking: không ghi gì.
    keystrokes.push(row('reviewer'), [...'anthropic/claude-opus-5-5', '\r'], ['\x1b']);
    const reviewerBefore = fs.readFileSync(f.file('agents/reviewer.md'), 'utf8');
    await agents(/^Agent types/u, /^Model: /u);
    assert.equal(fs.readFileSync(f.file('agents/reviewer.md'), 'utf8'), reviewerBefore);

    // Model phân loại chỉ đổi trong /permissions → Classifier: model đã đăng nhập (chỉ Claude), rồi mức thinking;
    // ghi autoMode.model/stage2Reasoning vào settings.json (giữ quyền file) và áp ngay cho phiên.
    const permissions = async (...steps) => {
      answers.push(...steps);
      await runtime.session.prompt('/permissions');
      assert.deepEqual(missing, []);
    };
    const settingsMode = fs.statSync(settingsPath).mode & 0o777;
    await permissions(/^Classifier: anthropic\/claude-sonnet-5-5 · low…$/u, /^Change classifier model…$/u, /^anthropic\/claude-opus-5-5$/u, /^high$/u);
    assert.match(titles.at(-3), /^Mode: auto\nClassifier \(auto mode\): anthropic\/claude-sonnet-5-5 · low · timeout 60s\n/u);
    assert.ok(menus.at(-2).includes('anthropic/claude-sonnet-5-5 (current)') && menus.at(-2).every(option => option.startsWith('anthropic/')), menus.at(-2).join(' | '));
    assert.ok(menus.at(-1).includes('low (current)'));
    assert.match(last().message, /^Classifier: anthropic\/claude-opus-5-5 · high \(saved to .*settings\.json\)$/u);
    assert.deepEqual([readJson(settingsPath).autoMode.model, readJson(settingsPath).autoMode.stage2Reasoning], ['anthropic/claude-opus-5-5', 'high']);
    assert.equal(readJson(settingsPath).autoMode.jev.model, 'jev-1.13.0', 'phần còn lại của autoMode giữ nguyên');
    if (process.platform !== 'win32') assert.equal(fs.statSync(settingsPath).mode & 0o777, settingsMode);
    await permissions();
    assert.equal(titles.at(-1), 'Permissions · ⏵⏵ auto mode on');
    assert.deepEqual(menus.at(-1), [
      'Mode: auto — change…', 'Classifier: anthropic/claude-opus-5-5 · high…', 'Recently denied (0)', 'Rules…', 'Test a command…',
    ]);
    // Mode: chọn manual rồi chạy thử; manual không gọi bộ phân loại. /permissions test <lệnh> chạy thử trực tiếp.
    await permissions(/^Mode: auto/u, /^⏸ manual mode on$/u);
    await runtime.session.prompt('/permissions test npm install left-pad');
    assert.match(last().message, /^Manual mode: Pi would ask you before running this \(no classifier call\)\.$/u);
    await runtime.session.prompt('/permissions test git status');
    assert.match(last().message, /^Decision without classifier: allow \(read-only command\)$/u);
    await permissions(/^Mode: manual/u, /^⏵⏵ auto mode on$/u);
    await permissions();
    assert.equal(titles.at(-1), 'Permissions · ⏵⏵ auto mode on');
    assert.ok(!runtime.session.extensionRunner.getRegisteredCommands().some(item => item.name === 'auto-mode'), '/auto-mode đã gộp vào /permissions');

    assert.deepEqual(errors, []);
  } finally {
    await runtime?.dispose();
    globalThis.fetch = saved.fetch;
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    unlink();
  }
});
