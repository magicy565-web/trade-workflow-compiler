// Synthetic fixtures only; no real mail or supplier is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, actor, reply, evidence } from './helpers.mjs';
import { Store } from '../dist/store.js';
import { Followups } from '../dist/followups.js';
import { EventInbox } from '../dist/events.js';
import { Outcomes } from '../dist/outcomes.js';
import { hash } from '../dist/util.js';

export async function closedFixture(options={}) {
 const t=setup(options);await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');
 const event=(id,extra={})=>({id,tenantId:actor.tenantId,type:'buyer.reply_received',correlationId:'fixture-thread-1',payload:{...reply,messageId:id},receivedAt:t.now(),...extra});
 t.store.ingest(event('first-reply'),actor);await t.until('COMPLETED');
 return {...t,event,followups:new Followups(t.store)};
}
const note='Synthetic test: reviewed the reply and recorded the next step.';
const change=(t,f,action,extra={},person=actor)=>t.followups.update(actor.tenantId,f.id,{expectedVersion:f.version,action,note,...extra},person);
const add=(t,id='second-reply',extra={})=>{t.store.ingest(t.event(id,extra),actor);return t.followups.list(actor.tenantId).items.find(f=>f.eventId===id);};

test('late sample updates use their own receipt and uncertain dispatches do not become ordinary follow-ups',async()=>{
 const t=setup({playbook:'sample-followup'});try{
  await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');
  const event=id=>({id,tenantId:actor.tenantId,type:'sample.update',correlationId:'fixture-sample-1',payload:{status:'received',note:'SYNTHETIC SAMPLE UPDATE',evidence},receivedAt:t.now()});
  t.store.ingest(event('sample-first'),actor);await t.until('COMPLETED');t.store.ingest(event('sample-later'),actor);
  assert.equal(new Followups(t.store).list(actor.tenantId).items[0].eventId,'sample-later');
 }finally{t.store.close();}
 const u=await closedFixture();try{
  u.store.mutateRun(actor.tenantId,u.run.id,r=>{r.status='NEEDS_RECONCILIATION';});
  add(u,'uncertain');assert.equal(u.followups.summary(actor.tenantId).active,0);
 }finally{u.store.close();}
});

test('late replies create one persistent human task without consuming events or dispatching again',async()=>{
 const t=await closedFixture();try{
  const before=t.store.getRun(actor.tenantId,t.run.id),calls=t.calls.length;
  const f=add(t);assert.equal(f.state,'open');assert.equal(f.ownerId,null);assert.equal(f.dueAt,null);
  add(t);new EventInbox(t.store).recheck(actor.tenantId,f.eventId,actor);
  assert.equal(t.followups.list(actor.tenantId).items.length,1);
  assert.equal(new EventInbox(t.store).get(actor.tenantId,f.eventId).state,'quarantined');
  assert.equal(new EventInbox(t.store).get(actor.tenantId,f.eventId).event.consumedBy,undefined);
  await t.engine.tick(actor.tenantId,t.run.id);
  assert.deepEqual(t.store.getRun(actor.tenantId,t.run.id),before);assert.equal(t.calls.length,calls);
  assert.equal(t.followups.get(actor.tenantId,f.id).eventHash,hash(t.event('second-reply')));
 }finally{t.store.close();}
});
test('wrong sender, unknown correlation and pre-run events never become follow-up tasks',async()=>{
 const t=await closedFixture();try{
  add(t,'wrong',{payload:{...reply,from:'wrong@fixture.invalid'}});
  add(t,'unmatched',{correlationId:'unknown-thread'});
  add(t,'old',{receivedAt:t.run.createdAt-1});
  assert.equal(t.followups.summary(actor.tenantId).active,0);
 }finally{t.store.close();}
});
test('events received while first reply is processing enter follow-ups when the run closes',async()=>{
 const t=setup();try{
  await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');
  for(const id of ['reply-a','reply-b'])t.store.ingest({id,tenantId:actor.tenantId,type:'buyer.reply_received',correlationId:'fixture-thread-1',payload:reply,receivedAt:t.now()},actor);
  assert.equal(new Followups(t.store).list(actor.tenantId).items.length,0);
  await t.until('COMPLETED');
  assert.equal(new Followups(t.store).list(actor.tenantId).items[0].eventId,'reply-b');
 }finally{t.store.close();}
});
test('claim, schedule, close and reopen keep ownership, notes and immutable revision history',async()=>{
 const t=await closedFixture();try{
  let f=add(t);assert.throws(()=>change(t,f,'resolve'),e=>e.code==='FOLLOWUP_UNASSIGNED');
  f=change(t,f,'claim');assert.equal(f.ownerId,actor.userId);
  const dueAt=new Date(Date.now()+3600000).toISOString();
  f=change(t,f,'schedule',{dueAt,nextAction:'Prepare the next reviewed quotation'});
  assert.equal(t.followups.summary(actor.tenantId,Date.parse(dueAt)+1).overdue,1);
  f=change(t,f,'resolve');assert.equal(t.followups.summary(actor.tenantId).active,0);
  assert.throws(()=>change(t,f,'schedule',{dueAt,nextAction:'Prepare quotation'}),e=>e.code==='FOLLOWUP_STATE');
  f=change(t,f,'reopen');assert.equal(f.state,'in_progress');
  f=change(t,f,'dismiss');assert.equal(f.state,'dismissed');
  assert.deepEqual(t.followups.history(actor.tenantId,f.id).map(h=>h.action),['created','claim','schedule','resolve','reopen','dismiss']);
  assert.equal(t.store.verifyAudit(),true);
  const dossier=new Outcomes(t.store).dossier(actor.tenantId,t.run.id);
  assert.equal(dossier.manifest.followups[0].history.length,6);assert.equal(dossier.manifestSha256,hash(dossier.manifest));
  assert.equal(new Outcomes(t.store).summary(actor.tenantId).claimsPendingReview,0);
 }finally{t.store.close();}
});
test('stale edits, non-owners and cross-tenant actors cannot change follow-up state',async()=>{
 const t=await closedFixture();try{
  const original=add(t);let f=change(t,original,'claim');
  assert.throws(()=>change(t,original,'dismiss'),e=>e.code==='FOLLOWUP_STALE');
  assert.throws(()=>change(t,f,'claim',{}, {...actor,userId:'another-operator'}),e=>e.code==='FOLLOWUP_OWNER');
  for(const role of ['viewer','worker','ingest','approver'])assert.throws(()=>change(t,f,'resolve',{}, {...actor,role}),e=>e.code==='FORBIDDEN');
  assert.throws(()=>change(t,f,'resolve',{}, {...actor,tenantId:'other'}),e=>e.code==='FORBIDDEN');
  assert.throws(()=>t.followups.get('other',f.id),e=>e.code==='NOT_FOUND');
  assert.equal(t.followups.list('other').items.length,0);
  f=change(t,f,'claim',{}, {...actor,role:'admin',userId:'admin-owner'});assert.equal(f.ownerId,'admin-owner');
 }finally{t.store.close();}
});
test('invalid scheduling and ambiguous changes fail without modifying records',async()=>{
 const t=await closedFixture();try{
  const f=change(t,add(t),'claim');
  for(const extra of [{},{dueAt:'bad',nextAction:'Call buyer'},{dueAt:new Date(0).toISOString(),nextAction:'Call buyer'},{dueAt:new Date(Date.now()+10000).toISOString(),nextAction:'     '}])
   assert.throws(()=>change(t,f,'schedule',extra));
  assert.throws(()=>change(t,f,'resolve',{nextAction:'Ambiguous change'}),e=>e.code==='FOLLOWUP_FIELDS');
  assert.throws(()=>change(t,f,'resolve',{note:'          '}),e=>e.code==='FOLLOWUP_NOTE');
  assert.throws(()=>change(t,f,'resolve',{ownerId:'another'}),e=>e.code==='FOLLOWUP_SCHEMA');
  assert.deepEqual(t.followups.get(actor.tenantId,f.id),f);
 }finally{t.store.close();}
});
test('follow-up paging and totals include all records rather than just the displayed page',async()=>{
 const t=await closedFixture();try{
  for(let i=0;i<105;i++)add(t,'late-'+i);
  const first=t.followups.list(actor.tenantId,'active',undefined,100);
  const rest=t.followups.list(actor.tenantId,'active',first.nextCursor,100);
  assert.equal(first.items.length,100);assert.equal(rest.items.length,5);assert.equal(rest.nextCursor,null);
  assert.equal(new Set([...first.items,...rest.items].map(f=>f.id)).size,105);
  assert.equal(t.followups.summary(actor.tenantId).unassigned,105);
  assert.throws(()=>t.followups.list(actor.tenantId,'garbage'),e=>e.code==='PAGINATION');
  assert.throws(()=>t.followups.list(actor.tenantId,'active',NaN),e=>e.code==='PAGINATION');
 }finally{t.store.close();}
});
test('event, follow-up and audit inserts roll back together when persistence fails',async()=>{
 const t=await closedFixture();try{
  const count=t.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  t.store.db.exec("CREATE TRIGGER reject_followup BEFORE INSERT ON followup_history BEGIN SELECT RAISE(ABORT,'TEST persistence failure'); END;");
  assert.throws(()=>add(t));
  assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM events WHERE id='second-reply'").get().n,0);
  assert.equal(t.followups.summary(actor.tenantId).active,0);
  assert.equal(t.store.db.prepare('SELECT count(*) AS n FROM audit').get().n,count);
  t.store.db.exec('DROP TRIGGER reject_followup');assert.ok(add(t));
 }finally{t.store.close();}
});
test('schema 3 upgrade backfills eligible replies once and preserves runs and handling after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'twc-followup-')),path=join(dir,'test.sqlite');
 const t=await closedFixture({path});let s;
 try{
  add(t);add(t,'bad-sender',{payload:{...reply,from:'wrong@fixture.invalid'}});
  const run=t.store.getRun(actor.tenantId,t.run.id);
  // Remove only schema-4 objects to reproduce the v0.3 schema for migration testing.
  t.store.db.exec("DROP TABLE followup_history; DROP TABLE followups; UPDATE metadata SET value='3' WHERE key='schema_version';");t.store.close();
  s=new Store(path);let service=new Followups(s);
  assert.equal(s.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'4');
  assert.deepEqual(s.getRun(actor.tenantId,t.run.id),run);assert.equal(service.summary(actor.tenantId).active,1);
  let f=service.list(actor.tenantId).items[0];f=service.update(actor.tenantId,f.id,{expectedVersion:1,action:'claim',note},actor);
  s.close();s=new Store(path);service=new Followups(s);
  assert.deepEqual(service.get(actor.tenantId,f.id),f);assert.equal(service.history(actor.tenantId,f.id).length,2);
  assert.equal(s.verifyAudit(),true);
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('dossier keeps old run approvals even after more than 500 newer approvals exist',async()=>{
 const t=await closedFixture();try{
  const original=t.store.approvalsByRun(actor.tenantId,t.run.id);
  for(let i=0;i<501;i++)t.store.createApproval({...original[0],id:'later-'+i,runId:'other-run-'+i});
  assert.equal(t.store.listApprovals(actor.tenantId).some(a=>a.runId===t.run.id),false);
  assert.deepEqual(new Outcomes(t.store).dossier(actor.tenantId,t.run.id).manifest.approvals,original);
 }finally{t.store.close();}
});
