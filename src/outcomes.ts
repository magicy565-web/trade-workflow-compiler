import { randomUUID } from 'node:crypto';
import type { Principal, Run } from './types.js';
import type { Store } from './store.js';
import { assertSchema, obj, str, int } from './schema.js';
import { fail, hash, record } from './util.js';
import { Followups } from './followups.js';

/** All claims are human-reported. A reviewed claim is not independent confirmation of a sale. */
export type OutcomeKind = 'outreach_sent' | 'buyer_replied' | 'qualified_lead' | 'rfq_received' |
    'quote_sent' | 'sample_requested' | 'sample_feedback' | 'order_confirmed';
export type EvidenceKind = 'business_event' | 'provider_receipt' | 'external_record';
export interface OutcomeEvidence {
    kind: EvidenceKind;
    reference: string;
    note: string;
}
export interface OutcomeInput {
    runId: string;
    idempotencyKey: string;
    kind: OutcomeKind;
    evidence: OutcomeEvidence;
    occurredAt: string;
    amountMinor?: number;
    currency?: 'USD';
}
export interface OutcomeRecord extends OutcomeInput {
    id: string;
    tenantId: string;
    inputHash: string;
    evidenceHash: string;
    evidenceKey: string;
    reportedBy: string;
    reportedAt: number;
    state: 'pending' | 'human_reviewed' | 'rejected';
    decidedBy?: string;
    decidedAt?: number;
    reviewNote?: string;
}
const evidenceSchema = obj({
    kind: { enum: ['business_event', 'provider_receipt', 'external_record'] },
    reference: str(1, 2000), note: str(10, 3000)
});
export const outcomeInputSchema = obj({
    runId: str(1, 100),
    idempotencyKey: { ...str(16, 80), pattern: '^[A-Za-z0-9_-]+$' },
    kind: { enum: ['outreach_sent', 'buyer_replied', 'qualified_lead', 'rfq_received', 'quote_sent', 'sample_requested', 'sample_feedback', 'order_confirmed'] },
    evidence: evidenceSchema,
    occurredAt: { type: 'string', format: 'date-time' },
    amountMinor: int(0, 100000000000000),
    currency: { const: 'USD' }
}, ['runId', 'idempotencyKey', 'kind', 'evidence', 'occurredAt']);

const receiptCapabilities: Partial<Record<OutcomeKind, string[]>> = {
    outreach_sent: ['outreach.send'], quote_sent: ['quote.send', 'quote.send_priced'], sample_requested: ['sample.request']
};
const externalKinds = new Set<OutcomeKind>([
    'order_confirmed', 'qualified_lead', 'rfq_received', 'buyer_replied', 'sample_feedback'
]);

function evidenceKey(input: OutcomeInput): string {
    // External commercial documents must not count twice across runs belonging to one tenant.
    // Internal receipt/event references are scoped to the originating run.
    return hash({ kind: input.kind, evidenceKind: input.evidence.kind,
        reference: input.evidence.reference.trim(),
        runId: input.evidence.kind === 'external_record' ? null : input.runId });
}

export class Outcomes {
    constructor(private store: Store) { }
    private validateReference(tenant: string, run: Run, input: OutcomeInput): void {
        const { kind, evidence } = input;
        if (evidence.kind === 'business_event') {
            const expected = kind === 'sample_feedback' ? 'sample.update' :
                ['buyer_replied', 'rfq_received'].includes(kind) ? 'buyer.reply_received' : null;
            if (!expected)
                fail('OUTCOME_EVIDENCE_TYPE', 'This outcome cannot be evidenced by a business event');
            const row = this.store.db.prepare(`SELECT e.event_type,e.consumed_by,r.state
                FROM events e JOIN event_routes r ON e.tenant=r.tenant AND e.id=r.event_id
                WHERE e.tenant=? AND e.id=?`).get(tenant, evidence.reference) as {
                event_type: string; consumed_by: string | null; state: string;
            } | undefined;
            if (!row || row.consumed_by !== run.id || row.state !== 'consumed')
                fail('OUTCOME_EVENT', 'Only a consumed event belonging to this run can support a claim');
            if (row.event_type !== expected)
                fail('OUTCOME_EVENT_TYPE', 'Business event type does not match the outcome');
            if (kind === 'rfq_received' && !Object.values(run.steps).some(s =>
                s.status === 'completed' && record(s.output) && s.output.category === 'rfq'))
                fail('OUTCOME_RFQ', 'RFQ claim requires an RFQ-classified reply or an external document');
        }
        else if (evidence.kind === 'provider_receipt') {
            const capability = receiptCapabilities[kind];
            if (!capability)
                fail('OUTCOME_EVIDENCE_TYPE', 'Only dispatch outcomes can cite provider receipts');
            const node = run.spec.nodes.find(n => n.type === 'action' && capability.includes(n.capability) && n.id === evidence.reference);
            const step = node ? run.steps[node.id] : undefined;
            if (!step || step.status !== 'completed' || evidence.reference !== node!.id || !record(step.output))
                fail('OUTCOME_RECEIPT', 'The referenced action was not completed in this run');
            if (typeof step.output.correlationId !== 'string' || !step.output.correlationId)
                fail('OUTCOME_RECEIPT', 'There is no durable provider correlation in the action result');
        }
        else if (evidence.kind === 'external_record') {
            if (!externalKinds.has(kind))
                fail('OUTCOME_EVIDENCE_TYPE', 'Use an internal action receipt instead of an external claim');
            // Pointer only. Never fetch the URL from this service (prevent SSRF); reviewer checks it separately.
            let url: URL;
            try { url = new URL(evidence.reference); }
            catch { return fail('OUTCOME_REFERENCE', 'Evidence pointer must be an HTTPS URL'); }
            if (url.protocol !== 'https:' || !!url.username || !!url.password || !url.hostname || url.hash)
                fail('OUTCOME_REFERENCE', 'Evidence must be HTTPS without credentials/fragments');
        }
        else fail('OUTCOME_EVIDENCE_TYPE', 'Unknown evidence kind');
        if (kind === 'order_confirmed' && evidence.kind !== 'external_record')
            fail('OUTCOME_ORDER', 'An order requires a separately referenced commercial document');
    }
    report(tenant: string, input: OutcomeInput, actor: Principal): OutcomeRecord {
        if (actor.tenantId !== tenant || !['admin', 'operator'].includes(actor.role))
            fail('FORBIDDEN', 'Operator or admin must report an outcome', 403);
        assertSchema(outcomeInputSchema, input, 'OUTCOME_SCHEMA');
        const when = Date.parse(input.occurredAt);
        if (!Number.isFinite(when) || when > Date.now() + 300000)
            fail('OUTCOME_DATE', 'Outcome date is invalid or in the future');
        if ((input.amountMinor === undefined) !== (input.currency === undefined) ||
            (input.amountMinor !== undefined && input.kind !== 'order_confirmed'))
            fail('OUTCOME_AMOUNT', 'Only order claims may include optional USD minor-unit amounts');
        const fingerprint = hash(input), uniqueEvidence = evidenceKey(input);
        return this.store.transaction(() => {
            const prior = this.store.db.prepare('SELECT body FROM outcomes WHERE tenant=? AND request_key=?')
                .get(tenant, input.idempotencyKey) as { body: string } | undefined;
            if (prior) {
                const existing = JSON.parse(prior.body) as OutcomeRecord;
                if (existing.inputHash !== fingerprint)
                    fail('OUTCOME_CONFLICT', 'Idempotency key belongs to a different claim', 409);
                return existing;
            }
            const duplicated = this.store.db.prepare('SELECT id FROM outcomes WHERE tenant=? AND evidence_key=?')
                .get(tenant, uniqueEvidence);
            if (duplicated) fail('OUTCOME_DUPLICATE_EVIDENCE', 'This evidence has already been claimed', 409);
            const run = this.store.getRun(tenant, input.runId);
            this.validateReference(tenant, run, input);
            const entry: OutcomeRecord = {
                ...structuredClone(input), id: randomUUID(), tenantId: tenant,
                inputHash: fingerprint, evidenceHash: hash(input.evidence), evidenceKey: uniqueEvidence,
                reportedBy: actor.userId, reportedAt: Date.now(), state: 'pending'
            };
            this.store.db.prepare('INSERT INTO outcomes(tenant,id,run_id,request_key,evidence_key,body) VALUES(?,?,?,?,?,?)')
                .run(tenant, entry.id, run.id, input.idempotencyKey, uniqueEvidence, JSON.stringify(entry));
            this.store.audit(tenant, actor.userId, 'outcome.reported', {
                id: entry.id, runId: run.id, kind: entry.kind, evidenceHash: entry.evidenceHash,
                amountMinor: entry.amountMinor ?? null
            });
            return entry;
        });
    }
    get(tenant: string, id: string): OutcomeRecord {
        const row = this.store.db.prepare('SELECT body FROM outcomes WHERE tenant=? AND id=?')
            .get(tenant, id) as { body: string } | undefined;
        if (!row) fail('NOT_FOUND', 'Outcome not found', 404);
        return JSON.parse(row.body) as OutcomeRecord;
    }
    list(tenant: string, limit = 200): OutcomeRecord[] {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
            fail('PAGINATION', 'Invalid outcome limit');
        return (this.store.db.prepare('SELECT body FROM outcomes WHERE tenant=? ORDER BY rowid DESC LIMIT ?')
            .all(tenant, limit) as { body: string }[]).map(r => JSON.parse(r.body) as OutcomeRecord);
    }
    byRun(tenant: string, runId: string): OutcomeRecord[] {
        this.store.getRun(tenant, runId);
        return (this.store.db.prepare('SELECT body FROM outcomes WHERE tenant=? AND run_id=? ORDER BY rowid')
            .all(tenant, runId) as { body: string }[]).map(r => JSON.parse(r.body) as OutcomeRecord);
    }
    decide(tenant: string, id: string, expectedHash: string, approved: boolean, note: string, actor: Principal): OutcomeRecord {
        if (actor.tenantId !== tenant || actor.role !== 'approver')
            fail('FORBIDDEN', 'Independent approver required', 403);
        if (typeof note !== 'string' || note.trim().length < 10 || note.length > 3000)
            fail('OUTCOME_REVIEW', 'Provide a substantive review note (10–3000 characters)');
        return this.store.transaction(() => {
            const entry = this.get(tenant, id);
            if (entry.reportedBy === actor.userId)
                fail('FOUR_EYES', 'Reporter cannot review their own claim', 403);
            if (entry.evidenceHash !== expectedHash || hash(entry.evidence) !== expectedHash)
                fail('OUTCOME_STALE', 'Evidence or review hash has changed', 409);
            if (entry.state !== 'pending')
                fail('OUTCOME_DECIDED', 'Outcome review is immutable', 409);
            this.validateReference(tenant, this.store.getRun(tenant, entry.runId), entry);
            entry.state = approved ? 'human_reviewed' : 'rejected';
            entry.decidedBy = actor.userId;
            entry.decidedAt = Date.now();
            entry.reviewNote = note.trim();
            this.store.db.prepare('UPDATE outcomes SET body=? WHERE tenant=? AND id=?')
                .run(JSON.stringify(entry), tenant, id);
            this.store.audit(tenant, actor.userId, 'outcome.' + entry.state, {
                id, runId: entry.runId, kind: entry.kind, evidenceHash: entry.evidenceHash,
                reviewNoteHash: hash(entry.reviewNote)
            });
            return entry;
        });
    }
    summary(tenant: string): unknown {
        // Complete dataset, not a paginated list. Avoid silently understating results.
        const runs = (this.store.db.prepare('SELECT body FROM runs WHERE tenant=?')
            .all(tenant) as { body: string }[]).map(r => JSON.parse(r.body) as Run);
        const claims = (this.store.db.prepare('SELECT body FROM outcomes WHERE tenant=?')
            .all(tenant) as { body: string }[]).map(r => JSON.parse(r.body) as OutcomeRecord);
        const runsByStatus: Record<string, number> = {}, humanReviewedByKind: Record<string, number> = {};
        for (const r of runs) runsByStatus[r.status] = (runsByStatus[r.status] ?? 0) + 1;
        for (const o of claims) if (o.state === 'human_reviewed')
            humanReviewedByKind[o.kind] = (humanReviewedByKind[o.kind] ?? 0) + 1;
        const orderAmountUsdMinor = claims
            .filter(o => o.state === 'human_reviewed' && o.kind === 'order_confirmed' && o.currency === 'USD')
            .reduce((sum, o) => sum + (o.amountMinor ?? 0), 0);
        return {
            calculatedAt: new Date().toISOString(), executionCount: runs.length, runsByStatus,
            reportedProviderCostMicros: runs.reduce((sum, r) => sum + r.actualMicros, 0),
            claimsPendingReview: claims.filter(o => o.state === 'pending').length,
            claimsRejected: claims.filter(o => o.state === 'rejected').length,
            humanReviewedByKind, humanReviewedOrderValueUsdMinor: orderAmountUsdMinor,
            disclaimer: 'Human review is not independent validation of settlement, identity, payment or actual revenue. Provider costs are self-reported, not billing records.'
        };
    }
    dossier(tenant: string, runId: string): unknown {
        const run = this.store.getRun(tenant, runId);
        const claims = this.byRun(tenant, runId);
        const approvals = this.store.approvalsByRun(tenant, runId);
        const consumedEvents = (this.store.db.prepare('SELECT body FROM events WHERE tenant=? AND consumed_by=? ORDER BY received_at')
            .all(tenant, runId) as { body: string }[]).map(r => JSON.parse(r.body));
        const manifest = { schemaVersion: 2, run, approvals, consumedEvents,
            followups: new Followups(this.store).byRun(tenant, runId),
            outcomeClaims: claims, auditChainValid: this.store.verifyAudit() };
        return { generatedAt: new Date().toISOString(), manifest,
            manifestSha256: hash(manifest), notes: 'Manifest SHA-256 is not a signature, trusted timestamp or third-party attestation.' };
    }
}
