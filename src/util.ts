import { createHash, timingSafeEqual } from 'node:crypto';
import type { Obj } from './types.js';
export class DomainError extends Error {
    constructor(public code: string, message: string, public httpStatus = 400) { super(message); }
}
export function fail(code: string, message: string, status = 400): never { throw new DomainError(code, message, status); }
export function record(v: unknown): v is Obj { return !!v && typeof v === 'object' && !Array.isArray(v); }
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Obj)[k])).join(',') + '}';
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function constantEqual(a: string, b: string): boolean {
    const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest();
    return timingSafeEqual(x, y);
}
export function ownField(value: unknown, key: string): unknown {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key))
        fail('UNSAFE_FIELD', 'Unsafe field path');
    return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}
export function secureUrl(raw: string): URL {
    let u: URL;
    try {
        u = new URL(raw);
    }
    catch {
        return fail('URL', 'Invalid endpoint URL');
    }
    if (u.username || u.password || u.hash || !['https:', 'http:'].includes(u.protocol))
        fail('URL', 'Credentials/fragments and non-HTTP URLs are forbidden');
    if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        fail('TLS_REQUIRED', 'HTTP is allowed only on loopback; use HTTPS elsewhere');
    return u;
}
export async function boundedJson(response: Response, limit = 1048576): Promise<unknown> {
    if (!response.body)
        fail('UPSTREAM', 'Empty upstream response');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                break;
            bytes += next.value.length;
            if (bytes > limit)
                fail('UPSTREAM_SIZE', 'Upstream response exceeds limit');
            chunks.push(next.value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        return fail('UPSTREAM_JSON', 'Upstream did not return valid JSON');
    }
}
export function errorCode(error: unknown): string {
    return error instanceof DomainError ? error.code : 'EXECUTION_ERROR';
}
