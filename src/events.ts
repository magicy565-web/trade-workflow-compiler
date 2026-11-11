import { createHmac } from 'node:crypto';
import type { Store } from './store.js';
import type { BusinessEvent, Principal, Run, TaskNode } from './types.js';
import { contracts } from './contracts.js';
import { assertSchema, obj, str } from './schema.js';
import { constantEqual, fail, hash, record } from './util.js';
import { Followups } from './followups.js';
export const eventInputSchema = obj({ id: str(1, 200), type: { enum: ['buyer.reply_received', 'sample.update'] }, correlationId: str(1, 200), payload: {} });
export type EventState = 'unmatched' | 'ready' | 'quarantined' | 'consumed';
export interface EventSource {
    id: string;
    tenantId: string;
    secretEnv: string;
    enabled: boolean;
}
export interface InboxEntry {
    event: BusinessEvent;
    state: EventState;
    reason: string | null;
    runId: string | null;
}
export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
export function validateEvent(e: Pick<BusinessEvent, 'type' | 'payload'>): void {
    if (!['buyer.reply_received', 'sample.update'].includes(e.type))
        fail('EVENT_TYPE', 'Unsupported event type');
    assertSchema(contracts[e.type === 'sample.update' ? 'SampleUpdateV1' : 'BuyerReplyV1']!, e.payload, 'EVENT_CONTRACT');
}
/** Only gateway-authenticated, structurally valid events enter this inbox. Sender matching is NOT email sender authentication. */
export class EventInbox {
    constructor(readonly store: Store) { }
    ingest(e: BusinessEvent, actor: Principal): {
        duplicate: boolean;
        state: EventState;
    } {
        validateEvent(e);
        return this.store.transaction(() => {
            const prior = this.store.db.prepare('SELECT body FROM events WHERE tenant=? AND id=?').get(e.tenantId, e.id) as {
                body: string;
            } | undefined;
            if (prior) {
                const old = JSON.parse(prior.body) as BusinessEvent;
                if (hash({ type: old.type, correlationId: old.correlationId, payload: old.payload }) !== hash({ type: e.type, correlationId: e.correlationId, payload: e.payload }))
                    fail('EVENT_CONFLICT', 'Event id reused with different data', 409);
                return { duplicate: true, state: this.get(e.tenantId, e.id).state };
            }
            this.store.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(e.tenantId, e.id, e.type, e.correlationId, e.receivedAt, null, JSON.stringify(e));
            this.store.db.prepare("INSERT INTO event_routes VALUES(?,?,'unmatched',NULL,NULL)").run(e.tenantId, e.id);
            this.store.audit(e.tenantId, actor.userId, 'event.received', { id: e.id, type: e.type, correlationId: e.correlationId, payloadHash: hash(e.payload) });
            return { duplicate: false, state: this.routeInside(e).state };
        });
    }
    /** Call within the action-receipt transaction: a correlation belongs to one run, forever. */
    bindInside(tenant: string, type: string, correlation: string, runId: string, recipient: string | null): void {
        const old = this.store.db.prepare('SELECT run_id,recipient FROM correlations WHERE tenant=? AND event_type=? AND correlation=?').get(tenant, type, correlation) as {
            run_id: string;
            recipient: string | null;
        } | undefined;
        const email = recipient ? normalizeEmail(recipient) : null;
        if (old && (old.run_id !== runId || old.recipient !== email))
            fail('CORRELATION_CONFLICT', 'Provider reused a correlation id for a different run or recipient', 409);
        if (!old)
            this.store.db.prepare('INSERT INTO correlations VALUES(?,?,?,?,?)').run(tenant, type, correlation, runId, email);
        const rows = this.store.db.prepare('SELECT body FROM events WHERE tenant=? AND event_type=? AND correlation=? AND consumed_by IS NULL').all(tenant, type, correlation) as {
            body: string;
        }[];
        for (const r of rows)
            this.routeInside(JSON.parse(r.body) as BusinessEvent);
    }
    /** Bind send receipts to the approved recipient; used by normal execution AND reconciliation. */
    bindReceiptInside(run: Run, node: TaskNode, input: unknown, output: unknown): void {
        const waits = run.spec.nodes.filter(n => n.type === 'wait_event' && n.correlationFrom === node.id);
        for (const wait of waits) {
            if (wait.type !== 'wait_event' || !record(output))
                continue;
            const correlation = output[wait.correlationField];
            if (typeof correlation !== 'string')
                fail('CORRELATION', 'Missing receipt correlation');
            let recipient: string | null = null;
            if (wait.eventType === 'buyer.reply_received') {
                if (!record(input))
                    fail('RECIPIENT', 'Missing approved message');
                if (typeof input.to === 'string')
                    recipient = input.to;
                else if (Array.isArray(input.messages) && input.messages.length === 1 && record(input.messages[0]) && typeof input.messages[0].to === 'string')
                    recipient = input.messages[0].to;
                const receipts = output.receipts;
                if (!recipient || !Array.isArray(receipts) || receipts.length !== 1 || !record(receipts[0]) || typeof receipts[0].recipient !== 'string' || normalizeEmail(receipts[0].recipient) !== normalizeEmail(recipient))
                    fail('RECEIPT_RECIPIENT', 'Gateway receipt does not match the approved recipient');
            }
            this.bindInside(run.tenantId, wait.eventType, correlation, run.id, recipient);
        }
    }
    private routeInside(e: BusinessEvent): InboxEntry {
        const current = this.get(e.tenantId, e.id);
        if (current.state === 'consumed')
            return current;
        const binding = this.store.db.prepare('SELECT run_id,recipient FROM correlations WHERE tenant=? AND event_type=? AND correlation=?').get(e.tenantId, e.type, e.correlationId) as {
            run_id: string;
            recipient: string | null;
        } | undefined;
        let state: EventState = 'unmatched', reason: string | null = 'No matching receipt yet', runId: string | null = null;
        if (binding) {
            runId = binding.run_id;
            const run = this.store.getRun(e.tenantId, runId);
            if (e.receivedAt < run.createdAt) {
                state = 'quarantined';
                reason = 'Event predates this run';
            }
            else if (e.type === 'buyer.reply_received' && (!record(e.payload) || typeof e.payload.from !== 'string' || normalizeEmail(e.payload.from) !== binding.recipient)) {
                state = 'quarantined';
                reason = 'Reply sender does not match the approved recipient';
            }
            else if (['COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED'].includes(run.status)) {
                state = 'quarantined';
                reason = 'Run is closed; preserved for human review';
            }
            else {
                state = 'ready';
                reason = null;
            }
        }
        this.store.db.prepare('UPDATE event_routes SET state=?,reason=?,run_id=? WHERE tenant=? AND event_id=?').run(state, reason, runId, e.tenantId, e.id);
        if (state === 'quarantined' && runId)
            new Followups(this.store).ensureInside(e.tenantId, e.id);
        if (state !== current.state || runId !== current.runId)
            this.store.audit(e.tenantId, 'event-router', 'event.' + state, { eventId: e.id, runId, reason });
        // A wake must not steal a dispatch lease or overwrite in-flight runtime state.
        if (state === 'ready' && runId) {
            const r = this.store.getRun(e.tenantId, runId);
            if (r.status === 'WAITING_EVENT') {
                r.nextWakeAt = Date.now();
                this.store.putRun(r);
            }
        }
        return { event: e, state, reason, runId };
    }
    refreshRunInside(tenant: string, runId: string): void {
        const rows = this.store.db.prepare("SELECT e.body FROM events e JOIN event_routes r ON r.tenant=e.tenant AND r.event_id=e.id WHERE e.tenant=? AND r.run_id=? AND e.consumed_by IS NULL").all(tenant, runId) as {
            body: string;
        }[];
        for (const row of rows)
            this.routeInside(JSON.parse(row.body) as BusinessEvent);
    }
    recheck(tenant: string, id: string, actor: Principal): InboxEntry {
        return this.store.transaction(() => { const current = this.get(tenant, id); this.store.audit(tenant, actor.userId, 'event.recheck', { eventId: id }); return this.routeInside(current.event); });
    }
    get(tenant: string, id: string): InboxEntry {
        const row = this.store.db.prepare('SELECT e.body,r.state,r.reason,r.run_id,e.consumed_by FROM events e JOIN event_routes r ON r.tenant=e.tenant AND r.event_id=e.id WHERE e.tenant=? AND e.id=?').get(tenant, id) as {
            body: string;
            state: EventState;
            reason: string | null;
            run_id: string | null;
            consumed_by: string | null;
        } | undefined;
        if (!row)
            fail('NOT_FOUND', 'Event not found', 404);
        const event = JSON.parse(row.body) as BusinessEvent;
        if (row.consumed_by)
            event.consumedBy = row.consumed_by;
        return { event, state: row.state, reason: row.reason, runId: row.run_id };
    }
    list(tenant: string, before?: number, limit = 100): {
        items: InboxEntry[];
        nextCursor: number | null;
    } {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && (!Number.isSafeInteger(before) || before < 1)))
            fail('PAGINATION', 'Invalid inbox cursor or limit');
        const rows = this.store.db.prepare('SELECT rowid AS cursor,id FROM events WHERE tenant=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(tenant, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as {
            cursor: number;
            id: string;
        }[];
        return { items: rows.slice(0, limit).map(r => this.get(tenant, r.id)), nextCursor: rows.length > limit ? rows[limit - 1]!.cursor : null };
    }
}
export function webhookSignature(secret: string, sourceId: string, timestamp: string, raw: Buffer): string {
    return createHmac('sha256', secret).update(timestamp + '\n' + sourceId + '\n').update(raw).digest('hex');
}
export function verifyWebhook(source: EventSource | undefined, timestamp: string | undefined, signature: string | undefined, raw: Buffer, now = Date.now()): void {
    if (!source?.enabled)
        fail('WEBHOOK_DISABLED', 'Event source unavailable', 404);
    const secret = process.env[source.secretEnv];
    if (!secret || Buffer.byteLength(secret) < 32)
        fail('WEBHOOK_CONFIG', 'Event source secret is absent or too short', 503);
    if (!timestamp || !/^\d{10,12}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300000 || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature) || !constantEqual(signature.slice(7), webhookSignature(secret, source.id, timestamp, raw)))
        fail('WEBHOOK_AUTH', 'Invalid or expired webhook signature', 401);
}
