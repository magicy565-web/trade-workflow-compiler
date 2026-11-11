import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { EventInbox, verifyWebhook, webhookSignature } from '../dist/events.js';
import { setup,actor,approver,reply,output } from './helpers.mjs';
import { batchSetup } from './v02-helpers.mjs';
const evt=(t,id,from=reply.from)=>({id,tenantId:actor.tenantId,type:'buyer.reply_received',correlationId:'fixture-thread-1',payload:{...reply,from},receivedAt:t.now()});
test('early reply remains unmatched until a real receipt binds its run',async()=>{const t=setup();try{
 const inbox=new EventInbox(t.store);assert.equal(t.store.ingest(evt(t,'early'),actor).state,'unmatched');await t.until('WAITING_APPROVAL');t.approve();await t.until('COMPLETED');assert.equal(inbox.get(actor.tenantId,'early').state,'consumed');
}finally{t.store.close();}});
test('wrong sender is quarantined without failing or advancing a waiting run',async()=>{const t=setup();try{
 await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');const e=evt(t,'wrong-sender','someone-else@fixture.invalid');assert.equal(t.store.ingest(e,actor).state,'quarantined');
 t.advance();assert.equal((await t.engine.tick(actor.tenantId,t.run.id)).status,'WAITING_EVENT');const inbox=new EventInbox(t.store);assert.equal(inbox.recheck(actor.tenantId,e.id,actor).state,'quarantined');
 t.store.ingest(evt(t,'right-sender'),actor);await t.until('COMPLETED');assert.equal(inbox.get(actor.tenantId,'right-sender').state,'consumed');
}finally{t.store.close();}});
test('wrong sender arriving before receipt is quarantined when the receipt is registered',async()=>{const t=setup();try{
 assert.equal(t.store.ingest(evt(t,'wrong-early','other@fixture.invalid'),actor).state,'unmatched');await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');assert.equal(new EventInbox(t.store).get(actor.tenantId,'wrong-early').state,'quarantined');
}finally{t.store.close();}});
test('provider correlation collision across runs fails closed after external dispatch',async()=>{
 const t=await batchSetup({alter(req,result){if(req.capability.id==='outreach.send')result.correlationId='provider-reused-id';return result;}});try{
  await t.ready();const b=t.create(),children=t.batches.members(actor.tenantId,b.id);for(const c of children){await t.childUntil(c.id,'WAITING_APPROVAL');t.approveChild(c.id);}
  await t.childUntil(children[0].id,'WAITING_EVENT');const r=await t.childUntil(children[1].id,'NEEDS_RECONCILIATION');assert.equal(r.error,'CORRELATION_CONFLICT');assert.equal(t.store.verifyAudit(),true);
 }finally{t.store.close();}
});
test('gateway receipt for a different email is rejected before waiting for replies',async()=>{
 const t=await batchSetup({alter(req,result){if(req.capability.id==='outreach.send')result.receipts[0].recipient='wrong@fixture.invalid';return result;}});try{
 await t.ready();const c=t.batches.members(actor.tenantId,t.create().id)[0];await t.childUntil(c.id,'WAITING_APPROVAL');t.approveChild(c.id);const r=await t.childUntil(c.id,'NEEDS_RECONCILIATION');assert.equal(r.error,'RECEIPT_RECIPIENT');
 }finally{t.store.close();}
});
test('late replies to closed runs are retained for human review, not treated as new work',async()=>{const t=setup();try{
 await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');t.store.ingest(evt(t,'first'),actor);await t.until('COMPLETED');assert.equal(t.store.ingest(evt(t,'late'),actor).state,'quarantined');
 assert.equal(new EventInbox(t.store).list(actor.tenantId).items.length,2);
}finally{t.store.close();}});
test('event inbox pagination is tenant scoped, complete and non-overlapping',()=>{const t=setup();try{
 for(let i=0;i<5;i++)t.store.ingest(evt(t,'page-'+i),actor);const inbox=new EventInbox(t.store);let page=inbox.list(actor.tenantId,undefined,2);let ids=page.items.map(i=>i.event.id);
 while(page.nextCursor){page=inbox.list(actor.tenantId,page.nextCursor,2);ids.push(...page.items.map(i=>i.event.id));}assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);assert.deepEqual(inbox.list('other').items,[]);assert.throws(()=>inbox.get('other',ids[0]),e=>e.httpStatus===404);assert.throws(()=>inbox.list(actor.tenantId,0),/cursor/);
}finally{t.store.close();}});
test('invalid event schema is rejected at store boundary, not left to poison a run',()=>{const t=setup();try{
 assert.throws(()=>t.store.ingest({...evt(t,'bad'),payload:{}},actor),e=>e.code==='EVENT_CONTRACT');assert.equal(new EventInbox(t.store).list(actor.tenantId).items.length,0);
}finally{t.store.close();}});
test('signed webhooks bind raw body, source id and timestamp; key and replay-window checks are mandatory',()=>{
 const source={id:'fixture',tenantId:'test-tenant',enabled:true,secretEnv:'TWC_TEST_INGRESS_SECRET'};process.env[source.secretEnv]='s'.repeat(48);const raw=Buffer.from('{"fixture":true}'),timestamp=String(Math.floor(Date.now()/1000));const signature='sha256='+webhookSignature(process.env[source.secretEnv],source.id,timestamp,raw);
 try{
  assert.doesNotThrow(()=>verifyWebhook(source,timestamp,signature,raw));
  assert.throws(()=>verifyWebhook(source,timestamp,signature,Buffer.from('{}')),e=>e.httpStatus===401);
  assert.throws(()=>verifyWebhook({...source,id:'another'},timestamp,signature,raw),e=>e.httpStatus===401);
  assert.throws(()=>verifyWebhook(source,timestamp,signature,raw,Date.now()+301000),e=>e.httpStatus===401);
  assert.throws(()=>verifyWebhook({...source,enabled:false},timestamp,signature,raw),e=>e.httpStatus===404);
  process.env[source.secretEnv]='short';assert.throws(()=>verifyWebhook(source,timestamp,signature,raw),e=>e.httpStatus===503);
 }finally{delete process.env[source.secretEnv];}
});
test('v1-shaped database migration preserves run, pending event and audit, reopens safely and rejects unknown schema',()=>{
 const dir=mkdtempSync(join(tmpdir(),'twc-migration-')),path=join(dir,'twc.sqlite');const t=setup({path});let reopened;
 try{
  const before=t.store.getRun(actor.tenantId,t.run.id);t.store.ingest(evt(t,'migration-event'),actor);
  t.store.db.exec("DROP TABLE followup_history; DROP TABLE followups; DROP TABLE batches; DROP TABLE batch_members; DROP TABLE correlations; DROP TABLE event_routes; UPDATE metadata SET value='1' WHERE key='schema_version';");t.store.close();
  reopened=new Store(path);assert.equal(reopened.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'4');assert.deepEqual(reopened.getRun(actor.tenantId,t.run.id),before);assert.equal(new EventInbox(reopened).get(actor.tenantId,'migration-event').state,'unmatched');assert.equal(reopened.verifyAudit(),true);
  reopened.close();reopened=new Store(path);assert.equal(new EventInbox(reopened).list(actor.tenantId).items.length,1);
  reopened.db.exec("UPDATE metadata SET value='99' WHERE key='schema_version'");reopened.close();reopened=undefined;assert.throws(()=>new Store(path),e=>e.code==='DB_VERSION');
 }finally{try{reopened?.close();}catch{}try{t.store.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
test('additional replies received before completion are retained and moved to human review',async()=>{const t=setup();try{
 await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');t.store.ingest(evt(t,'a-first'),actor);t.store.ingest({...evt(t,'b-second'),payload:{...reply,messageId:'second'}},actor);await t.until('COMPLETED');
 const items=new EventInbox(t.store).list(actor.tenantId).items;assert.equal(items.filter(i=>i.state==='consumed').length,1);assert.equal(items.filter(i=>i.state==='quarantined').length,1);
}finally{t.store.close();}});
