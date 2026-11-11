import type { Obj } from '../types.js';
export interface McpOptions {
    command: string;
    args: string[];
    env: Record<string, string>;
    timeoutMs: number;
}
/** Narrow stdio JSON-RPC client. No remote commands, sampling, roots, credential discovery or shell execution. */
export declare class McpClient {
    private options;
    private child;
    private sequence;
    private buffer;
    private closed;
    private pending;
    private tools;
    constructor(options: McpOptions);
    private receive;
    private abort;
    request(method: string, params: unknown): Promise<unknown>;
    connect(): Promise<void>;
    hasTool(name: string): boolean;
    call(name: string, args: Obj): Promise<Obj>;
    close(): void;
}
