import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../dist/api.js';
import { setup, actor, approver } from './helpers.mjs';
import { hash } from '../dist/util.js';

async function fixture(){
 const t=setup();await t.until('WAITING_APPROVAL');t.approve();await t.until('WAITING_EVENT');
 const roles=['admin','operator','approver','viewer','worker','ingest'];
 const keys=roles.map((role,i)=>({tenantId:actor.tenantId,userId:role==='operator'?actor.userId:role==='approver'?approver.userId:'person-'+role,role,token:String(i).repeat(64)}));
 keys.push({tenantId:'other',userId:'other',role:'viewer',token:'z'.repeat(64)});
 const server=createApi({dataDir:'.',registry:t.reg,keys,host:'127.0.0.1',port:0,scheduler:'external'},t.store,t.engine);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 return {...t,base,server,
  async call(path,role='operator',payload){const key=keys.find(k=>role==='other'?k.tenantId==='other':k.role===role&&k.tenantId===actor.tenantId);const res=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers:{...(key?{authorization:'Bearer '+key.token}:{}),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return {status:res.status,data:await res.json()};},
  async close(){await new Promise(resolve=>server.close(resolve));t.store.close();}
 };
}
const claim=t=>({runId:t.run.id,idempotencyKey:'http-outcome-claim-0001',kind:'outreach_sent',evidence:{kind:'provider_receipt',reference:'send',note:'Action receipt read via a local fixture'},occurredAt:new Date().toISOString()});
test('HTTP outcomes ledger separates reporting, independent approval, and read-only summary',async()=>{const t=await fixture();try{
 const data=claim(t);const posted=await t.call('/api/outcomes','operator',data);
 assert.equal(posted.status,201);assert.equal(posted.data.state,'pending');
 const summary=await t.call('/api/outcomes/summary','viewer');assert.equal(summary.status,200);assert.equal(summary.data.claimsPendingReview,1);
 const read=await t.call('/api/outcomes/'+posted.data.id,'viewer');assert.equal(read.data.id,posted.data.id);
 assert.equal((await t.call('/api/outcomes','worker',data)).status,403);
 assert.equal((await t.call('/api/outcomes/'+posted.data.id+'/decision','operator',{hash:posted.data.evidenceHash,approved:true,note:'Looked at receipt evidence'})).status,403);
 assert.equal((await t.call('/api/outcomes/'+posted.data.id+'/decision','approver',{hash:'0'.repeat(64),approved:true,note:'Looked at receipt evidence'})).status,409);
 const approved=await t.call('/api/outcomes/'+posted.data.id+'/decision','approver',{hash:posted.data.evidenceHash,approved:true,note:'I independently reviewed this test-only action receipt'});
 assert.equal(approved.status,200);assert.equal(approved.data.state,'human_reviewed');
 assert.equal((await t.call('/api/outcomes/summary','viewer')).data.humanReviewedByKind.outreach_sent,1);
 assert.equal((await t.call('/api/runs/'+t.run.id+'/outcomes','viewer')).data.length,1);
 const dossier=await t.call('/api/runs/'+t.run.id+'/dossier','viewer');assert.equal(dossier.status,200);assert.equal(dossier.data.manifestSha256,hash(dossier.data.manifest));
}finally{await t.close();}});
test('HTTP outcome records are strictly tenant scoped and no ingest/worker may read them',async()=>{const t=await fixture();try{
 const posted=await t.call('/api/outcomes','operator',claim(t));
 assert.equal((await t.call('/api/outcomes','other')).data.length,0);
 assert.equal((await t.call('/api/outcomes/summary','other')).data.executionCount,0);
 assert.equal((await t.call('/api/outcomes/'+posted.data.id,'other')).status,404);
 assert.equal((await t.call('/api/runs/'+t.run.id+'/dossier','other')).status,404);
 for(const role of ['worker','ingest'])assert.equal((await t.call('/api/outcomes',role)).status,403);
}finally{await t.close();}});
test('HTTP does not credit unverified orders or allow unsupported claims',async()=>{const t=await fixture();try{
 assert.equal((await t.call('/api/outcomes','operator',{...claim(t),kind:'order_confirmed'})).status,400);
 assert.equal((await t.call('/api/outcomes','operator',{...claim(t),tenantId:'other'})).status,400);
 assert.equal((await t.call('/api/outcomes?limit=501','viewer')).status,400);
 assert.equal((await t.call('/api/outcomes','viewer',claim(t))).status,403);
 assert.equal((await t.call('/api/outcomes/summary','viewer')).data.humanReviewedOrderValueUsdMinor,0);
}finally{await t.close();}});
