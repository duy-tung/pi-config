import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {buildConfiguration} from '../lib/config.mjs';

const root = process.env.PI_CONFIG_TEST_ROOT;
test('Compat: goal/background khởi tạo Astra high 872K và tạo đúng payload Codex', {skip: !root}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-compat-models-'));
  const savedOffline = process.env.PI_OFFLINE;
  const savedFetch = globalThis.fetch;
  process.env.PI_OFFLINE = '1';
  globalThis.fetch = () => { throw new Error('Unexpected network in offline model test'); };
  try {
    const modules = path.join(root, 'runtimes/compat/node_modules');
    const load = (relative) => import(pathToFileURL(path.join(modules, relative)).href);
    const {ModelRuntime, SettingsManager, createAgentSession, SessionManager, DefaultResourceLoader} = await load('@earendil-works/pi-coding-agent/dist/index.js');
    const {getSupportedThinkingLevels} = await load('@earendil-works/pi-ai/dist/models.js');
    const {streamSimple} = await load('@earendil-works/pi-ai/dist/api/openai-codex-responses.js');
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'runtimes/current/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json')));
    const catalogModel = Object.values(catalog).find(models => models['gpt-6-astra'])['gpt-6-astra'];
    const {provider: _provider, baseUrl: _baseUrl, ...expectedDefinition} = catalogModel;
    expectedDefinition.contextWindow = 872000;
    const generated = buildConfiguration({root: temp, agentDir: path.join(temp, 'main'), binDir: path.join(temp, 'bin'), nodePath: process.execPath, home: temp});
    for (const profile of ['goal', 'background']) {
      const agentDir = path.join(temp, 'profiles', profile);
      fs.mkdirSync(agentDir, {recursive: true});
      const get = (name) => JSON.parse(generated.find(x => x.path === path.join(agentDir, name)).content);
      const settings = get('settings.json');
      assert.deepEqual(get('models.json').providers['openai-codex'].models, [expectedDefinition]);
      const modelsPath = path.join(agentDir, 'models.json');
      fs.writeFileSync(modelsPath, JSON.stringify(get('models.json')));
      const authPath = path.join(agentDir, 'auth.json');
      const jwt = `fixture.${Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: 'fixture'}})).toString('base64url')}.fixture`;
      fs.writeFileSync(authPath, JSON.stringify({'openai-codex': {type: 'oauth', access: jwt, refresh: 'fixture-refresh', expires: Date.now() + 3600000}}));
      const runtime = await ModelRuntime.create({authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false});
      assert.equal(runtime.getError(), undefined);
      const model = runtime.getModel(settings.defaultProvider, settings.defaultModel);
      assert.equal(model.id, 'gpt-6-astra');
      assert.equal(model.provider, 'openai-codex');
      assert.equal(model.contextWindow, 872000);
      assert.equal(model.maxTokens, 128000);
      assert.equal(model.api, 'openai-codex-responses');
      assert.ok(getSupportedThinkingLevels(model).includes(settings.defaultThinkingLevel));
      assert.equal(runtime.getModel('openai-codex', 'gpt-5.6-sol').contextWindow, 872000);
      const settingsManager = SettingsManager.inMemory({...settings, packages: [], extensions: [], skills: [], themes: []});
      const resourceLoader = new DefaultResourceLoader({cwd: temp, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true});
      await resourceLoader.reload();
      // Refresh availability from synthetic auth only; never read real auth.
      await runtime.refresh({allowNetwork: false});
      const {session} = await createAgentSession({cwd: temp, agentDir, modelRuntime: runtime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(temp)});
      assert.equal(session.model.id, 'gpt-6-astra');
      assert.equal(session.thinkingLevel, 'high');
      session.dispose();
      let captured;
      const response = await streamSimple(model, {messages: [{role: 'user', content: 'Offline fixture', timestamp: 1}]}, {
        apiKey: jwt, reasoning: 'high', transport: 'sse',
        onPayload(payload) { captured = payload; throw new Error('OFFLINE_CAPTURE'); },
      }).result();
      assert.equal(captured.model, 'gpt-6-astra');
      assert.equal(captured.reasoning.effort, 'high');
      assert.match(response.errorMessage, /OFFLINE_CAPTURE/);
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
    fs.rmSync(temp, {recursive: true, force: true});
  }
});
