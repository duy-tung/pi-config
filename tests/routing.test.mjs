import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_POLICY, validatePolicy, validateTask, selectCandidate, spawnAndJoin, CANDIDATES } from '../assets/extensions/pi-dispatch-router/core.mjs';
import { appendAudit, claimWriter } from '../assets/extensions/pi-dispatch-router/storage.mjs';

const task = { requestId: 'r1', role: 'researcher', taskClass: 'lookup', candidate: 'auto', brief: 'Tìm hàm xử lý timeout.', acceptance: 'Nêu file và dòng từ source; không sửa.' };
const policy = () => ({ ...structuredClone(DEFAULT_POLICY), mode: 'manual' });
const fixture = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-router-unit-')); t.after(() => fs.rmSync(p,{recursive:true,force:true})); return p; };
test('fixed candidates pin GLM max and Sol high; invalid policy/task fail closed', () => {
  assert.equal(CANDIDATES.glm.thinking, 'max'); assert.equal(CANDIDATES.sol.thinking,'high');
  assert.equal(validatePolicy(policy()).mode,'manual'); validateTask(task);
  validateTask({...task,taskClass:undefined});
  assert.throws(()=>validateTask({...task,requestId:'../escape'}));
  for(const timeoutMs of [-1,NaN,Infinity,1800001])assert.throws(()=>validatePolicy({...policy(),timeoutMs}));
  for(const mode of ['record','shadow','balanced','unknown'])assert.throws(()=>validatePolicy({...policy(),mode}));
});
test('legacy policies normalize to manual and drop every retired field',()=>{
  for(const mode of ['off','record','manual','shadow','balanced']) {
    const old={...policy(),version:1,mode,jev:{enabled:true,budgetUsd:10,maxCalls:1000},
      thresholds:{},glmAutoClasses:['lookup'],cacheTtlMs:1000,typesafeKeyFile:'/unused',writerLocksDir:'/locks'};
    const current=validatePolicy(old);
    assert.deepEqual(current,{version:2,mode:mode==='off'?'off':'manual',allowExplicitGlm:true,timeoutMs:900000,writerLocksDir:'/locks'});
    assert.equal(old.mode,mode);
    assert.equal(selectCandidate(task,current).candidate,'sol');
  }
});
test('default selection needs no classification; GLM requires explicit choice; design stays parent', () => {
  assert.equal(selectCandidate(task,policy()).candidate,'sol');
  assert.equal(selectCandidate({...task,taskClass:undefined},policy()).candidate,'sol');
  assert.equal(selectCandidate({...task,candidate:'sol'},policy()).source,'explicit');
  assert.equal(selectCandidate({...task,candidate:'glm'},policy()).candidate,'glm');
  assert.equal(selectCandidate({...task,taskClass:'design',candidate:'glm'},policy()).candidate,null);
  assert.throws(()=>selectCandidate({...task,candidate:'glm',role:'reviewer'},policy()));
  assert.throws(()=>selectCandidate({...task,candidate:'glm'},{...policy(),allowExplicitGlm:false}));
});
test('audit excludes raw prompts, credentials and result bodies', t => {
  const dir=fixture(t);appendAudit(dir,{jobId:'123',status:'completed',brief:'PRIVATE',key:'PRIVATE',result:'PRIVATE'});
  assert.ok(!fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').includes('PRIVATE'));
});
test('workspace writers serialize across router instances and release on completion',t=>{
  const dir=fixture(t),locks=path.join(dir,'routing-writers');
  const release=claimWriter(locks,dir,'job-a');
  assert.throws(()=>claimWriter(locks,dir,'job-b'),/writer/);release();
  const releaseB=claimWriter(locks,dir,'job-b');release();
  assert.throws(()=>claimWriter(locks,dir,'job-c'),/writer/);releaseB();
  const releaseC=claimWriter(locks,dir,'job-c');releaseC();
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
test('queued timeout stops and consumes the queued child before it can start', async () => {
  const events=bus();let stopped,consumed=false,spawnReply;
  events.on('subagents:rpc:ping',r=>events.emit('subagents:rpc:ping:reply:'+r.requestId,{success:true,data:{}}));
  events.on('subagents:rpc:consume',()=>{consumed=true;});
  events.on('subagents:rpc:stop',r=>{stopped=r.agentId;events.emit('subagents:failed',{id:r.agentId,status:'stopped'});events.emit('subagents:rpc:spawn:reply:'+spawnReply,{success:false});});
  events.on('subagents:rpc:spawn',r=>{spawnReply=r.requestId;r.options.onQueued('queued-child',2);});
  await assert.rejects(spawnAndJoin(events,'worker','brief',{}, {timeoutMs:20}),/hủy/);
  assert.equal(stopped,'queued-child');assert.equal(consumed,true);
});
