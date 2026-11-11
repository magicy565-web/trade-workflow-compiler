import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { Batches } from '../dist/batches.js';
import { Engine } from '../dist/runtime/engine.js';
import { EventInbox } from '../dist/events.js';
import { batchSetup, actor, approver, twoBuyers, reply } from './v02-helpers.mjs';

async function withBatch(fn,options){const t=await batchSetup(options);try{await t.ready();await fn(t);}finally{t.store.close();}}
test('multiple qualified buyers park before drafting; repeated ticks do not dispatch',()=>withBatch(async t=>{
  for(let i=0;i<3;i++) await t.engine.tick(actor.tenantId,t.run.id);
  assert.equal(t.calls.length,3);assert.equal(t.store.getRun(actor.tenantId,t.run.id).status,'BATCH_READY');
}));
test('fan-out shares immutable approved spec but restricts each qualified input to one recipient',()=>withBatch(async t=>{
  const b=t.create(),children=t.batches.members(actor.tenantId,b.id);assert.equal(children.length,2);
  for(const r of children){assert.deepEqual(r.spec,t.spec);assert.equal(r.steps.qualify.output.buyers.length,1);assert.equal(r.steps.qualify.inheritedFromRunId,t.run.id);assert.equal(r.reservedMicros,0);assert.equal(r.sourceRunId,t.run.id);}
  assert.equal(t.store.getRun(actor.tenantId,t.run.id).status,'CANCELLED');assert.equal(b.reservedMicros,1500000);
}));
test('same batch key is idempotent; changed recipients or second fan-out is rejected',()=>withBatch(async t=>{
  const first=t.create();assert.equal(t.create().id,first.id);assert.throws(()=>t.create([twoBuyers[0].contactEmail]),/different recipients/);
  assert.throws(()=>t.create(undefined,'batch-different-key-0001'),/already fanned out/);assert.equal(t.batches.members(actor.tenantId,first.id).length,2);
}));
test('batch budget includes parent research and all selected downstream worst cases',()=>withBatch(async t=>{
  assert.throws(()=>t.create(),e=>e.code==='BATCH_BUDGET');assert.equal(t.store.listRuns().length,1);assert.equal(t.batches.list(actor.tenantId).length,0);
},{budgetMicros:6000000}));
test('fan-out transaction is all-or-nothing on a mid-insert failure',()=>withBatch(async t=>{
  t.store.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON batch_members WHEN NEW.target_email='test@fixture.invalid' BEGIN SELECT RAISE(ABORT,'fixture fault'); END;");
  assert.throws(()=>t.create(),/fixture fault/);assert.equal(t.store.listRuns().length,1);assert.equal(t.batches.list(actor.tenantId).length,0);assert.equal(t.store.getRun(actor.tenantId,t.run.id).status,'BATCH_READY');assert.equal(t.store.verifyAudit(),true);
}));
test('suppressed contacts are excluded; all selections are validated before insertion',()=>withBatch(async t=>{
  t.store.suppress(actor.tenantId,twoBuyers[1].contactEmail,'fixture suppression',actor);
  const p=t.batches.preview(actor.tenantId,t.run.id);assert.equal(p.buyers.filter(b=>b.eligible).length,1);
  assert.throws(()=>t.create(),/suppressed/);assert.equal(t.store.listRuns().length,1);
  assert.equal(t.batches.members(actor.tenantId,t.create([twoBuyers[0].contactEmail]).id).length,1);
}));
test('duplicate contact emails are not silently assigned to an arbitrary buyer',()=>withBatch(t=>{
  assert.equal(t.batches.preview(actor.tenantId,t.run.id).buyers.every(b=>!b.eligible),true);assert.throws(()=>t.create([twoBuyers[0].contactEmail]),/duplicated/);
},{buyers:[twoBuyers[0],{...twoBuyers[1],contactEmail:twoBuyers[0].contactEmail.toUpperCase()}]}));
test('missing emails remain visible and ineligible in batch preview',()=>withBatch(t=>{
  const p=t.batches.preview(actor.tenantId,t.run.id);assert.equal(p.buyers[1].reason,'Missing contact email');
},{buyers:[twoBuyers[0],Object.fromEntries(Object.entries(twoBuyers[1]).filter(([k])=>k!=='contactEmail'))]}));
test('batch creation is tenant and role scoped',()=>withBatch(t=>{
  assert.throws(()=>t.batches.get('another','does-not-exist'),e=>e.httpStatus===404);
  assert.throws(()=>t.batches.create(actor.tenantId,t.run.id,[twoBuyers[0].contactEmail],'role-fixture-000001',approver,t.reg),e=>e.httpStatus===403);
}));
test('capability drift blocks fan-out even if the source was previously approved',()=>withBatch(t=>{
  const reg={...t.reg,get:id=>{const c=t.reg.get(id);return c?{...c,enabled:false}:undefined;}};
  assert.throws(()=>t.batches.create(actor.tenantId,t.run.id,[twoBuyers[0].contactEmail],'drift-fixture-00001',actor,reg),e=>e.code==='COMPILE_BLOCKED');
}));
test('two recipients have separate exact-content approvals and independent replies',()=>withBatch(async t=>{
  const batch=t.create(),children=t.batches.members(actor.tenantId,batch.id);
  for(const child of children)await t.childUntil(child.id,'WAITING_APPROVAL');
  assert.equal(t.calls.filter(c=>c.capability.effect==='external').length,0);
  t.approveChild(children[0].id);const sent=await t.childUntil(children[0].id,'WAITING_EVENT');
  assert.equal(t.store.getRun(actor.tenantId,children[1].id).status,'WAITING_APPROVAL');
  t.store.ingest({id:'only-first',tenantId:actor.tenantId,type:'buyer.reply_received',correlationId:sent.steps.send.output.correlationId,payload:{...reply,from:sent.targetEmail},receivedAt:t.now()},actor);
  await t.childUntil(children[0].id,'COMPLETED');assert.equal(t.store.getRun(actor.tenantId,children[1].id).status,'WAITING_APPROVAL');
  t.approveChild(children[1].id);const other=await t.childUntil(children[1].id,'WAITING_EVENT');
  t.store.ingest({id:'only-second',tenantId:actor.tenantId,type:'buyer.reply_received',correlationId:other.steps.send.output.correlationId,payload:{...reply,from:other.targetEmail,messageId:'second-message'},receivedAt:t.now()},actor);
  await t.childUntil(children[1].id,'COMPLETED');const view=t.batches.view(actor.tenantId,batch.id);
  assert.equal(view.status,'FINISHED');assert.equal(view.counts.COMPLETED,2);assert.equal(t.calls.filter(c=>c.capability.id==='market.research').length,1);assert.equal(t.calls.filter(c=>c.capability.id==='outreach.send').length,2);
  assert.equal(view.batch.reservedMicros,4500000);assert.equal(view.batch.actualMicros,900);assert.equal(t.store.verifyAudit(),true);
}));
test('a malicious drafting worker cannot redirect a batch recipient',()=>withBatch(async t=>{
  const b=t.create();const child=t.batches.members(actor.tenantId,b.id)[0];const failed=await t.childUntil(child.id,'FAILED');assert.equal(failed.error,'RECIPIENT_SCOPE');assert.equal(t.store.listApprovals(actor.tenantId).length,0);
},{alter:(req,result)=>{if(req.capability.id==='outreach.draft')result.messages[0].to='attacker@fixture.invalid';return result;}}));
test('batch pause stops pending work, resume preserves state, cancellation cannot resume',()=>withBatch(async t=>{
  const b=t.create(),child=t.batches.members(actor.tenantId,b.id)[0];t.batches.control(actor.tenantId,b.id,'paused',actor);
  const calls=t.calls.length;await t.engine.tick(actor.tenantId,child.id);assert.equal(t.calls.length,calls);
  t.batches.control(actor.tenantId,b.id,'active',actor);await t.childUntil(child.id,'WAITING_APPROVAL');
  t.batches.control(actor.tenantId,b.id,'cancelled',actor);assert.equal(t.batches.members(actor.tenantId,b.id).every(r=>r.status==='CANCELLED'),true);
  assert.throws(()=>t.batches.control(actor.tenantId,b.id,'active',actor),/cannot resume/);
}));
test('shared budget is checked atomically when independent children dispatch',()=>withBatch(async t=>{
  const b=t.create();t.store.transaction(()=>{const batch=t.batches.get(actor.tenantId,b.id);batch.reservedMicros=batch.budgetMicros-500000;t.batches.putInside(batch);});
  const children=t.batches.members(actor.tenantId,b.id);await Promise.all(children.map(r=>t.engine.tick(actor.tenantId,r.id)));
  assert.equal(t.calls.filter(c=>c.capability.id==='outreach.draft').length,1);assert.equal(t.batches.get(actor.tenantId,b.id).reservedMicros,b.budgetMicros);
}));
test('uncertain action pauses batch, never auto-resends and blocks premature resume',()=>withBatch(async t=>{
  const b=t.create(),child=t.batches.members(actor.tenantId,b.id)[0];await t.childUntil(child.id,'WAITING_APPROVAL');t.approveChild(child.id);
  await t.childUntil(child.id,'NEEDS_RECONCILIATION');for(let i=0;i<5;i++)await t.engine.tick(actor.tenantId,child.id);
  assert.equal(t.calls.filter(c=>c.capability.id==='outreach.send').length,1);assert.throws(()=>t.batches.control(actor.tenantId,b.id,'active',actor),/Resolve uncertain/);
},{failSend:true}));
test('batch and approval survive closing and reopening SQLite',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'twc-v02-'));const t=await batchSetup({path:join(dir,'twc.sqlite')});let reopened;
  try{
    await t.ready();const b=t.create(),child=t.batches.members(actor.tenantId,b.id)[0];await t.childUntil(child.id,'WAITING_APPROVAL');t.approveChild(child.id);
    const before=t.store.getRun(actor.tenantId,child.id);t.store.close();reopened=new Store(join(dir,'twc.sqlite'));assert.deepEqual(reopened.getRun(actor.tenantId,child.id),before);
    const e=new Engine(reopened,t.reg,{http:{async execute(req){return {status:'completed',output:{correlationId:'restart-thread',receipts:[{recipient:req.input.messages[0].to,providerId:'restart-fixture',acceptedAt:new Date().toISOString()}]}};}}},()=>t.now()+10000);
    await e.tick(actor.tenantId,child.id);await e.tick(actor.tenantId,child.id);assert.equal(reopened.getRun(actor.tenantId,child.id).current,'wait');assert.equal(new Batches(reopened).members(actor.tenantId,b.id).length,2);assert.equal(reopened.verifyAudit(),true);
  }finally{if(reopened)reopened.close();else try{t.store.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('modified runtime workflow cannot bypass its published version hash',()=>withBatch(t=>{
 t.store.mutateRun(actor.tenantId,t.run.id,r=>{r.spec.context.budgetMicros+=1000000;});assert.throws(()=>t.create(),e=>e.code==='WORKFLOW_INTEGRITY');
}));
test('child runs inherit the original authorization deadline instead of resetting the business window',()=>withBatch(async t=>{
 const batch=t.create(),child=t.batches.members(actor.tenantId,batch.id)[0];assert.equal(child.deadlineAt,t.run.createdAt+t.spec.policy.maxRunSeconds*1000);
 t.advance(t.spec.policy.maxRunSeconds*1000+1);assert.equal((await t.engine.tick(actor.tenantId,child.id)).status,'TIMED_OUT');assert.equal(t.calls.filter(c=>c.capability.id==='outreach.draft').length,0);
}));
test('empty qualified buyer set terminates without inventing contacts or requesting approval',async()=>{
 const t=await batchSetup({buyers:[]});try{const r=await t.until('COMPLETED');assert.match(r.error,/No qualified buyers/);assert.equal(t.store.listApprovals(actor.tenantId).length,0);assert.equal(t.calls.length,3);}finally{t.store.close();}
});
