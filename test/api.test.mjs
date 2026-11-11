import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../dist/store.js';
import { Engine } from '../dist/runtime/engine.js';
import { createApi } from '../dist/api.js';
import { registry, request, output, reply } from './helpers.mjs';
async function fixture() {
    const store = new Store(':memory:'), reg = registry();
    let now = Date.now();
    let sends = 0;
    const engine = new Engine(store, reg, { http: { async execute(r) { if (r.capability.effect === 'external')
                sends++; return { status: 'completed', output: output[r.capability.id] }; } } }, () => now);
    const roles = ['admin', 'operator', 'approver', 'worker', 'ingest', 'viewer'];
    const keys = roles.map((role, i) => ({ tenantId: 'test-tenant', userId: 'person-' + role, role, token: String(i).repeat(64) }));
    keys.push({ tenantId: 'other', userId: 'other', role: 'viewer', token: 'z'.repeat(64) });
    const config = { dataDir: '.', registry: reg, keys, host: '127.0.0.1', port: 0, scheduler: 'external' };
    const server = createApi(config, store, engine);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    return { store, engine, server, keys, base, sends: () => sends, advance: () => now += 2500,
        async call(path, role = 'operator', body, method = body === undefined ? 'GET' : 'POST', extra = {}) { const key = keys.find(k => k.role === role || k.userId === role); const r = await fetch(base + path, { method, headers: { ...(key ? { authorization: 'Bearer ' + key.token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: await r.json() }; },
        async close() { await new Promise(resolve => server.close(resolve)); store.close(); }
    };
}
test('HTTP health and static UI are real, not a fixture route', async () => { const t = await fixture(); try {
    const h = await t.call('/health', 'none');
    assert.equal(h.status, 200);
    assert.equal(h.data.externalIntegrationsVerified, false);
    const page = await fetch(t.base);
    assert.match(await page.text(), /TRADE WORKFLOW COMPILER/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
}
finally {
    await t.close();
} });
test('API denies anonymous access and disallowed origins', async () => { const t = await fixture(); try {
    assert.equal((await t.call('/api/runs', 'none')).status, 401);
    assert.equal((await t.call('/api/runs', 'operator', undefined, 'GET', { origin: 'https://evil.invalid' })).status, 403);
}
finally {
    await t.close();
} });
test('role boundary rejects viewer compilation and operator approval', async () => { const t = await fixture(); try {
    assert.equal((await t.call('/api/compile', 'viewer', request())).status, 403);
    const c = await t.call('/api/compile', 'operator', request());
    assert.equal(c.status, 200);
    assert.equal((await t.call(`/api/workflows/${c.data.workflow.id}/1/publish`, 'operator', { hash: c.data.definition.hash })).status, 403);
}
finally {
    await t.close();
} });
test('invalid request fields and invalid event contracts are rejected', async () => { const t = await fixture(); try {
    assert.equal((await t.call('/api/compile', 'operator', { ...request(), tenantId: 'other' })).status, 400);
    assert.equal((await t.call('/api/events', 'ingest', { id: 'e', type: 'buyer.reply_received', correlationId: 'c', payload: {} })).status, 400);
}
finally {
    await t.close();
} });
test('ingest credentials cannot start runs or approve work', async () => { const t = await fixture(); try {
    assert.equal((await t.call('/api/runs', 'ingest', {})).status, 403);
    assert.equal((await t.call('/api/approvals/any/decision', 'ingest', {})).status, 403);
}
finally {
    await t.close();
} });
test('full API lifecycle with durable DB and authenticated event inbox', async () => {
    const t = await fixture();
    try {
        const c = await t.call('/api/compile', 'operator', request());
        assert.equal(c.data.status, 'ready_for_approval');
        const id = c.data.workflow.id;
        assert.equal((await t.call(`/api/workflows/${id}/1/publish`, 'approver', { hash: '0'.repeat(64) })).status, 409);
        assert.equal((await t.call(`/api/workflows/${id}/1/publish`, 'approver', { hash: c.data.definition.hash })).status, 200);
        const started = await t.call('/api/runs', 'operator', { workflowId: id, version: 1, idempotencyKey: 'api-test-request-key-0001' });
        assert.equal(started.status, 201);
        const runId = started.data.id;
        assert.equal((await t.call(`/api/runs/${runId}`, 'other')).status, 404);
        let current;
        for (let i = 0; i < 15; i++) {
            t.advance();
            current = await t.call(`/api/runs/${runId}/advance`, 'worker', {}, 'POST');
            if (current.data.status === 'WAITING_APPROVAL')
                break;
        }
        assert.equal(current.data.status, 'WAITING_APPROVAL');
        assert.equal(t.sends(), 0);
        const a = (await t.call('/api/approvals', 'approver')).data[0];
        assert.equal((await t.call(`/api/approvals/${a.id}/decision`, 'approver', { hash: a.payloadHash, approved: true })).status, 200);
        for (let i = 0; i < 10; i++) {
            t.advance();
            current = await t.call(`/api/runs/${runId}/advance`, 'worker', {}, 'POST');
            if (current.data.status === 'WAITING_EVENT')
                break;
        }
        assert.equal(current.data.status, 'WAITING_EVENT');
        assert.equal(t.sends(), 1);
        const e = { id: 'api-fixture-event', type: 'buyer.reply_received', correlationId: 'fixture-thread-1', payload: reply };
        assert.equal((await t.call('/api/events', 'ingest', e)).data.duplicate, false);
        assert.equal((await t.call('/api/events', 'ingest', e)).data.duplicate, true);
        for (let i = 0; i < 10; i++) {
            t.advance();
            current = await t.call(`/api/runs/${runId}/advance`, 'worker', {}, 'POST');
            if (current.data.status === 'COMPLETED')
                break;
        }
        assert.equal(current.data.status, 'COMPLETED');
        assert.equal(t.sends(), 1);
        assert((await t.call('/api/audit', 'approver')).data.chainValid);
    }
    finally {
        await t.close();
    }
});
