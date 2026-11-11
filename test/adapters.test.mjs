import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { OpenMausBotAdapter } from '../dist/adapters/openmausbot.js';
import { HttpGatewayAdapter } from '../dist/adapters/http.js';
import { defaultCapabilities } from '../dist/registry.js';
import { selectPlaybook } from '../dist/compiler/llm.js';
import { output, context, request } from './helpers.mjs';
function ombFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'twc-mcp-')), state = join(dir, 'state.json'), answer = join(dir, 'answer.json');
    writeFileSync(answer, JSON.stringify(output['market.research']));
    process.env.TWC_FIXTURE_STATE = state;
    process.env.TWC_FIXTURE_OUTPUT = answer;
    const cap = { ...defaultCapabilities()[0], enabled: true, binding: { adapter: 'openmausbot', botId: 'fixture-bot', command: process.execPath, args: [resolve('test/fixtures/mcp-server.mjs')], envKeys: ['TWC_FIXTURE_STATE', 'TWC_FIXTURE_OUTPUT', 'TWC_FIXTURE_JOB_STATE', 'TWC_FIXTURE_BAD_ID'], readOnlyProfileAttested: true } };
    const req = { idempotencyKey: 'a'.repeat(64), tenantId: 'fixture', runId: 'fixture-run', stepId: 'research', capability: cap, input: context, context, businessRequest: request().request, deadlineMs: 5000 };
    return { dir, state, cap, req, cleanup() { delete process.env.TWC_FIXTURE_STATE; delete process.env.TWC_FIXTURE_OUTPUT; delete process.env.TWC_FIXTURE_JOB_STATE; delete process.env.TWC_FIXTURE_BAD_ID; rmSync(dir, { recursive: true, force: true }); } };
}
test('OpenMausBot adapter executes verified public MCP protocol over real subprocess pipes', async () => {
    const f = ombFixture();
    try {
        const a = new OpenMausBotAdapter();
        assert((await a.doctor(f.cap)).ready);
        let req = f.req;
        let r;
        for (let i = 0; i < 5; i++) {
            r = await a.execute(req);
            if (r.status === 'completed')
                break;
            req = { ...req, continuation: r.continuation };
        }
        assert.equal(r.status, 'completed');
        assert.deepEqual(r.output, output['market.research']);
        const s = JSON.parse(readFileSync(f.state, 'utf8'));
        assert.equal(s.tasks, 1);
        assert.equal(s.sends, 1);
    }
    finally {
        f.cleanup();
    }
});
test('OpenMausBot send_id is reused safely after a lost send acknowledgement', async () => { const f = ombFixture(); try {
    const a = new OpenMausBotAdapter(), created = await a.execute(f.req);
    const req = { ...f.req, continuation: created.continuation };
    await a.execute(req);
    await a.execute(req);
    assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).sends, 1);
}
finally {
    f.cleanup();
} });
for (const state of ['failed', 'stalled', 'idle'])
    test('settled is not accepted as success when job state is ' + state, async () => { const f = ombFixture(); try {
        process.env.TWC_FIXTURE_JOB_STATE = state;
        const a = new OpenMausBotAdapter();
        let r = await a.execute(f.req);
        r = await a.execute({ ...f.req, continuation: r.continuation });
        await assert.rejects(() => a.execute({ ...f.req, continuation: r.continuation }));
    }
    finally {
        f.cleanup();
    } });
test('MCP result for wrong request is rejected', async () => { const f = ombFixture(); try {
    process.env.TWC_FIXTURE_BAD_ID = '1';
    const a = new OpenMausBotAdapter();
    let r = await a.execute(f.req);
    r = await a.execute({ ...f.req, continuation: r.continuation });
    await assert.rejects(() => a.execute({ ...f.req, continuation: r.continuation }), /identity/);
}
finally {
    f.cleanup();
} });
test('OpenMausBot adapter cannot run external actions', async () => { const f = ombFixture(); try {
    await assert.rejects(() => new OpenMausBotAdapter().execute({ ...f.req, capability: { ...f.cap, effect: 'external' } }), /read-only/);
}
finally {
    f.cleanup();
} });
async function gateway(handler) { const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return { server, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) }; }
test('HTTP adapter verifies live health contract, HMAC, final receipt and idempotency key', async () => {
    const secret = 'fixture-gateway-secret-'.repeat(3);
    process.env.TWC_TEST_GATEWAY_SECRET = secret;
    let sends = 0;
    const seen = new Set();
    const g = await gateway(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        assert.equal(req.headers.authorization, 'Bearer ' + secret);
        if (req.url === '/health') {
            res.end(JSON.stringify({ status: 'ok', idempotency: 'durable', capabilities: [{ id: 'outreach.send', version: '1.0.0' }] }));
            return;
        }
        let body = '';
        for await (const chunk of req)
            body += chunk;
        assert.equal(req.headers['x-twc-signature'], createHmac('sha256', secret).update(req.headers['x-twc-timestamp'] + '.' + body).digest('hex'));
        const p = JSON.parse(body);
        assert.deepEqual(p.context, context);
        assert.equal(p.businessRequest, request().request);
        assert.equal(p.idempotencyKey, req.headers['idempotency-key']);
        if (!seen.has(p.idempotencyKey)) {
            seen.add(p.idempotencyKey);
            sends++;
        }
        res.end(JSON.stringify({ status: 'completed', idempotencyKey: p.idempotencyKey, output: output['outreach.send'] }));
    });
    try {
        const cap = { ...defaultCapabilities().find(c => c.id === 'outreach.send'), enabled: true, binding: { adapter: 'http', endpoint: g.url, secretEnv: 'TWC_TEST_GATEWAY_SECRET' } };
        const req = { idempotencyKey: 'g'.repeat(64), tenantId: 'fixture', runId: 'fixture', stepId: 'send', capability: cap, input: output['outreach.draft'], context, businessRequest: request().request, deadlineMs: 5000 };
        const a = new HttpGatewayAdapter();
        assert.equal((await a.execute(req)).status, 'completed');
        await a.execute(req);
        assert.equal(sends, 1);
    }
    finally {
        await g.close();
        delete process.env.TWC_TEST_GATEWAY_SECRET;
    }
});
test('optional LLM selector validates grounded output without executing tools', async () => { const g = await gateway(async (req, res) => { let body = ''; for await (const chunk of req)
    body += chunk; const p = JSON.parse(body); assert.equal(p.response_format.type, 'json_object'); assert.equal(p.tools, undefined); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ playbook: 'buyer-development', supportingQuotes: ['开发美国中小品牌客户'] }) } }] })); }); try {
    assert.equal((await selectPlaybook(request(), { endpoint: g.url, apiKey: 'fixture', model: 'fixture-only' })).playbook, 'buyer-development');
}
finally {
    await g.close();
} });
test('LLM fabricated supporting quote is rejected', async () => { const g = await gateway((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ playbook: 'buyer-development', supportingQuotes: ['not in the request'] }) } }] })); }); try {
    await assert.rejects(() => selectPlaybook(request(), { endpoint: g.url, apiKey: 'fixture', model: 'fixture-only' }), /not present/);
}
finally {
    await g.close();
} });
