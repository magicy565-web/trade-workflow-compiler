import type { Principal } from './types.js';
import type { Store } from './store.js';
/** All claims are human-reported. A reviewed claim is not independent confirmation of a sale. */
export type OutcomeKind = 'outreach_sent' | 'buyer_replied' | 'qualified_lead' | 'rfq_received' | 'quote_sent' | 'sample_requested' | 'sample_feedback' | 'order_confirmed';
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
export declare const outcomeInputSchema: import("./schema.js").Schema;
export declare class Outcomes {
    private store;
    constructor(store: Store);
    private validateReference;
    report(tenant: string, input: OutcomeInput, actor: Principal): OutcomeRecord;
    get(tenant: string, id: string): OutcomeRecord;
    list(tenant: string, limit?: number): OutcomeRecord[];
    byRun(tenant: string, runId: string): OutcomeRecord[];
    decide(tenant: string, id: string, expectedHash: string, approved: boolean, note: string, actor: Principal): OutcomeRecord;
    summary(tenant: string): unknown;
    dossier(tenant: string, runId: string): unknown;
}
