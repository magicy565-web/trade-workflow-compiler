import type { Adapter, AdapterRequest, AdapterResult, Capability } from '../types.js';
/** Contract: authenticated GET {base}/health and POST {base}/execute. See docs/gateway-contract.md. */
export declare class HttpGatewayAdapter implements Adapter {
    private settings;
    doctor(c: Capability): Promise<{
        ready: boolean;
        detail: string;
    }>;
    execute(req: AdapterRequest): Promise<AdapterResult>;
}
