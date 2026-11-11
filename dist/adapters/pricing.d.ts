import type { Adapter, AdapterRequest, AdapterResult, Capability } from '../types.js';
/** Read finalized customer data only. No cost, policy, calculation, approval or send endpoints. */
export declare class PricingAdapter implements Adapter {
    private now;
    constructor(now?: () => number);
    private settings;
    private get;
    private identity;
    doctor(c: Capability): Promise<{
        ready: boolean;
        detail: string;
    }>;
    private draft;
    execute(req: AdapterRequest): Promise<AdapterResult>;
    validateForDispatch(req: AdapterRequest, approvedPayload: unknown): Promise<void>;
}
