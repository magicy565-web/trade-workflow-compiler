import type { Store } from './store.js';
import type { Principal } from './types.js';
export interface Followup {
    id: string;
    tenantId: string;
    runId: string;
    eventId: string;
    eventHash: string;
    state: 'open' | 'in_progress' | 'resolved' | 'dismissed';
    ownerId: string | null;
    dueAt: string | null;
    nextAction: string;
    version: number;
    createdAt: number;
    updatedAt: number;
}
export interface FollowupUpdate {
    expectedVersion: number;
    action: 'claim' | 'schedule' | 'resolve' | 'dismiss' | 'reopen';
    note: string;
    dueAt?: string;
    nextAction?: string;
}
export declare const followupUpdateSchema: import("./schema.js").Schema;
export type FollowupFilter = 'active' | 'closed' | 'all';
/** Human work only. Creating or closing a follow-up never dispatches a capability. */
export declare class Followups {
    private store;
    constructor(store: Store);
    /** Caller owns the event/migration transaction. Revalidate identity before backfilling old events. */
    ensureInside(tenant: string, eventId: string): void;
    backfillInside(): void;
    get(tenant: string, id: string): Followup;
    history(tenant: string, id: string): unknown[];
    byRun(tenant: string, runId: string): unknown[];
    list(tenant: string, filter?: FollowupFilter, before?: number, limit?: number): {
        items: Followup[];
        nextCursor: number | null;
    };
    summary(tenant: string, now?: number): {
        active: number;
        unassigned: number;
        overdue: number;
    };
    update(tenant: string, id: string, input: FollowupUpdate, actor: Principal): Followup;
    private logInside;
}
