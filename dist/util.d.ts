import type { Obj } from './types.js';
export declare class DomainError extends Error {
    code: string;
    httpStatus: number;
    constructor(code: string, message: string, httpStatus?: number);
}
export declare function fail(code: string, message: string, status?: number): never;
export declare function record(v: unknown): v is Obj;
export declare function canonical(value: unknown): string;
export declare function hash(value: unknown): string;
export declare function constantEqual(a: string, b: string): boolean;
export declare function ownField(value: unknown, key: string): unknown;
export declare function secureUrl(raw: string): URL;
export declare function boundedJson(response: Response, limit?: number): Promise<unknown>;
export declare function errorCode(error: unknown): string;
