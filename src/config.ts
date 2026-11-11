import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Registry } from './registry.js';
import { assertSchema, array, obj, str } from './schema.js';
import type { Principal } from './types.js';
import { constantEqual, fail } from './util.js';
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
export function loadConfig(): Config {
    const dataDir = resolve(process.env.TWC_DATA_DIR ?? 'data');
    const keyPath = process.env.TWC_AUTH_FILE ?? resolve(dataDir, 'auth.local.json');
    if (!existsSync(keyPath))
        fail('AUTH_REQUIRED', 'Run npm run init to generate separate local operator, approver, worker and ingest credentials');
    const keys: unknown = JSON.parse(readFileSync(keyPath, 'utf8'));
    assertSchema(array(obj({ tenantId: str(1, 100), userId: str(1, 100), role: { enum: ['admin', 'operator', 'approver', 'worker', 'ingest', 'viewer'] }, token: str(32, 256) }), 1, 200), keys, 'AUTH_CONFIG');
    const typed = keys as AccessKey[];
    if (new Set(typed.map(k => k.token)).size !== typed.length)
        fail('AUTH_CONFIG', 'Access tokens must be distinct');
    const regPath = process.env.TWC_REGISTRY_FILE ?? resolve(dataDir, 'capabilities.local.json');
    const port = Number(process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        fail('PORT', 'Invalid port');
    const scheduler = process.env.TWC_SCHEDULER ?? 'embedded';
    if (!['embedded', 'external'].includes(scheduler))
        fail('SCHEDULER', 'Invalid scheduler');
    const eventPath = process.env.TWC_EVENT_SOURCES_FILE ?? resolve(dataDir, 'event-sources.local.json');
    const eventSources: unknown = existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, 'utf8')) : [];
    assertSchema(array(obj({ id: { ...str(1, 80), pattern: '^[a-zA-Z0-9_-]+$' }, tenantId: str(1, 100), secretEnv: { ...str(1, 100), pattern: '^[A-Z][A-Z0-9_]*$' }, enabled: { type: 'boolean' } }), 0, 100), eventSources, 'EVENT_SOURCES_CONFIG');
    const sources = eventSources as EventSource[];
    if (new Set(sources.map(s => s.id)).size !== sources.length)
        fail('EVENT_SOURCES_CONFIG', 'Duplicate event source ids');
    for (const source of sources)
        if (!typed.some(k => k.tenantId === source.tenantId))
            fail('EVENT_SOURCES_CONFIG', 'Event source tenant has no configured principal');
    return { eventSources: sources, dataDir, keys: typed, registry: existsSync(regPath) ? Registry.fromFile(regPath) : new Registry(), host: process.env.HOST ?? '127.0.0.1', port, scheduler: scheduler as Config['scheduler'], publicOrigin: process.env.TWC_PUBLIC_ORIGIN };
}
export function authenticate(header: string | undefined, keys: AccessKey[]): Principal {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    let match: AccessKey | undefined;
    for (const key of keys)
        if (constantEqual(token, key.token))
            match = key;
    if (!match)
        fail('UNAUTHORIZED', 'A valid bearer token is required', 401);
    return { tenantId: match.tenantId, userId: match.userId, role: match.role };
}
