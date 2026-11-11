import { Registry } from './registry.js';
import type { Principal } from './types.js';
import type { EventSource } from './events.js';
export interface AccessKey extends Principal {
    token: string;
}
export interface Config {
    dataDir: string;
    registry: Registry;
    keys: AccessKey[];
    host: string;
    port: number;
    scheduler: 'embedded' | 'external';
    publicOrigin?: string;
    eventSources?: EventSource[];
}
export declare function loadConfig(): Config;
export declare function authenticate(header: string | undefined, keys: AccessKey[]): Principal;
