import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.env.PI_CONFIG_TEST_ROOT;
for(const runtimeName of ['current','compat'])test(`GLM native ${runtimeName}: max reaches OpenCode Go HTTP payload`,{skip:!root},async()=>{
  const modules=path.join(root,'runtimes',runtimeName,'node_modules');
  const load=rel=>import(pathToFileURL(path.join(modules,rel)).href);
  const {ModelRuntime}=await load('@earendil-works/pi-coding-agent/dist/core/model-runtime.js');
  const {AuthStorage}=await load('@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
  const {getSupportedThinkingLevels}=await load('@earendil-works/pi-ai/dist/models.js');
  const runtime=await ModelRuntime.create({credentials:AuthStorage.inMemory({'opencode-go':{type:'api_key',key:'synthetic-wire-fixture'}}),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  const model=runtime.getModel('opencode-go','glm-5.3-flash');
  assert.equal(model.contextWindow,1000000);assert.ok(getSupportedThinkingLevels(model).includes('max'));
  let calls=0, captured;
  const fetchImpl=async(url,init)=>{
    calls++;captured={url:String(url),headers:new Headers(init.headers),body:JSON.parse(init.body)};
    const chunks=[{choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}}];
    return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  const answer=await runtime.completeSimple(model,{messages:[{role:'user',content:'Synthetic wire test',timestamp:0}]},{reasoning:'max',maxTokens:64,sessionId:'wire-fixture',fetch:fetchImpl});
  assert.equal(calls,1);assert.equal(answer.stopReason,'stop',answer.errorMessage);assert.equal(answer.content.find(x=>x.type==='text').text,'OK');
  assert.equal(captured.url,'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(captured.headers.get('x-opencode-session'),'wire-fixture');
  assert.equal(captured.body.model,'glm-5.3-flash');assert.equal(captured.body.reasoning_effort,'max');assert.equal(captured.body.max_tokens,64);
});
