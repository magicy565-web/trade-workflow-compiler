import type { Adapter, AdapterRequest, AdapterResult, Capability } from '../types.js';
export declare class OpenMausBotAdapter implements Adapter {
    doctor(c: Capability): Promise<{
        ready: boolean;
        detail: string;
    }>;
    execute(req: AdapterRequest): Promise<AdapterResult>;
}
