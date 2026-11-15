import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {buildConfiguration} from '../lib/config.mjs';
import {modelDefaults} from './install-fixture.mjs';

const root = process.env.PI_CONFIG_TEST_ROOT;
test('Pi: Opus 5.5/high 1M mặc định, advisor Fable trong catalog', {skip: !root}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-models-'));
  const savedOffline = process.env.PI_OFFLINE;
  const savedFetch = globalThis.fetch;
  process.env.PI_OFFLINE = '1';
  globalThis.fetch = () => { throw new Error('Unexpected network in offline model test'); };
  try {
    const generated = buildConfiguration({root: temp, agentDir: path.join(temp, 'main'), home: temp, modelDefaults});
    {
      const runtimeName = 'current';
      const modules = path.join(root, `runtimes/${runtimeName}/node_modules`);
      const load = (relative) => import(pathToFileURL(path.join(modules, relative)).href);
      const {ModelRuntime, SettingsManager, createAgentSession, SessionManager, DefaultResourceLoader} = await load('@earendil-works/pi-coding-agent/dist/index.js');
      const {getSupportedThinkingLevels} = await load('@earendil-works/pi-ai/dist/models.js');
      const agentDir = path.join(temp, 'main');
      fs.mkdirSync(agentDir, {recursive: true});
      const get = (name) => JSON.parse(generated.find(x => x.path === path.join(agentDir, name)).content);
      const settings = get('settings.json');
      // Installer không sinh models.json; runtime chạy với file không tồn tại như bản cài thật.
      assert.ok(!generated.some(x => x.path === path.join(agentDir, 'models.json')));
      const modelsPath = path.join(agentDir, 'models.json');
      const authPath = path.join(agentDir, 'auth.json');
      const expires = Date.now() + 3600000;
      fs.writeFileSync(authPath, JSON.stringify({
        anthropic: {type: 'oauth', access: 'sk-ant-oat01-synthetic-fixture', refresh: 'fixture-refresh', expires},
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
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
    fs.rmSync(temp, {recursive: true, force: true});
  }
});
