// Synthetic HTTP fixtures only. Never used by production configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../dist/api.js';
import { setup, actor, approver, reply } from './helpers.mjs';

test('HTTP follow-ups enforce tenant/role/owner boundaries and preserve independent approval requirements',async()=>{
 const t=setup();await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');
 const event=id=>({id,tenantId:actor.tenantId,type:'buyer.reply_received',correlationId:'fixture-thread-1',payload:reply,receivedAt:t.now()});
 t.store.ingest(event('first'),actor);await t.until('COMPLETED');t.store.ingest(event('second'),actor);
 const roles=['operator','viewer','approver','worker','ingest','admin'];
 const keys=roles.map((role,i)=>({...actor,role,userId:role==='approver'?approver.userId:role==='operator'?actor.userId:'person-'+role,token:String(i).repeat(64)}));
 keys.push({...actor,tenantId:'other',role:'operator',userId:'other',token:'x'.repeat(64)});
 keys.push({...actor,userId:'colleague',token:'y'.repeat(64)});
 const server=createApi({dataDir:'.',registry:t.reg,keys,host:'127.0.0.1',port:0,scheduler:'external'},t.store,t.engine);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,role='operator',payload)=>{
  const k=role==='other'?keys.at(-2):role==='colleague'?keys.at(-1):keys.find(k=>k.role===role);
  const res=await fetch(base+path,{method:payload?'POST':'GET',headers:{authorization:'Bearer '+k.token,...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
  return {status:res.status,data:await res.json()};
 };
 try{
  const list=await call('/api/followups','viewer');assert.equal(list.status,200);assert.equal(list.data.summary.active,1);
  let f=list.data.items[0];const path='/api/followups/'+f.id;
  for(const role of ['worker','ingest'])assert.equal((await call('/api/followups',role)).status,403);
  assert.equal((await call('/api/followups','other')).data.items.length,0);
  assert.equal((await call(path,'other')).status,404);
  const input={expectedVersion:1,action:'claim',note:'I reviewed this synthetic customer response.'};
  for(const role of ['viewer','approver','worker','ingest'])assert.equal((await call(path,role,input)).status,403);
  const claimed=await call(path,'operator',input);assert.equal(claimed.status,200);f=claimed.data;
  assert.equal((await call(path,'operator',input)).status,409);
  assert.equal((await call(path,'colleague',{...input,expectedVersion:f.version,action:'resolve'})).status,403);
  assert.equal((await call(path,'operator',{...input,expectedVersion:f.version,action:'schedule'})).status,400);
  const closed=await call(path,'operator',{...input,expectedVersion:f.version,action:'resolve'});assert.equal(closed.status,200);
  assert.equal((await call('/api/followups?state=closed','viewer')).data.items.length,1);
  assert.equal((await call('/api/followups','viewer')).data.summary.active,0);
  assert.equal((await call(path,'viewer')).data.history.length,3);
  assert.equal((await call('/api/followups?state=nope','viewer')).status,400);
  assert.equal((await call('/api/followups?limit=101','viewer')).status,400);
  const dossier=(await call('/api/runs/'+t.run.id+'/dossier','viewer')).data;
  assert.equal(dossier.manifest.followups[0].state,'resolved');
  assert.equal((await call('/api/events/second','viewer')).data.state,'quarantined');
  assert.equal((await call('/api/outcomes','operator',{runId:t.run.id,idempotencyKey:'late-event-claim-0001',kind:'buyer_replied',evidence:{kind:'business_event',reference:'second',note:input.note},occurredAt:new Date().toISOString()})).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));t.store.close();}
});
