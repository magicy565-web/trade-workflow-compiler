import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Principal, Run, TaskNode } from './types.js';
import type { Registry } from './registry.js';
import { assertSchema } from './schema.js';
import { contracts } from './contracts.js';
import { edges, validateWorkflow } from './compiler/validator.js';
import { fail, hash, record } from './util.js';
import { EventInbox, normalizeEmail } from './events.js';
export interface Batch {
    id: string;
    tenantId: string;
    sourceRunId: string;
    requestKey: string;
    selectionHash: string;
    createdBy: string;
    createdAt: number;
    state: 'active' | 'paused' | 'cancelled';
    budgetMicros: number;
    reservedMicros: number;
    actualMicros: number;
}
interface BuyerRow {
    email: string | null;
    companyName: string;
    eligible: boolean;
    reason: string | null;
    buyer: unknown;
}
export class Batches {
    constructor(readonly store: Store) { }
    get(tenant: string, id: string): Batch {
        const row = this.store.db.prepare('SELECT body FROM batches WHERE tenant=? AND id=?').get(tenant, id) as {
            body: string;
        } | undefined;
        if (!row)
            fail('NOT_FOUND', 'Batch not found', 404);
        return JSON.parse(row.body) as Batch;
    }
    putInside(b: Batch): void { this.store.db.prepare('UPDATE batches SET body=? WHERE tenant=? AND id=?').run(JSON.stringify(b), b.tenantId, b.id); }
    members(tenant: string, id: string): Run[] {
        this.get(tenant, id);
        const rows = this.store.db.prepare('SELECT run_id FROM batch_members WHERE tenant=? AND batch_id=? ORDER BY target_email').all(tenant, id) as {
            run_id: string;
        }[];
        return rows.map(r => this.store.getRun(tenant, r.run_id));
    }
    view(tenant: string, id: string) {
        const batch = this.get(tenant, id), runs = this.members(tenant, id), counts: Record<string, number> = {};
        for (const r of runs)
            counts[r.status] = (counts[r.status] ?? 0) + 1;
        const closed = ['COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION'];
        const status = runs.some(r => r.status === 'NEEDS_RECONCILIATION') ? 'NEEDS_RECONCILIATION' : batch.state === 'cancelled' ? 'CANCELLED' : runs.every(r => closed.includes(r.status)) ? 'FINISHED' : batch.state === 'paused' ? 'PAUSED' : 'ACTIVE';
        return { batch, status, counts, runs };
    }
    list(tenant: string) { const rows = this.store.db.prepare('SELECT id FROM batches WHERE tenant=? ORDER BY rowid DESC LIMIT 100').all(tenant) as {
        id: string;
    }[]; return rows.map(r => { const { runs, ...summary } = this.view(tenant, r.id); return { ...summary, total: runs.length }; }); }
    preview(tenant: string, runId: string) {
        const source = this.store.getRun(tenant, runId);
        if (source.spec.playbook !== 'buyer-development' || source.batchId || source.status !== 'BATCH_READY')
            fail('BATCH_STATE', 'Source must be a buyer-development run paused at BATCH_READY', 409);
        if (Date.now() >= Math.min(source.createdAt + source.spec.policy.maxRunSeconds * 1000, source.deadlineAt ?? Infinity))
            fail('BATCH_EXPIRED', 'Source authorization window has expired', 409);
        const definition = this.store.getDefinition(tenant, source.workflowId, source.version);
        if (definition.status !== 'published' || definition.hash !== hash(source.spec))
            fail('WORKFLOW_INTEGRITY', 'Source does not match its published workflow version', 409);
        const node = source.spec.nodes.find(n => n.id === source.current);
        if (!node || node.type !== 'agent_task' || node.capability !== 'outreach.draft')
            fail('BATCH_SHAPE', 'Batch fan-out is only supported immediately before outreach drafting', 409);
        const step = source.steps[node.input];
        if (step?.status !== 'completed')
            fail('BATCH_INPUT', 'Qualified buyers are not ready', 409);
        assertSchema(contracts.QualifiedBuyersV1!, step.output, 'BATCH_INPUT');
        if (!record(step.output) || !Array.isArray(step.output.buyers))
            fail('BATCH_INPUT', 'Missing buyers');
        // Reject altered workflows whose completed prefix already performed external actions.
        if (source.spec.nodes.some(n => n.type === 'action' && source.steps[n.id]))
            fail('BATCH_SHAPE', 'An external action already started', 409);
        const counts = new Map<string, number>();
        for (const b of step.output.buyers)
            if (record(b) && typeof b.contactEmail === 'string') {
                const e = normalizeEmail(b.contactEmail);
                counts.set(e, (counts.get(e) ?? 0) + 1);
            }
        const buyers: BuyerRow[] = step.output.buyers.map(b => {
            if (!record(b))
                fail('BATCH_INPUT', 'Invalid buyer');
            const email = typeof b.contactEmail === 'string' ? normalizeEmail(b.contactEmail) : null;
            const reason = !email ? 'Missing contact email' : counts.get(email)! > 1 ? 'Duplicate contact email requires source correction' : this.store.isSuppressed(tenant, email) ? 'Recipient is suppressed' : null;
            return { email, companyName: String(b.companyName), eligible: reason === null, reason, buyer: b };
        });
        const visited = new Set<string>();
        let perRecipientMicros = 0;
        const walk = (id: string): void => { if (id === 'END' || visited.has(id))
            return; visited.add(id); const n = source.spec.nodes.find(x => x.id === id); if (!n)
            fail('BATCH_SHAPE', 'Missing downstream node'); if (n.type === 'action' || n.type === 'agent_task')
            perRecipientMicros += n.maxCostMicros * n.maxAttempts; for (const edge of edges(n))
            walk(edge); };
        walk(source.current);
        if (!Number.isSafeInteger(perRecipientMicros))
            fail('BUDGET', 'Invalid batch reservation');
        return { sourceRunId: runId, buyers, perRecipientMicros, alreadyReservedMicros: source.reservedMicros, budgetMicros: source.spec.context.budgetMicros, maxAffordableRecipients: perRecipientMicros ? Math.max(0, Math.floor((source.spec.context.budgetMicros - source.reservedMicros) / perRecipientMicros)) : buyers.length };
    }
    create(tenant: string, sourceRunId: string, emails: string[], key: string, actor: Principal, registry: Registry): Batch {
        if (actor.tenantId !== tenant || !['admin', 'operator'].includes(actor.role))
            fail('FORBIDDEN', 'Operator required', 403);
        if (!/^[A-Za-z0-9_-]{16,80}$/.test(key))
            fail('IDEMPOTENCY_KEY', 'Use 16-80 letters, digits, underscores or hyphens');
        const selected = emails.map(normalizeEmail).sort();
        if (!selected.length || selected.length > 50 || new Set(selected).size !== selected.length)
            fail('BATCH_SELECTION', 'Select 1-50 distinct recipients');
        const selectionHash = hash({ sourceRunId, selected });
        return this.store.transaction(() => {
            const prior = this.store.db.prepare('SELECT body FROM batches WHERE tenant=? AND request_key=?').get(tenant, key) as {
                body: string;
            } | undefined;
            if (prior) {
                const b = JSON.parse(prior.body) as Batch;
                if (b.selectionHash !== selectionHash)
                    fail('IDEMPOTENCY_CONFLICT', 'Batch key belongs to different recipients', 409);
                return b;
            }
            if (this.store.db.prepare('SELECT id FROM batches WHERE tenant=? AND source_run=?').get(tenant, sourceRunId))
                fail('BATCH_EXISTS', 'Source was already fanned out; do not start another batch', 409);
            const preview = this.preview(tenant, sourceRunId), source = this.store.getRun(tenant, sourceRunId);
            const errors = validateWorkflow(source.spec, registry);
            if (errors.length)
                fail('COMPILE_BLOCKED', errors.map(e => e.code).join(', '), 409);
            const picks = selected.map(e => { const b = preview.buyers.find(b => b.email === e && b.eligible); if (!b)
                fail('BATCH_SELECTION', 'Selection is missing, duplicated or suppressed: ' + e); return b; });
            const reserved = source.reservedMicros + preview.perRecipientMicros * picks.length;
            if (!Number.isSafeInteger(reserved) || reserved > preview.budgetMicros)
                fail('BATCH_BUDGET', `Selected recipients require ${reserved} micro-USD including completed research; authorized budget is ${preview.budgetMicros}`, 409);
            const now = Date.now(), id = randomUUID();
            const b: Batch = { id, tenantId: tenant, sourceRunId, requestKey: key, selectionHash, createdBy: actor.userId, createdAt: now, state: 'active', budgetMicros: preview.budgetMicros, reservedMicros: source.reservedMicros, actualMicros: source.actualMicros };
            this.store.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?)').run(tenant, id, sourceRunId, key, JSON.stringify(b));
            const draft = source.spec.nodes.find(n => n.id === source.current) as TaskNode;
            for (const pick of picks) {
                const child: Run = { ...structuredClone(source), id: randomUUID(), requestKey: hash({ batch: id, email: pick.email }), createdBy: actor.userId, batchId: id, sourceRunId, targetEmail: pick.email!, deadlineAt: Math.min(source.createdAt + source.spec.policy.maxRunSeconds * 1000, source.deadlineAt ?? Infinity), status: 'PENDING', reservedMicros: 0, actualMicros: 0, createdAt: now, updatedAt: now, nextWakeAt: now };
                delete child.error;
                for (const s of Object.values(child.steps)) {
                    s.attempts = 0;
                    s.inheritedFromRunId = sourceRunId;
                }
                const qualification = child.steps[draft.input]!;
                qualification.output = { ...(qualification.output as Record<string, unknown>), buyers: [structuredClone(pick.buyer)] };
                this.store.db.prepare('INSERT INTO runs(tenant,id,request_key,body) VALUES(?,?,?,?)').run(tenant, child.id, child.requestKey, JSON.stringify(child));
                this.store.db.prepare('INSERT INTO batch_members VALUES(?,?,?,?)').run(tenant, id, child.id, pick.email!);
                this.store.audit(tenant, actor.userId, 'run.fanned_out', { runId: child.id, batchId: id, sourceRunId, targetEmail: pick.email, qualifiedInputHash: hash(qualification.output) });
            }
            // Parent must not send too. This cancellation and every child creation share one transaction.
            source.status = 'CANCELLED';
            source.nextWakeAt = null;
            source.error = 'Replaced by independent recipient runs in batch ' + id;
            this.store.putRun(source);
            this.store.audit(tenant, actor.userId, 'batch.created', { batchId: id, sourceRunId, selectionHash, recipients: picks.length, budgetMicros: b.budgetMicros });
            return b;
        });
    }
    control(tenant: string, id: string, state: Batch['state'], actor: Principal): Batch {
        if (actor.tenantId !== tenant || !['admin', 'operator'].includes(actor.role))
            fail('FORBIDDEN', 'Operator required', 403);
        return this.store.transaction(() => {
            const b = this.get(tenant, id);
            if (b.state === 'cancelled' && state !== 'cancelled')
                fail('BATCH_CLOSED', 'Cancelled batches cannot resume', 409);
            if (state === 'active' && (b.actualMicros > b.budgetMicros || this.members(tenant, id).some(r => r.status === 'NEEDS_RECONCILIATION')))
                fail('BATCH_RECONCILIATION', 'Resolve uncertain actions or cost overruns first', 409);
            b.state = state;
            this.putInside(b);
            if (state === 'cancelled')
                for (const r of this.members(tenant, id)) {
                    if (['COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION'].includes(r.status))
                        continue;
                    const node = r.spec.nodes.find(n => n.id === r.current);
                    r.status = node?.type === 'action' && r.steps[node.id]?.status === 'running' ? 'NEEDS_RECONCILIATION' : 'CANCELLED';
                    r.nextWakeAt = null;
                    r.error = 'Batch cancelled; already dispatched remote operations are not undone';
                    this.store.putRun(r);
                    new EventInbox(this.store).refreshRunInside(tenant, r.id);
                    this.store.audit(tenant, actor.userId, 'run.batch_cancelled', { runId: r.id, batchId: id, status: r.status });
                }
            this.store.audit(tenant, actor.userId, 'batch.' + state, { batchId: id });
            return b;
        });
    }
    /** Must be called in the same transaction as the step reservation. No optimistic in-memory counters. */
    reserveInside(r: Run, micros: number): boolean {
        if (!r.batchId)
            return true;
        const b = this.get(r.tenantId, r.batchId);
        if (b.state !== 'active')
            return false;
        if (b.reservedMicros + micros > b.budgetMicros)
            fail('BATCH_BUDGET', 'Shared batch budget exhausted', 409);
        b.reservedMicros += micros;
        this.putInside(b);
        return true;
    }
    chargeInside(r: Run, micros: number, overrun: boolean): void {
        if (!r.batchId)
            return;
        const b = this.get(r.tenantId, r.batchId);
        b.actualMicros += micros;
        if (overrun || b.actualMicros > b.budgetMicros)
            b.state = 'paused';
        this.putInside(b);
    }
}
