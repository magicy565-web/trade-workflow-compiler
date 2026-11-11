// Synthetic fixtures ONLY: never imported by src/ or configured in production.
import { setup, actor, approver, buyer, output, reply, evidence } from './helpers.mjs';
import { Batches } from '../dist/batches.js';
export { actor, approver, reply, evidence };
export const twoBuyers=[buyer,{...buyer,companyName:'SECOND TEST FIXTURE',contactEmail:'second@fixture.invalid'}];
export async function batchSetup({path=':memory:',buyers=twoBuyers,alter,failSend=false,budgetMicros}={}) {
  const calls=[];
  const t=setup({path,budgetMicros,adapter:{async execute(req){
    calls.push(req);let result=structuredClone(output[req.capability.id]);
    if(req.capability.id==='buyers.qualify')result.buyers=structuredClone(buyers);
    if(req.capability.id==='outreach.draft')result.messages[0].to=req.input.buyers[0].contactEmail;
    if(req.capability.id==='outreach.send'){
      if(failSend)throw Error('TEST UNCERTAIN PROVIDER OUTCOME');
      result.correlationId='thread-'+req.runId;result.receipts[0].recipient=req.input.messages[0].to;result.receipts[0].providerId='provider-'+req.runId;
    }
    if(alter)result=alter(req,result);
    return {status:'completed',output:result,actualCostMicros:100};
  }}});
  const batches=new Batches(t.store);
  return {...t,calls,batches,
    async ready(){await t.until('BATCH_READY');return batches.preview(actor.tenantId,t.run.id);},
    create(emails=twoBuyers.map(b=>b.contactEmail),key='batch-fixture-request-0001'){return batches.create(actor.tenantId,t.run.id,emails,key,actor,t.reg);},
    async childUntil(id,status,max=30){for(let i=0;i<max;i++){t.advance();const r=await t.engine.tick(actor.tenantId,id);if(r.status===status)return r;if(['FAILED','NEEDS_RECONCILIATION','TIMED_OUT','REJECTED'].includes(r.status))throw Error(JSON.stringify(r));}throw Error('Never reached '+status);},
    approveChild(id,accepted=true){const a=t.store.listApprovals(actor.tenantId).find(a=>a.runId===id);return t.store.decideApproval(actor.tenantId,a.id,a.payloadHash,accepted,approver,t.now());}
  };
}
