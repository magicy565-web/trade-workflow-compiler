import type { Store } from './store.js';
import type { Principal, Run } from './types.js';
import type { Registry } from './registry.js';
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
export declare class Batches {
    readonly store: Store;
    constructor(store: Store);
    get(tenant: string, id: string): Batch;
    putInside(b: Batch): void;
    members(tenant: string, id: string): Run[];
    view(tenant: string, id: string): {
        batch: Batch;
        status: string;
        counts: Record<string, number>;
        runs: Run[];
    };
    list(tenant: string): {
        total: number;
        batch: Batch;
        status: string;
        counts: Record<string, number>;
    }[];
    preview(tenant: string, runId: string): {
        sourceRunId: string;
        buyers: BuyerRow[];
        perRecipientMicros: number;
        alreadyReservedMicros: number;
        budgetMicros: number;
        maxAffordableRecipients: number;
    };
    create(tenant: string, sourceRunId: string, emails: string[], key: string, actor: Principal, registry: Registry): Batch;
    control(tenant: string, id: string, state: Batch['state'], actor: Principal): Batch;
    /** Must be called in the same transaction as the step reservation. No optimistic in-memory counters. */
    reserveInside(r: Run, micros: number): boolean;
    chargeInside(r: Run, micros: number, overrun: boolean): void;
}
export {};
