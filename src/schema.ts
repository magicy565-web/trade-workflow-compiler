/** Deliberately bounded JSON Schema subset. Unsupported keywords FAIL instead of being ignored. */
import { canonical, fail, record } from './util.js';
export interface Schema {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean | Schema;
    items?: Schema;
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    enum?: unknown[];
    const?: unknown;
    oneOf?: Schema[];
    format?: 'uri' | 'date-time' | 'email';
    pattern?: string;
}
const known = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'oneOf', 'format', 'pattern']);
export function validate(schema: Schema, value: unknown, path = '$', depth = 0): string[] {
    if (depth > 40)
        return [path + ': excessive nesting'];
    for (const key of Object.keys(schema))
        if (!known.has(key))
            return [`${path}: unsupported schema keyword ${key}`];
    if (schema.oneOf) {
        const matches = schema.oneOf.filter(s => validate(s, value, path, depth + 1).length === 0);
        return matches.length === 1 ? [] : [path + ': must match exactly one schema'];
    }
    const errors: string[] = [];
    if (Object.hasOwn(schema, 'const') && canonical(value) !== canonical(schema.const))
        errors.push(path + ': invalid constant');
    if (schema.enum && !schema.enum.some(x => canonical(x) === canonical(value)))
        errors.push(path + ': value not in enum');
    const t = schema.type;
    if (t === 'object') {
        if (!record(value))
            return [...errors, path + ': expected object'];
        for (const key of schema.required ?? [])
            if (!Object.hasOwn(value, key))
                errors.push(`${path}.${key}: required`);
        for (const [key, v] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                errors.push(`${path}: unsafe property`);
                continue;
            }
            const p = schema.properties?.[key];
            if (p)
                errors.push(...validate(p, v, `${path}.${key}`, depth + 1));
            else if (schema.additionalProperties === false)
                errors.push(`${path}.${key}: unknown field`);
            else if (record(schema.additionalProperties))
                errors.push(...validate(schema.additionalProperties as Schema, v, `${path}.${key}`, depth + 1));
        }
    }
    else if (t === 'array') {
        if (!Array.isArray(value))
            return [...errors, path + ': expected array'];
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 10000))
            errors.push(path + ': invalid array length');
        if (schema.items)
            value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`, depth + 1)));
    }
    else if (t === 'string') {
        if (typeof value !== 'string')
            return [...errors, path + ': expected string'];
        if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 100000))
            errors.push(path + ': invalid string length');
        if (schema.pattern && !new RegExp(schema.pattern).test(value))
            errors.push(path + ': pattern mismatch');
        if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))))
            errors.push(path + ': invalid timestamp');
        if (schema.format === 'email' && (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(value) || /[\r\n]/.test(value)))
            errors.push(path + ': invalid email');
        if (schema.format === 'uri') {
            try {
                const u = new URL(value);
                if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
                    throw Error();
            }
            catch {
                errors.push(path + ': invalid evidence URL');
            }
        }
    }
    else if (t === 'integer' || t === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value) || (t === 'integer' && !Number.isSafeInteger(value)))
            return [...errors, path + ': expected finite ' + t];
        if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))
            errors.push(path + ': number out of bounds');
    }
    else if (t === 'boolean' && typeof value !== 'boolean')
        errors.push(path + ': expected boolean');
    else if (t === 'null' && value !== null)
        errors.push(path + ': expected null');
    return errors;
}
export function assertSchema(schema: Schema, value: unknown, code = 'SCHEMA'): void {
    const errors = validate(schema, value);
    if (errors.length)
        fail(code, errors.slice(0, 12).join('; '));
}
export const str = (min = 1, max = 10000): Schema => ({ type: 'string', minLength: min, maxLength: max });
export const int = (min = 0, max = Number.MAX_SAFE_INTEGER): Schema => ({ type: 'integer', minimum: min, maximum: max });
export const array = (items: Schema, min = 0, max = 100): Schema => ({ type: 'array', items, minItems: min, maxItems: max });
export const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
