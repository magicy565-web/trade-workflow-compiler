import type { Adapter, Run, Principal } from '../types.js';
import { Store } from '../store.js';
import { Registry } from '../registry.js';
export declare function resolveInput(run: Run, ref: string): unknown;
export declare class Engine {
    readonly store: Store;
    readonly registry: Registry;
    private adapters;
    private now;
    readonly owner: `${string}-${string}-${string}-${string}-${string}`;
    constructor(store: Store, registry: Registry, adapters: Record<string, Adapter>, now?: () => number);
    tick(tenant: string, id: string): Promise<Run>;
    private finishInside;
    private finish;
    private advance;
    private verifyApproval;
    private checkSuppression;
    private checkRecipient;
    private task;
    cancel(tenant: string, id: string, actor: Principal): Run;
    reconcile(tenant: string, id: string, output: unknown, providerEvidence: string, actor: Principal): Run;
}
