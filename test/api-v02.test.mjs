import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../dist/api.js';
import { webhookSignature } from '../dist/events.js';
import { batchSetup,actor,reply,twoBuyers } from './v02-helpers.mjs';
async function fixture(){
 const t=await batchSetup();await t.ready();const roles=['admin','operator','approver','viewer','worker','ingest'];
 const keys=roles.map((role,i)=>({...actor,userId:role==='operator'?actor.userId:'person-'+role,role,token:String(i).repeat(64)}));keys.push({tenantId:'other',userId:'other',role:'viewer',token:'z'.repeat(64)});
 const source={id:'mail',tenantId:actor.tenantId,secretEnv:'TWC_TEST_API_WEBHOOK_SECRET',enabled:true};process.env[source.secretEnv]='h'.repeat(64);
 const server=createApi({dataDir:'.',registry:t.reg,keys,host:'127.0.0.1',port:0,scheduler:'external',eventSources:[source]},t.store,t.engine);server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 return {...t,source,base,
  async call(path,role='operator',body){const key=keys.find(k=>role==='other'?k.tenantId==='other':k.role===role&&k.tenantId===actor.tenantId);const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(key?{authorization:'Bearer '+key.token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};},
  async webhook(body,{timestamp=String(Math.floor(Date.now()/1000)),signature,sourceId=source.id}={}){const raw=JSON.stringify(body);const res=await fetch(base+'/api/webhooks/'+sourceId,{method:'POST',headers:{'content-type':'application/json','x-twc-timestamp':timestamp,'x-twc-signature':signature??'sha256='+webhookSignature(process.env[source.secretEnv],sourceId,timestamp,Buffer.from(raw))},body:raw});return {status:res.status,data:await res.json()};},
  async close(){await new Promise(r=>server.close(r));t.store.close();delete process.env[source.secretEnv];}
 };
}
const create=(t,role='operator')=>t.call('/api/batches',role,{sourceRunId:t.run.id,recipients:twoBuyers.map(b=>b.contactEmail),idempotencyKey:'http-batch-fixture-0001'});
test('HTTP batch preview, create, list and detail operate on persisted state',async()=>{const t=await fixture();try{
 assert.equal((await t.call(`/api/runs/${t.run.id}/batch-preview`)).data.buyers.length,2);const created=await create(t);assert.equal(created.status,201);assert.equal(created.data.runs.length,2);
 assert.equal((await t.call('/api/batches')).data[0].total,2);assert.equal((await t.call('/api/batches/'+created.data.batch.id)).data.batch.id,created.data.batch.id);
 assert.equal((await create(t)).data.batch.id,created.data.batch.id);
}finally{await t.close();}});
test('HTTP batch endpoints enforce operator role and tenant isolation',async()=>{const t=await fixture();try{
 for(const role of ['viewer','approver','worker','ingest','none'])assert.equal((await create(t,role)).status,role==='none'?401:403);
 const b=(await create(t)).data.batch;assert.equal((await t.call('/api/batches/'+b.id,'other')).status,404);assert.deepEqual((await t.call('/api/batches','other')).data,[]);
 assert.equal((await t.call('/api/batches/'+b.id+'/pause','viewer',{})).status,403);
}finally{await t.close();}});
test('HTTP batch pause/resume/cancel preserve explicit control semantics',async()=>{const t=await fixture();try{
 const b=(await create(t)).data.batch;
 assert.equal((await t.call('/api/batches/'+b.id+'/pause','operator',{})).data.status,'PAUSED');
 assert.equal((await t.call('/api/batches/'+b.id+'/resume','operator',{})).data.status,'ACTIVE');
 assert.equal((await t.call('/api/batches/'+b.id+'/cancel','operator',{})).data.status,'CANCELLED');
 assert.equal((await t.call('/api/batches/'+b.id+'/resume','operator',{})).status,409);
}finally{await t.close();}});
test('real local HTTP webhook verifies signatures, namespaces ids and deduplicates retries',async()=>{const t=await fixture();try{
 const e={id:'provider-event-1',type:'buyer.reply_received',correlationId:'not-sent-yet',payload:reply};
 const first=await t.webhook(e);assert.equal(first.status,202);assert.equal(first.data.state,'unmatched');assert.match(first.data.eventId,/^wh_/);assert.equal((await t.webhook(e)).data.duplicate,true);
 assert.equal((await t.webhook({...e,payload:{...reply,body:'changed'}})).status,409);
 const listed=await t.call('/api/events');assert.equal(listed.data.items.length,1);assert.equal(listed.data.items[0].event.tenantId,actor.tenantId);
 assert.equal((await t.call('/api/events/'+first.data.eventId+'/recheck','operator',{})).data.state,'unmatched');
 assert.equal((await t.call('/api/events/'+first.data.eventId,'other')).status,404);
}finally{await t.close();}});
test('HTTP ingress rejects tampering, old signatures, disabled sources and caller-selected tenant',async()=>{const t=await fixture();try{
 const e={id:'provider-event-1',type:'buyer.reply_received',correlationId:'not-sent-yet',payload:reply};
 assert.equal((await t.webhook(e,{signature:'sha256='+'0'.repeat(64)})).status,401);
 assert.equal((await t.webhook(e,{timestamp:String(Math.floor(Date.now()/1000)-301)})).status,401);
 assert.equal((await t.webhook(e,{sourceId:'disabled'})).status,404);
 assert.equal((await t.webhook({...e,tenantId:'other'})).status,400);
 assert.equal((await t.call('/api/events')).data.items.length,0);
}finally{await t.close();}});
test('webhook reply wakes only its approved recipient through actual HTTP routes',async()=>{const t=await fixture();try{
 const created=await create(t);const [a,b]=created.data.runs;await t.childUntil(a.id,'WAITING_APPROVAL');t.approveChild(a.id);const sent=await t.childUntil(a.id,'WAITING_EVENT');
 const e={id:'correlated',type:'buyer.reply_received',correlationId:sent.steps.send.output.correlationId,payload:{...reply,from:a.targetEmail}};
 assert.equal((await t.webhook({...e,id:'wrong',payload:{...reply,from:b.targetEmail}})).data.state,'quarantined');assert.equal((await t.webhook(e)).data.state,'ready');
 await t.childUntil(a.id,'COMPLETED');assert.equal(t.store.getRun(actor.tenantId,b.id).status,'PENDING');
 const items=(await t.call('/api/events')).data.items;assert.equal(items.filter(i=>i.state==='consumed').length,1);assert.equal(items.filter(i=>i.state==='quarantined').length,1);
}finally{await t.close();}});
test('invalid inbox pagination and unprivileged recheck are rejected',async()=>{const t=await fixture();try{
 assert.equal((await t.call('/api/events?before=NaN')).status,400);assert.equal((await t.call('/api/events?limit=1000')).status,400);assert.equal((await t.call('/api/events/x/recheck','viewer',{})).status,403);
}finally{await t.close();}});
