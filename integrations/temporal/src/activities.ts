export interface RunState {
    id: string;
    tenantId: string;
    status: string;
    nextWakeAt: number | null;
}
function config(): {
    base: string;
    token: string;
} {
    const base = process.env.TWC_API_URL ?? 'http://127.0.0.1:8787', token = process.env.TWC_WORKER_TOKEN;
    const url = new URL(base);
    if (url.username || url.password || url.hash || url.search || !['http:', 'https:'].includes(url.protocol))
        throw Error('Invalid API origin');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        throw Error('Remote TWC API requires HTTPS');
    if (!token || token.length < 32)
        throw Error('TWC_WORKER_TOKEN is required');
    return { base: base.replace(/\/$/, ''), token };
}
async function call(path: string, method = 'GET'): Promise<unknown> {
    const { base, token } = config();
    const r = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(90000) });
    if (!r.ok)
        throw Error('TWC API HTTP ' + r.status);
    const text = await r.text();
    if (text.length > 5000000)
        throw Error('API response too large');
    return JSON.parse(text);
}
function state(value: unknown): RunState {
    if (!value || typeof value !== 'object')
        throw Error('Invalid run state');
    const r = value as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.tenantId !== 'string' || typeof r.status !== 'string' || !(r.nextWakeAt === null || typeof r.nextWakeAt === 'number'))
        throw Error('Invalid run state');
    return { id: r.id, tenantId: r.tenantId, status: r.status, nextWakeAt: r.nextWakeAt as number | null };
}
// Only these small scheduling states enter Temporal history; credentials and business payloads stay in TWC.
export async function advanceRun(runId: string): Promise<RunState> { return state(await call(`/api/runs/${encodeURIComponent(runId)}/advance`, 'POST')); }
export async function listRuns(): Promise<RunState[]> { const r = await call('/api/runs'); if (!Array.isArray(r))
    throw Error('Invalid runs response'); return r.map(state); }
