import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { Engine } from '../dist/runtime/engine.js';
import { setup, actor, approver, reply, output, definition, registry, evidence } from './helpers.mjs';
for (const playbook of ['buyer-development', 'inquiry-quote', 'sample-followup'])
    test('durable complete lifecycle: ' + playbook, async () => {
        const t = setup({ playbook });
        try {
            await t.until('WAITING_APPROVAL');
            assert.equal(t.calls.filter(c => c.capability.effect === 'external').length, 0);
            t.approve();
            const waiting = await t.until('WAITING_EVENT');
            const node = waiting.spec.nodes.find(n => n.id === 'wait'), parent = waiting.steps[node.correlationFrom].output;
            t.store.ingest({ id: 'fixture-event', tenantId: actor.tenantId, type: node.eventType, correlationId: parent.correlationId, payload: playbook === 'sample-followup' ? { status: 'received', note: 'FIXTURE', evidence } : reply, receivedAt: t.now() }, actor);
            const done = await t.until('COMPLETED');
            assert.equal(done.current, 'END');
            assert.equal(t.calls.filter(c => c.capability.effect === 'external').length, 1);
            assert(t.store.verifyAudit());
        }
        finally {
            t.store.close();
        }
    });
test('rejecting approval never sends', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    t.approve(false);
    await t.until('REJECTED');
    assert.equal(t.calls.filter(c => c.capability.effect === 'external').length, 0);
}
finally {
    t.store.close();
} });
test('approval content hash is mandatory', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    const a = t.store.listApprovals(actor.tenantId)[0];
    assert.throws(() => t.store.decideApproval(actor.tenantId, a.id, '0'.repeat(64), true, approver), /hash/);
}
finally {
    t.store.close();
} });
test('initiator cannot approve their own outbound operation', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    const a = t.store.listApprovals(actor.tenantId)[0];
    assert.throws(() => t.store.decideApproval(actor.tenantId, a.id, a.payloadHash, true, { ...actor, role: 'approver' }), /cannot approve/);
}
finally {
    t.store.close();
} });
test('expired approval cannot be applied', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    const a = t.store.listApprovals(actor.tenantId)[0];
    assert.throws(() => t.store.decideApproval(actor.tenantId, a.id, a.payloadHash, true, approver, a.expiresAt + 1), /expired/);
    t.advance(86400001);
    await t.until('TIMED_OUT');
}
finally {
    t.store.close();
} });
test('approval decisions are immutable and duplicate same decision is idempotent', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    const a = t.approve();
    assert.equal(t.approve().id, a.id);
    assert.throws(() => t.approve(false), /immutable/);
}
finally {
    t.store.close();
} });
test('start idempotency returns same run; conflict rejects', () => { const t = setup(); try {
    assert.equal(t.store.createRun(actor.tenantId, t.spec.id, 1, 'fixture-request-key-0001', actor).id, t.run.id);
    assert.throws(() => t.store.createRun(actor.tenantId, 'other', 1, 'fixture-request-key-0001', actor), /different request/);
}
finally {
    t.store.close();
} });
test('tenant isolation protects run, definition and approvals', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    assert.throws(() => t.store.getRun('other', t.run.id), /not found/);
    assert.throws(() => t.store.getDefinition('other', t.spec.id, 1), /not found/);
    assert.throws(() => t.store.getApproval('other', t.store.listApprovals(actor.tenantId)[0].id), /not found/);
}
finally {
    t.store.close();
} });
test('workflow author cannot publish own version', () => { const s = new Store(':memory:'); try {
    const spec = definition(), d = s.saveDefinition(spec, actor);
    assert.throws(() => s.publish(actor.tenantId, spec.id, 1, d.hash, { ...actor, role: 'approver' }), /cannot publish/);
}
finally {
    s.close();
} });
test('published definitions and version keys cannot be overwritten', () => { const t = setup(); try {
    assert.throws(() => t.store.saveDefinition(t.spec, actor), /new version/);
}
finally {
    t.store.close();
} });
test('duplicate business events are deduplicated; payload changes conflict', () => { const t = setup(); try {
    const e = { id: 'e', tenantId: actor.tenantId, type: 'buyer.reply_received', correlationId: 'x', payload: reply, receivedAt: t.now() };
    assert.equal(t.store.ingest(e, actor).duplicate, false);
    assert.equal(t.store.ingest({ ...e, receivedAt: t.now() + 1 }, actor).duplicate, true);
    assert.throws(() => t.store.ingest({ ...e, payload: { ...reply, body: 'changed' } }, actor), /different data/);
}
finally {
    t.store.close();
} });
test('early event after run creation is retained until the wait node', async () => { const t = setup(); try {
    t.store.ingest({ id: 'early', tenantId: actor.tenantId, type: 'buyer.reply_received', correlationId: 'fixture-thread-1', payload: reply, receivedAt: t.now() }, actor);
    await t.until('WAITING_APPROVAL');
    t.approve();
    await t.until('COMPLETED');
}
finally {
    t.store.close();
} });
test('events of wrong type, correlation or tenant cannot wake a run', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    t.approve();
    await t.until('WAITING_EVENT');
    assert.throws(()=>t.store.ingest({id:'bad-type',tenantId:actor.tenantId,type:'wrong',correlationId:'fixture-thread-1',payload:reply,receivedAt:t.now()},actor),/Unsupported event type/);
    for (const [tenantId, type, correlationId] of [['other', 'buyer.reply_received', 'fixture-thread-1'], [actor.tenantId, 'buyer.reply_received', 'wrong']])
        t.store.ingest({ id: tenantId + type + correlationId, tenantId, type, correlationId, payload: reply, receivedAt: t.now() }, actor);
    t.advance();
    assert.equal((await t.engine.tick(actor.tenantId, t.run.id)).status, 'WAITING_EVENT');
}
finally {
    t.store.close();
} });
test('reply timeout terminates instead of inventing a buyer response', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    t.approve();
    await t.until('WAITING_EVENT');
    t.advance(604800001);
    await t.until('TIMED_OUT');
}
finally {
    t.store.close();
} });
test('invalid worker output stops before outreach', async () => { const t = setup({ adapter: { async execute() { return { status: 'completed', output: { invented: true } }; } } }); try {
    const r = await t.until('FAILED');
    assert.equal(r.error, 'OUTPUT_CONTRACT');
}
finally {
    t.store.close();
} });
test('provider budget overrun stops further work and retains reported cost', async () => { const t = setup({ adapter: { async execute(r) { return { status: 'completed', output: output[r.capability.id], actualCostMicros: 900000 }; } } }); try {
    const r = await t.until('FAILED');
    assert.equal(r.actualMicros, 900000);
    assert.match(r.error, /overrun/);
}
finally {
    t.store.close();
} });
test('safe transient research retry is bounded and reserves another attempt', async () => { let attempts = 0; const t = setup({ adapter: { async execute(r) { if (r.capability.id === 'market.research' && ++attempts === 1)
            throw Error('transient'); return { status: 'completed', output: output[r.capability.id] }; } } }); try {
    await t.until('WAITING_APPROVAL');
    const r = t.store.getRun(actor.tenantId, t.run.id);
    assert.equal(r.steps.research.attempts, 2);
    assert.equal(r.reservedMicros, 2500000);
}
finally {
    t.store.close();
} });
test('uncertain outbound result is never automatically resent', async () => { let sends = 0; const t = setup({ adapter: { async execute(r) { if (r.capability.effect === 'external') {
            sends++;
            throw Error('connection dropped after provider accepted');
        } return { status: 'completed', output: output[r.capability.id] }; } } }); try {
    await t.until('WAITING_APPROVAL');
    t.approve();
    await t.until('NEEDS_RECONCILIATION');
    for (let i = 0; i < 5; i++) {
        t.advance();
        await t.engine.tick(actor.tenantId, t.run.id);
    }
    assert.equal(sends, 1);
    t.engine.reconcile(actor.tenantId, t.run.id, output['outreach.send'], 'fixture provider receipt checked by human', approver);
    await t.until('WAITING_EVENT');
    assert.equal(sends, 1);
}
finally {
    t.store.close();
} });
test('suppression list blocks a recipient even after approval', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    t.approve();
    t.store.suppress(actor.tenantId, 'TEST@FIXTURE.INVALID', 'test unsubscribe', actor);
    await t.until('FAILED');
    assert.equal(t.calls.filter(c => c.capability.effect === 'external').length, 0);
}
finally {
    t.store.close();
} });
test('cancellation stops subsequent dispatch', async () => { const t = setup(); try {
    t.engine.cancel(actor.tenantId, t.run.id, actor);
    t.advance();
    assert.equal((await t.engine.tick(actor.tenantId, t.run.id)).status, 'CANCELLED');
    assert.equal(t.calls.length, 0);
}
finally {
    t.store.close();
} });
test('SQLite state survives closing and reopening the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twc-restart-')), path = join(dir, 'state.sqlite');
    const t = setup({ path });
    let recovered;
    try {
        await t.until('WAITING_APPROVAL');
        const previous = t.store.getRun(actor.tenantId, t.run.id);
        t.store.close();
        recovered = new Store(path);
        assert.equal(recovered.getRun(actor.tenantId, t.run.id).status, 'WAITING_APPROVAL');
        assert.equal(recovered.listApprovals(actor.tenantId).length, 1);
        const a = recovered.listApprovals(actor.tenantId)[0];
        recovered.decideApproval(actor.tenantId, a.id, a.payloadHash, true, approver, t.now());
        let now = t.now();
        let sends = 0;
        const engine = new Engine(recovered, t.reg, { http: { async execute(r) { if (r.capability.effect === 'external')
                    sends++; return { status: 'completed', output: output[r.capability.id] }; } } }, () => now);
        for (let i = 0; i < 6; i++) {
            now += 2500;
            await engine.tick(actor.tenantId, t.run.id);
        }
        assert.equal(recovered.getRun(actor.tenantId, t.run.id).status, 'WAITING_EVENT');
        assert.equal(sends, 1);
        assert.equal(previous.steps.research.output.findings[0], 'FIXTURE');
    }
    finally {
        recovered?.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('in-flight external action on crash is reconciled, never blindly replayed', async () => { const t = setup(); try {
    await t.until('WAITING_APPROVAL');
    t.approve();
    t.advance();
    await t.engine.tick(actor.tenantId, t.run.id);
    t.store.mutateRun(actor.tenantId, t.run.id, r => { r.steps.send = { status: 'running', attempts: 1, startedAt: t.now() }; r.status = 'RUNNING'; });
    await t.until('NEEDS_RECONCILIATION');
    assert.equal(t.calls.filter(c => c.capability.effect === 'external').length, 0);
}
finally {
    t.store.close();
} });
test('audit modification is detected', () => { const t = setup(); try {
    assert(t.store.verifyAudit());
    t.store.db.prepare("UPDATE audit SET payload='{}' WHERE seq=1").run();
    assert.equal(t.store.verifyAudit(), false);
}
finally {
    t.store.close();
} });
test('concurrent ticks cannot dispatch one step twice', async () => { let count = 0; const t = setup({ adapter: { async execute(r) { count++; await new Promise(resolve => setTimeout(resolve, 25)); return { status: 'completed', output: output[r.capability.id] }; } } }); try {
    t.advance();
    await Promise.all([t.engine.tick(actor.tenantId, t.run.id), t.engine.tick(actor.tenantId, t.run.id)]);
    assert.equal(count, 1);
}
finally {
    t.store.close();
} });
// The company facts are immutable run context, not whatever an intermediate bot happened to echo.
test('every worker receives original company facts and business request', async () => { const s = setup(); try {
    await s.until('WAITING_APPROVAL');
    assert.equal(s.calls.length, 4);
    for (const call of s.calls) {
        assert.deepEqual(call.context, s.spec.context);
        assert.equal(call.businessRequest, s.spec.request);
    }
    s.calls[0].context.companyName = 'attempted mutation';
    assert.equal(s.store.getRun(actor.tenantId, s.run.id).spec.context.companyName, s.spec.context.companyName);
}
finally {
    s.store.close();
} });
test('v1 rejects multiple outbound recipients instead of silently waiting for only the first reply', async () => { const s = setup({ adapter: { async execute(req) { const data = structuredClone(output[req.capability.id]); if (req.capability.id === 'outreach.draft')
            data.messages.push(structuredClone(data.messages[0])); return { status: 'completed', output: data }; } } }); try {
    const run = await s.until('FAILED');
    assert.equal(run.status, 'FAILED');
    assert.equal(s.store.listApprovals(actor.tenantId).length, 0);
}
finally {
    s.store.close();
} });
