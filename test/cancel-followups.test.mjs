// Synthetic test-only replies; no external delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, actor, reply } from './helpers.mjs';
import { batchSetup } from './v02-helpers.mjs';
import { Followups } from '../dist/followups.js';
import { EventInbox } from '../dist/events.js';

for (const batch of [false, true]) test(`${batch ? 'batch' : 'single'} cancellation moves a pending matching reply into human follow-up atomically`, async () => {
    const t = batch ? await batchSetup() : setup();
    try {
        let run, cancel;
        if (batch) {
            await t.ready(); const b = t.create(), child = t.batches.members(actor.tenantId, b.id)[0];
            await t.childUntil(child.id, 'WAITING_APPROVAL'); t.approveChild(child.id);
            run = await t.childUntil(child.id, 'WAITING_EVENT');
            cancel = () => t.batches.control(actor.tenantId, b.id, 'cancelled', actor);
        } else {
            await t.until('WAITING_APPROVAL'); t.approve(); run = await t.until('WAITING_EVENT');
            cancel = () => t.engine.cancel(actor.tenantId, run.id, actor);
        }
        const event = { id: 'reply-at-cancellation', tenantId: actor.tenantId, type: 'buyer.reply_received',
            correlationId: run.steps.send.output.correlationId, payload: { ...reply, from: run.targetEmail ?? reply.from }, receivedAt: t.now() };
        t.store.ingest(event, actor); const inbox = new EventInbox(t.store), followups = new Followups(t.store);
        assert.equal(inbox.get(actor.tenantId, event.id).state, 'ready');
        const calls = t.calls.length;
        // Failure to preserve the reply must roll back cancellation and routing together.
        t.store.db.exec("CREATE TRIGGER reject_cancel_followup BEFORE INSERT ON followup_history BEGIN SELECT RAISE(ABORT,'TEST followup persistence failure'); END;");
        assert.throws(cancel, /TEST followup persistence failure/);
        assert.equal(t.store.getRun(actor.tenantId, run.id).status, 'WAITING_EVENT');
        assert.equal(inbox.get(actor.tenantId, event.id).state, 'ready');
        t.store.db.exec('DROP TRIGGER reject_cancel_followup');
        cancel(); cancel();
        assert.equal(t.store.getRun(actor.tenantId, run.id).status, 'CANCELLED');
        assert.equal(inbox.get(actor.tenantId, event.id).state, 'quarantined');
        assert.equal(inbox.get(actor.tenantId, event.id).event.consumedBy, undefined);
        assert.deepEqual(followups.list(actor.tenantId).items.map(f => f.eventId), [event.id]);
        await t.engine.tick(actor.tenantId, run.id);
        assert.equal(t.calls.length, calls); assert.equal(t.store.verifyAudit(), true);
    } finally { t.store.close(); }
});
