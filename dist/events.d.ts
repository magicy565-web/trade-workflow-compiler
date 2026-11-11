import type { Store } from './store.js';
import type { BusinessEvent, Principal, Run, TaskNode } from './types.js';
export declare const eventInputSchema: import("./schema.js").Schema;
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
export declare function normalizeEmail(email: string): string;
export declare function validateEvent(e: Pick<BusinessEvent, 'type' | 'payload'>): void;
/** Only gateway-authenticated, structurally valid events enter this inbox. Sender matching is NOT email sender authentication. */
export declare class EventInbox {
    readonly store: Store;
    constructor(store: Store);
    ingest(e: BusinessEvent, actor: Principal): {
        duplicate: boolean;
        state: EventState;
    };
    /** Call within the action-receipt transaction: a correlation belongs to one run, forever. */
    bindInside(tenant: string, type: string, correlation: string, runId: string, recipient: string | null): void;
    /** Bind send receipts to the approved recipient; used by normal execution AND reconciliation. */
    bindReceiptInside(run: Run, node: TaskNode, input: unknown, output: unknown): void;
    private routeInside;
    refreshRunInside(tenant: string, runId: string): void;
    recheck(tenant: string, id: string, actor: Principal): InboxEntry;
    get(tenant: string, id: string): InboxEntry;
    list(tenant: string, before?: number, limit?: number): {
        items: InboxEntry[];
        nextCursor: number | null;
    };
}
export declare function webhookSignature(secret: string, sourceId: string, timestamp: string, raw: Buffer): string;
export declare function verifyWebhook(source: EventSource | undefined, timestamp: string | undefined, signature: string | undefined, raw: Buffer, now?: number): void;
