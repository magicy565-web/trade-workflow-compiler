import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchSetup, actor, approver, twoBuyers, reply } from './v02-helpers.mjs';
import { Outcomes } from '../dist/outcomes.js';
import { Store } from '../dist/store.js';
import { hash } from '../dist/util.js';

const claim=(runId,kind,evidence,key='claim-idempotency-key-0001',extra={})=>({
 runId,kind,evidence,idempotencyKey:key,occurredAt:new Date().toISOString(),...extra
});
const receipt=(node='send')=>({kind:'provider_receipt',reference:node,note:'Verified action result from a test-only gateway'});
const external=(url='https://fixture.invalid/orders/abc')=>({kind:'external_record',reference:url,note:'External document pointer — synthetic test only'});

async function childFixture(){const t=await batchSetup();await t.ready();const created=t.create([twoBuyers[0].contactEmail]);const runId=t.batches.members(actor.tenantId,created.id)[0].id;await t.childUntil(runId,'WAITING_APPROVAL');t.approveChild(runId);await t.childUntil(runId,'WAITING_EVENT');return {...t,runId,ledger:new Outcomes(t.store)};}

// A reviewer confirms only that a documented claim was reviewed, not a financial settlement.
test('outbound result requires a real completed action receipt and independent human review',async()=>{const t=await childFixture();try{
 const input=claim(t.runId,'outreach_sent',receipt());const o=t.ledger.report(actor.tenantId,input,actor);
 assert.equal(o.state,'pending');assert.equal(o.evidenceHash,hash(o.evidence));
 assert.deepEqual(t.ledger.report(actor.tenantId,input,actor),o);
 assert.throws(()=>t.ledger.report(actor.tenantId,{...input,evidence:{...input.evidence,note:'Changed fixture evidence'}},actor),/Idempotency key/);
 assert.throws(()=>t.ledger.report(actor.tenantId,{...input,idempotencyKey:'different-evidence-key-0002'},actor),/already been claimed/);
 assert.throws(()=>t.ledger.decide(actor.tenantId,o.id,o.evidenceHash,true,'Human reviewed an action receipt',actor),/Independent/);
 assert.throws(()=>t.ledger.decide(actor.tenantId,o.id,'0'.repeat(64),true,'Human reviewed an action receipt',approver),/hash/);
 const reviewed=t.ledger.decide(actor.tenantId,o.id,o.evidenceHash,true,'I checked this synthetic receipt and confirmed it is present',approver);
 assert.equal(reviewed.state,'human_reviewed');assert.equal(t.ledger.summary(actor.tenantId).humanReviewedByKind.outreach_sent,1);
 assert.throws(()=>t.ledger.decide(actor.tenantId,o.id,o.evidenceHash,false,'Second review is forbidden',approver),/immutable/);
 assert.equal(t.store.verifyAudit(),true);
}finally{t.store.close();}});

test('no fabricated buyer reply, rejected wrong event, and type cannot masquerade as a provider receipt',async()=>{const t=await childFixture();try{
 const ev=claim(t.runId,'buyer_replied',{kind:'business_event',reference:'unseen-event',note:'This is a deliberately fabricated event'});
 assert.throws(()=>t.ledger.report(actor.tenantId,ev,actor),/Only a consumed event/);
 assert.throws(()=>t.ledger.report(actor.tenantId,claim(t.runId,'order_confirmed',receipt()),actor),/Only dispatch outcomes/);
 assert.throws(()=>t.ledger.report(actor.tenantId,claim(t.runId,'buyer_replied',receipt()),actor),/Only dispatch outcomes/);
 assert.throws(()=>t.ledger.report(actor.tenantId,claim(t.runId,'outreach_sent',external()),actor),/Use an internal action receipt/);
 assert.throws(()=>t.ledger.report('other',claim(t.runId,'order_confirmed',external()),actor),/Operator or admin/);
}finally{t.store.close();}});

test('RFQ outcome only accepts consumed reply event from matching run and classified as RFQ',async()=>{const t=await childFixture();try{
 const run=t.store.getRun(actor.tenantId,t.runId),provider=run.steps.send.output.correlationId;
 const ev={id:'outcome-fixture-event-001',type:'buyer.reply_received',correlationId:provider,payload:{...reply,from:twoBuyers[0].contactEmail},tenantId:actor.tenantId,receivedAt:Date.now()};
 const ingest={tenantId:actor.tenantId,userId:'fixture-gateway',role:'ingest'};
 t.store.ingest(ev,ingest);
 const before=claim(t.runId,'rfq_received',{kind:'business_event',reference:ev.id,note:'Inbox reply is not yet consumed'});
 assert.throws(()=>t.ledger.report(actor.tenantId,before,actor),/Only a consumed event/);
 await t.childUntil(t.runId,'COMPLETED');
 const o=t.ledger.report(actor.tenantId,before,actor);
 assert.equal(o.state,'pending');
 const replyOutcome=t.ledger.report(actor.tenantId,claim(t.runId,'buyer_replied',before.evidence,'separate-reply-claim-0001'),actor);
 assert.equal(replyOutcome.kind,'buyer_replied');
 const dossier=t.ledger.dossier(actor.tenantId,t.runId);
 assert.equal(dossier.manifestSha256,hash(dossier.manifest));
 assert.equal(dossier.manifest.consumedEvents.length,1);
 assert.equal(dossier.manifest.outcomeClaims.length,2);
}finally{t.store.close();}});

test('document-based order remains pending until independent review, amounts never counted as actual revenue',async()=>{const t=await childFixture();try{
 const input=claim(t.runId,'order_confirmed',external(),'order-fixture-claim-0001',{amountMinor:125034,currency:'USD'});
 const o=t.ledger.report(actor.tenantId,input,actor);
 assert.equal(t.ledger.summary(actor.tenantId).humanReviewedOrderValueUsdMinor,0);
 assert.throws(()=>t.ledger.report(actor.tenantId,{...input,idempotencyKey:'order-fixture-claim-0002'},actor),/already been claimed/);
 const d=t.ledger.decide(actor.tenantId,o.id,o.evidenceHash,true,'I reviewed an externally referenced document; settlement not checked',approver);
 assert.equal(d.state,'human_reviewed');
 const total=t.ledger.summary(actor.tenantId);
 assert.equal(total.humanReviewedOrderValueUsdMinor,125034);
 assert.match(total.disclaimer,/not independent validation/);
 assert.throws(()=>t.ledger.report(actor.tenantId,claim(t.runId,'order_confirmed',external('http://localhost/fake'),'invalid-doc-ref-0001'),actor),/HTTPS/);
 assert.throws(()=>t.ledger.report(actor.tenantId,claim(t.runId,'order_confirmed',external(),'invalid-future-date',{occurredAt:'2999-01-01T00:00:00.000Z'}),actor),/future/);
 assert.equal(t.store.verifyAudit(),true);
}finally{t.store.close();}});

test('evidence rejections are immutable and tenant isolation prevents reading even a known id',async()=>{const t=await childFixture();try{
 const o=t.ledger.report(actor.tenantId,claim(t.runId,'outreach_sent',receipt()),actor);
 assert.throws(()=>t.ledger.get('other',o.id),/not found/);
 assert.deepEqual(t.ledger.list('other'),[]);
 assert.throws(()=>t.ledger.byRun('other',t.runId),/not found/);
 assert.throws(()=>t.ledger.dossier('other',t.runId),/not found/);
 t.ledger.decide(actor.tenantId,o.id,o.evidenceHash,false,'Evidence insufficient to support commercial success',approver);
 assert.equal(t.ledger.summary(actor.tenantId).claimsRejected,1);
 assert.equal(t.ledger.summary(actor.tenantId).humanReviewedByKind.outreach_sent,undefined);
}finally{t.store.close();}});

test('schema v2 persists and migrates to v3 safely and never recreates or erases claims',()=>{
 const dir=mkdtempSync(join(tmpdir(),'twc-outcome-db-')),path=join(dir,'twc.sqlite');
 try{
   const one=new Store(path);
   one.db.exec("DROP TABLE followup_history; DROP TABLE followups; DROP TABLE outcomes; UPDATE metadata SET value='2' WHERE key='schema_version'");
   one.close();
   const two=new Store(path);
   assert.equal(two.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'4');
   assert.deepEqual(two.db.prepare('PRAGMA table_info(outcomes)').all().map(row=>row.name).filter(name=>name==='evidence_key'),['evidence_key']);
   two.close();
   const three=new Store(path);
   assert.equal(three.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'4');
   three.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
