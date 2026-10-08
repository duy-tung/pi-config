import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {buildConfiguration} from '../lib/config.mjs';
import {modelDefaults} from './install-fixture.mjs';

const root = process.env.PI_CONFIG_TEST_ROOT;
test('Pi: Opus 5.5/high 1M mặc định, advisor Fable trong catalog, GPT Sol/Astra 872K qua Sign in with ChatGPT và payload khi được chọn', {skip: !root}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-models-'));
  const savedOffline = process.env.PI_OFFLINE;
  const savedFetch = globalThis.fetch;
  process.env.PI_OFFLINE = '1';
  globalThis.fetch = () => { throw new Error('Unexpected network in offline model test'); };
  try {
    const generated = buildConfiguration({root: temp, agentDir: path.join(temp, 'main'), nodePath: process.execPath, home: temp, modelDefaults});
    {
      const runtimeName = 'current';
      const modules = path.join(root, `runtimes/${runtimeName}/node_modules`);
      const load = (relative) => import(pathToFileURL(path.join(modules, relative)).href);
      const {ModelRuntime, SettingsManager, createAgentSession, SessionManager, DefaultResourceLoader} = await load('@earendil-works/pi-coding-agent/dist/index.js');
      const {getSupportedThinkingLevels} = await load('@earendil-works/pi-ai/dist/models.js');
      const {streamSimple} = await load('@earendil-works/pi-ai/dist/api/openai-codex-responses.js');
      const {streamSimple: streamResponses} = await load('@earendil-works/pi-ai/dist/api/openai-responses.js');
      const agentDir = path.join(temp, 'main');
      fs.mkdirSync(agentDir, {recursive: true});
      const get = (name) => JSON.parse(generated.find(x => x.path === path.join(agentDir, name)).content);
      const settings = get('settings.json');
      const modelsPath = path.join(agentDir, 'models.json');
      fs.writeFileSync(modelsPath, JSON.stringify(get('models.json')));
      const authPath = path.join(agentDir, 'auth.json');
      const jwt = `fixture.${Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: 'fixture'}})).toString('base64url')}.fixture`;
      const expires = Date.now() + 3600000;
      fs.writeFileSync(authPath, JSON.stringify({
        anthropic: {type: 'oauth', access: 'sk-ant-oat01-synthetic-fixture', refresh: 'fixture-refresh', expires},
        'openai-codex': {type: 'oauth', access: jwt, refresh: 'fixture-refresh', expires},
        // Credential mà /login openai → Sign in with ChatGPT lưu: token dùng thẳng với api.openai.com, kèm client và scope.
        openai: {type: 'oauth', access: 'fixture-chatgpt-token', refresh: 'fixture-refresh', expires, clientId: 'fixture-client',
          scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct']},
      }));
      const runtime = await ModelRuntime.create({authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false});
      assert.equal(runtime.getError(), undefined);
      const model = runtime.getModel(settings.defaultProvider, settings.defaultModel);
      assert.equal(model.id, 'claude-opus-5-5');
      assert.equal(model.provider, 'anthropic');
      assert.equal(model.contextWindow, 1000000);
      assert.equal(model.maxTokens, 128000);
      assert.equal(model.api, 'anthropic-messages');
      assert.ok(getSupportedThinkingLevels(model).includes(settings.defaultThinkingLevel));
      // GPT không là mặc định của vai nào, nhưng models.json nâng context khi người dùng chọn: provider openai
      // (Sign in with ChatGPT) và openai-codex (legacy) như nhau.
      for (const provider of ['openai', 'openai-codex']) {
        for (const id of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']) assert.equal(runtime.getModel(provider, id).contextWindow, 872000, `${provider}/${id}`);
      }
      for (const [ref, level] of Object.entries(settings.modelThinkingLevels)) {
        const [provider, id] = ref.split('/');
        assert.ok(getSupportedThinkingLevels(runtime.getModel(provider, id)).includes(level), ref);
      }
      const settingsManager = SettingsManager.inMemory({...settings, packages: [], extensions: [], skills: [], themes: []});
      const resourceLoader = new DefaultResourceLoader({cwd: temp, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true});
      await resourceLoader.reload();
      // Refresh availability from synthetic auth only; never read real auth.
      await runtime.refresh({allowNetwork: false});
      const {session} = await createAgentSession({cwd: temp, agentDir, modelRuntime: runtime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(temp)});
      assert.equal(session.model.id, 'claude-opus-5-5');
      assert.equal(session.thinkingLevel, 'high');
      session.dispose();
      const advisorConfig = get('advisor.json');
      const [advisorProvider, advisorId] = advisorConfig.advisor.split('/');
      const advisorModel = runtime.getModel(advisorProvider, advisorId);
      assert.deepEqual([advisorModel.provider, advisorModel.id], ['anthropic', 'claude-fable-5-1']);
      assert.ok(getSupportedThinkingLevels(advisorModel).includes(advisorConfig.advisorEffort));
      // Khi một vai được đổi sang Codex: payload mang đúng model và mức reasoning.
      const astra = runtime.getModel('openai-codex', 'gpt-6-astra');
      let captured;
      const response = await streamSimple(astra, {messages: [{role: 'user', content: 'Offline fixture', timestamp: 1}]}, {
        apiKey: jwt, reasoning: 'high', transport: 'sse',
        onPayload(payload) { captured = payload; throw new Error('OFFLINE_CAPTURE'); },
      }).result();
      assert.equal(captured.model, 'gpt-6-astra');
      assert.equal(captured.reasoning.effort, 'high');
      assert.match(response.errorMessage, /OFFLINE_CAPTURE/);
      // Sign in with ChatGPT: model GPT có sẵn sau /login openai, request đi Responses API của api.openai.com
      // bằng token đã lưu; Pi bỏ các trường token ChatGPT không nhận.
      const available = (await runtime.getAvailable('openai')).map(item => `${item.provider}/${item.id}`);
      for (const id of ['gpt-6.1-sol', 'gpt-6-astra']) assert.ok(available.includes(`openai/${id}`), `openai/${id} phải dùng được sau Sign in with ChatGPT`);
      const sol = runtime.getModel('openai', 'gpt-6.1-sol');
      assert.deepEqual([sol.api, sol.baseUrl], ['openai-responses', 'https://api.openai.com/v1']);
      assert.ok(runtime.isUsingOAuth('openai') && runtime.isUsingSubscription('openai'));
      const auth = await runtime.getAuth(sol);
      assert.deepEqual([auth.auth.apiKey, auth.source], ['fixture-chatgpt-token', 'OAuth']);
      captured = undefined;
      const native = await streamResponses(sol, {messages: [{role: 'user', content: 'Offline fixture', timestamp: 1}]}, {
        apiKey: auth.auth.apiKey, reasoning: 'max', maxTokens: 64000,
        onPayload(payload) { captured = payload; throw new Error('OFFLINE_CAPTURE'); },
      }).result();
      assert.deepEqual([captured.model, captured.reasoning.effort, captured.store, captured.stream], ['gpt-6.1-sol', 'max', false, true]);
      assert.equal(captured.max_output_tokens, undefined);
      assert.match(native.errorMessage, /OFFLINE_CAPTURE/);
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
    fs.rmSync(temp, {recursive: true, force: true});
  }
});
