import { createHash, timingSafeEqual } from 'node:crypto';
export class DomainError extends Error {
    code;
    httpStatus;
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}
export function fail(code, message, status = 400) { throw new DomainError(code, message, status); }
export function record(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
export function canonical(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function constantEqual(a, b) {
    const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest();
    return timingSafeEqual(x, y);
}
export function ownField(value, key) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key))
        fail('UNSAFE_FIELD', 'Unsafe field path');
    return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}
export function secureUrl(raw) {
    let u;
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
export async function boundedJson(response, limit = 1048576) {
    if (!response.body)
        fail('UPSTREAM', 'Empty upstream response');
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks = [];
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
export function errorCode(error) {
    return error instanceof DomainError ? error.code : 'EXECUTION_ERROR';
}
//# sourceMappingURL=util.js.map