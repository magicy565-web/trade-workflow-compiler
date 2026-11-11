import type { Capability } from './types.js';
export declare function defaultCapabilities(): Capability[];
export declare class Registry {
    private entries;
    constructor(capabilities?: Capability[]);
    private checkBinding;
    get(id: string): Capability | undefined;
    list(): Capability[];
    static fromFile(path: string): Registry;
}
