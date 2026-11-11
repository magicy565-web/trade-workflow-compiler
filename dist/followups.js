import { randomUUID } from 'node:crypto';
import { assertSchema, obj, str, int } from './schema.js';
import { fail, hash, record } from './util.js';
const closedRuns = new Set(['COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED']);
export const followupUpdateSchema = obj({
    expectedVersion: int(1, Number.MAX_SAFE_INTEGER),
    action: { enum: ['claim', 'schedule', 'resolve', 'dismiss', 'reopen'] },
    note: str(10, 3000), dueAt: { type: 'string', format: 'date-time' }, nextAction: str(5, 1000)
}, ['expectedVersion', 'action', 'note']);
/** Human work only. Creating or closing a follow-up never dispatches a capability. */
export class Followups {
    store;
    constructor(store) {
        this.store = store;
    }
    /** Caller owns the event/migration transaction. Revalidate identity before backfilling old events. */
    ensureInside(tenant, eventId) {
        const row = this.store.db.prepare(`SELECT e.body,r.run_id FROM events e
            JOIN event_routes r ON r.tenant=e.tenant AND r.event_id=e.id
            WHERE e.tenant=? AND e.id=? AND e.consumed_by IS NULL AND r.state='quarantined'`)
            .get(tenant, eventId);
        if (!row?.run_id)
            return;
        const e = JSON.parse(row.body), run = this.store.getRun(tenant, row.run_id);
        if (!closedRuns.has(run.status) || e.receivedAt < run.createdAt)
            return;
        const binding = this.store.db.prepare(`SELECT run_id,recipient FROM correlations
            WHERE tenant=? AND event_type=? AND correlation=?`)
            .get(tenant, e.type, e.correlationId);
        if (binding?.run_id !== run.id)
            return;
        if (e.type === 'buyer.reply_received') {
            if (!record(e.payload) || typeof e.payload.from !== 'string' ||
                e.payload.from.trim().toLowerCase() !== binding.recipient)
                return;
        }
        else if (e.type !== 'sample.update')
            return;
        if (this.store.db.prepare('SELECT 1 FROM followups WHERE tenant=? AND event_id=?').get(tenant, eventId))
            return;
        const now = Date.now();
        const f = { id: randomUUID(), tenantId: tenant, runId: run.id, eventId,
            eventHash: hash(e), state: 'open', ownerId: null, dueAt: null, nextAction: '',
            version: 1, createdAt: now, updatedAt: now };
        this.store.db.prepare('INSERT INTO followups(tenant,id,run_id,event_id,body) VALUES(?,?,?,?,?)')
            .run(tenant, f.id, run.id, e.id, JSON.stringify(f));
        this.logInside(f, 'event-router', 'created', 'A matched event on a closed run requires human review.');
    }
    backfillInside() {
        const rows = this.store.db.prepare(`SELECT tenant,event_id FROM event_routes
            WHERE state='quarantined' AND run_id IS NOT NULL`).all();
        for (const r of rows)
            this.ensureInside(r.tenant, r.event_id);
    }
    get(tenant, id) {
        const row = this.store.db.prepare('SELECT body FROM followups WHERE tenant=? AND id=?')
            .get(tenant, id);
        if (!row)
            fail('NOT_FOUND', 'Follow-up not found', 404);
        return JSON.parse(row.body);
    }
    history(tenant, id) {
        this.get(tenant, id);
        return this.store.db.prepare('SELECT body FROM followup_history WHERE tenant=? AND followup_id=? ORDER BY version')
            .all(tenant, id).map(r => JSON.parse(r.body));
    }
    byRun(tenant, runId) {
        this.store.getRun(tenant, runId);
        return this.store.db.prepare('SELECT body FROM followups WHERE tenant=? AND run_id=? ORDER BY rowid')
            .all(tenant, runId).map(r => {
            const f = JSON.parse(r.body);
            return { ...f, history: this.history(tenant, f.id) };
        });
    }
    list(tenant, filter = 'active', before, limit = 50) {
        if (!['active', 'closed', 'all'].includes(filter) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
            (before !== undefined && (!Number.isSafeInteger(before) || before < 1)))
            fail('PAGINATION', 'Invalid follow-up filter, cursor or limit');
        const condition = filter === 'all' ? '' : filter === 'active' ?
            " AND json_extract(body,'$.state') IN ('open','in_progress')" :
            " AND json_extract(body,'$.state') IN ('resolved','dismissed')";
        const rows = this.store.db.prepare('SELECT rowid AS cursor,body FROM followups WHERE tenant=? AND rowid<?' + condition + ' ORDER BY rowid DESC LIMIT ?')
            .all(tenant, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
        return { items: rows.slice(0, limit).map(r => JSON.parse(r.body)),
            nextCursor: rows.length > limit ? rows[limit - 1].cursor : null };
    }
    summary(tenant, now = Date.now()) {
        const rows = this.store.db.prepare("SELECT body FROM followups WHERE tenant=? AND json_extract(body,'$.state') IN ('open','in_progress')")
            .all(tenant);
        const active = rows.map(r => JSON.parse(r.body));
        return { active: active.length, unassigned: active.filter(f => !f.ownerId).length,
            overdue: active.filter(f => f.dueAt && Date.parse(f.dueAt) <= now).length };
    }
    update(tenant, id, input, actor) {
        if (actor.tenantId !== tenant || !['admin', 'operator'].includes(actor.role))
            fail('FORBIDDEN', 'Operator or admin required', 403);
        assertSchema(followupUpdateSchema, input, 'FOLLOWUP_SCHEMA');
        if (input.note.trim().length < 10)
            fail('FOLLOWUP_NOTE', 'Provide a substantive handling note');
        if (input.action === 'schedule') {
            if (!input.dueAt || !Number.isFinite(Date.parse(input.dueAt)) || Date.parse(input.dueAt) <= Date.now() ||
                !input.nextAction || input.nextAction.trim().length < 5)
                fail('FOLLOWUP_SCHEDULE', 'Specify a future deadline and the next human action');
        }
        else if (input.dueAt !== undefined || input.nextAction !== undefined)
            fail('FOLLOWUP_FIELDS', 'Only schedule may change deadline or next action');
        return this.store.transaction(() => {
            const f = this.get(tenant, id);
            if (f.version !== input.expectedVersion)
                fail('FOLLOWUP_STALE', 'Follow-up changed; reload before editing', 409);
            const active = ['open', 'in_progress'].includes(f.state);
            if ((input.action === 'reopen') === active)
                fail('FOLLOWUP_STATE', 'This operation does not apply to the current state', 409);
            if (f.ownerId && f.ownerId !== actor.userId && actor.role !== 'admin')
                fail('FOLLOWUP_OWNER', 'Only the owner or admin can change this follow-up', 403);
            if (input.action === 'claim') {
                f.ownerId = actor.userId;
                f.state = 'in_progress';
            }
            else if (input.action === 'schedule') {
                if (!f.ownerId)
                    fail('FOLLOWUP_UNASSIGNED', 'Claim the follow-up before scheduling', 409);
                f.dueAt = new Date(input.dueAt).toISOString();
                f.nextAction = input.nextAction.trim();
            }
            else if (input.action === 'reopen') {
                f.state = f.ownerId ? 'in_progress' : 'open';
            }
            else {
                if (!f.ownerId)
                    fail('FOLLOWUP_UNASSIGNED', 'Claim the follow-up before closing it', 409);
                f.state = input.action === 'resolve' ? 'resolved' : 'dismissed';
            }
            f.version++;
            f.updatedAt = Date.now();
            this.store.db.prepare('UPDATE followups SET body=? WHERE tenant=? AND id=?').run(JSON.stringify(f), tenant, id);
            this.logInside(f, actor.userId, input.action, input.note.trim());
            return f;
        });
    }
    logInside(f, actor, action, note) {
        const change = { version: f.version, at: f.updatedAt, actor, action, note,
            state: f.state, ownerId: f.ownerId, dueAt: f.dueAt, nextAction: f.nextAction };
        this.store.db.prepare('INSERT INTO followup_history(tenant,followup_id,version,body) VALUES(?,?,?,?)')
            .run(f.tenantId, f.id, f.version, JSON.stringify(change));
        this.store.audit(f.tenantId, actor, 'followup.' + action, { id: f.id, eventId: f.eventId,
            runId: f.runId, eventHash: f.eventHash, ...change });
    }
}
//# sourceMappingURL=followups.js.map