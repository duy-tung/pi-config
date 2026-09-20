import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_POLICY, validatePolicy, validateTask, makeRequest, parseJudgment, selectCandidate, spawnAndJoin, CANDIDATES } from '../assets/extensions/pi-dispatch-router/core.mjs';
import { callJev, readJson, appendAudit } from '../assets/extensions/pi-dispatch-router/storage.mjs';

const task = { requestId: 'r1', role: 'researcher', taskClass: 'lookup', candidate: 'auto', brief: 'Tìm hàm xử lý timeout.', acceptance: 'Nêu file và dòng từ source; không sửa.' };
const policy = () => ({ ...structuredClone(DEFAULT_POLICY), mode: 'balanced', glmAutoClasses: ['lookup'] });
const cards = { glm: [{ model: 'opencode-go/glm-5.3-flash', thinking: 'max', role: 'researcher', taskClass: 'lookup', samples: 12, passed: 12, status: 'accepted', evidenceId: 'synthetic-eval', expiresAt: '2099-01-01' }], sol: [] };
const good = { needs_design: 0.01, glm_can_complete: 0.98, sol_can_complete: 0.99 };
const response = () => ({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(good).map(([k,noul]) => [k,{ type:'noul',noul }])), usage: { input_tokens: 1000, output_tokens: 50 } });
const fixture = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-unit-')); t.after(() => fs.rmSync(p,{recursive:true,force:true})); return p; };
test('fixed candidates pin GLM max and Sol high; invalid policy/task fail closed', () => {
  assert.equal(CANDIDATES.glm.thinking, 'max'); assert.equal(CANDIDATES.sol.thinking,'high');
  assert.equal(validatePolicy(policy()).mode,'balanced'); validateTask(task);
  assert.throws(()=>validateTask({...task,requestId:'../escape'}));
  for(const bad of [-1,NaN,Infinity,11]){const p=policy();p.jev.budgetUsd=bad;assert.throws(()=>validatePolicy(p));}
});
test('no evidence never downgrades Sol despite high Jev probability', () => {
  assert.equal(selectCandidate(task,policy(),{glm:[]},good).candidate,'sol');
  assert.equal(selectCandidate(task,policy(),cards,good).candidate,'glm');
  assert.equal(selectCandidate({...task,role:'reviewer'},policy(),cards,good).candidate,'sol');
  assert.equal(selectCandidate({...task,taskClass:'engineering'},policy(),cards,good).candidate,'sol');
});
test('record/shadow retain baseline; ambiguity and design return parent', () => {
  assert.equal(selectCandidate(task,{...policy(),mode:'record'},cards,good).candidate,'sol');
  assert.equal(selectCandidate(task,{...policy(),mode:'shadow'},cards,good).candidate,'sol');
  assert.equal(selectCandidate(task,{...policy(),mode:'shadow'},cards,{...good,needs_design:0.99}).candidate,'sol');
  assert.equal(selectCandidate(task,policy(),cards,{...good,needs_design:0.9}).candidate,null);
  assert.equal(selectCandidate({...task,taskClass:'design'},policy(),cards,good).candidate,null);
  assert.equal(selectCandidate({...task,candidate:'glm'},policy(),{},null).candidate,'glm');
  assert.throws(()=>selectCandidate({...task,candidate:'glm',role:'reviewer'},policy(),{},null));
});
test('typed request uses pinned profiles; secrets redacted; bad judgments rejected', () => {
  const req=makeRequest({...task,brief:'Bearer '+ 'x'.repeat(30)},cards);
  assert.equal(req.state.candidates.glm.thinking,'max'); assert.match(req.state.task.brief,/REDACTED/);
  assert.deepEqual(Object.keys(req.questions),['needs_design','glm_can_complete','sol_can_complete']);
  assert.equal(parseJudgment(response()).inputTokens,1000);
  for(const mutate of [r=>r.model='jev-latest',r=>r.answers.glm_can_complete.noul=2,r=>delete r.answers.sol_can_complete,r=>r.usage.input_tokens=-1]){const r=response();mutate(r);assert.throws(()=>parseJudgment(r));}
});
test('Jev budget persists across calls/restart and uses fixed endpoint without retries', async t => {
  const dir=fixture(t),ledgerFile=path.join(dir,'budget.json');let count=0;
  const args={request:makeRequest(task,cards),key:'fixture',policy:{budgetUsd:0.01,maxCalls:1,timeoutMs:1000},ledgerFile,
    fetchImpl:async(url,init)=>{count++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.redirect,'error');return new Response(JSON.stringify(response()));}};
  await callJev(args); assert.equal(readJson(ledgerFile).calls,1);
  assert.ok(Math.abs(readJson(ledgerFile).chargedUsd-0.000042)<1e-9);
  await assert.rejects(callJev(args),/ngân sách/);assert.equal(count,1);
});
test('unknown failed request stays reserved; zero budget never calls network', async t => {
  const ledgerFile=path.join(fixture(t),'budget.json');let count=0;
  const args={request:makeRequest(task,cards),key:'fixture',policy:{budgetUsd:0,maxCalls:3,timeoutMs:1000},ledgerFile,fetchImpl:async()=>{count++;throw new Error('provider response contains secret');}};
  await assert.rejects(callJev(args)); assert.equal(count,0);
  args.policy.budgetUsd=0.01;await assert.rejects(callJev(args),e=>!e.message.includes('secret'));
  assert.equal(count,1);assert.ok(readJson(ledgerFile).chargedUsd>0);assert.equal(Object.keys(readJson(ledgerFile).pending).length,1);
});
test('audit excludes raw prompts, credentials and result bodies', t => {
  const dir=fixture(t);appendAudit(dir,{jobId:'123',status:'completed',brief:'PRIVATE',key:'PRIVATE',result:'PRIVATE'});
  assert.ok(!fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').includes('PRIVATE'));
});
function bus(){const map=new Map();return{on:(n,fn)=>{if(!map.has(n))map.set(n,new Set());map.get(n).add(fn);return()=>map.get(n).delete(fn);},emit:(n,p)=>{for(const fn of [...(map.get(n)??[])])fn(p);}};}
test('RPC consumes completion synchronously even before spawn reply', async () => {
  const events=bus();let consumed=false;
  events.on('subagents:rpc:ping',r=>events.emit('subagents:rpc:ping:reply:'+r.requestId,{success:true,data:{version:2}}));
  events.on('subagents:rpc:consume',()=>{consumed=true;});
  events.on('subagents:rpc:spawn',r=>{
    r.options.onSpawned('child');events.emit('subagents:completed',{id:'child',status:'completed',result:'OK'});
    assert.equal(consumed,true);events.emit('subagents:rpc:spawn:reply:'+r.requestId,{success:true,data:{id:'child'}});
  });
  const result=await spawnAndJoin(events,'researcher','brief',{}, {timeoutMs:1000});assert.equal(result.result,'OK');
});
test('RPC cancellation stops the exact child', async () => {
  const events=bus(),controller=new AbortController();let stopped;
  events.on('subagents:rpc:ping',r=>events.emit('subagents:rpc:ping:reply:'+r.requestId,{success:true,data:{}}));
  events.on('subagents:rpc:stop',r=>{stopped=r.agentId;});
  events.on('subagents:rpc:spawn',r=>{r.options.onSpawned('child');events.emit('subagents:rpc:spawn:reply:'+r.requestId,{success:true,data:{id:'child'}});controller.abort();});
  await assert.rejects(spawnAndJoin(events,'worker','brief',{}, {signal:controller.signal,timeoutMs:1000}),/hủy/);assert.equal(stopped,'child');
});
