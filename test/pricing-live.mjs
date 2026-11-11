// Explicit integration entry point. Requires a separate checkout of trade-pricing-engine v0.2.0.
// Synthetic fixture data and a recording gateway only; NO real customer email is sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from '../dist/util.js';
import { PricingAdapter } from '../dist/adapters/pricing.js';
import { configured, httpFixture, workflow, adapterRequest, viewerToken } from './pricing-helpers.mjs';

const source = process.env.TWC_PRICING_SOURCE, python = process.env.TWC_PRICING_PYTHON;
if (!source || !python || !existsSync(join(source, 'trade_pricing/api.py')))
    throw Error('Set TWC_PRICING_SOURCE to the pricing source checkout and TWC_PRICING_PYTHON to its installed Python interpreter');
const dir = mkdtempSync(join(tmpdir(), 'twc-live-pricing-'));
let gateway, child, lines, exited = false; const stores = [];
try {
    child = spawn(python, [resolve('test/fixtures/pricing-server.py')], { env: { ...process.env,
        TWC_PRICING_SOURCE: resolve(source), TWC_PRICING_TEST_DB: join(dir, 'isolated-pricing.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => stderr += b); child.on('exit', () => exited = true);
    lines = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
        once(lines, 'line'), once(child, 'error').then(([error]) => { throw error; }),
        once(child, 'exit').then(() => { throw Error('Pricing subprocess ended: ' + stderr); }),
        delay(10000, null, { ref: false }).then(() => { throw Error('Pricing subprocess startup timed out'); })
    ]);
    const setup = JSON.parse(line);
    for (let i = 0; ; i++) {
        try { const r = await fetch(setup.url + '/health'); assert.equal((await r.json()).version, '0.2.0'); break; }
        catch (e) { if (i === 50 || exited) throw Error('Pricing API failed: ' + stderr, { cause: e }); await delay(50); }
    }
    const getPublic = async id => {
        const response = await fetch(setup.url + '/v1/quotes/' + encodeURIComponent(id) + '/customer', { headers: { authorization: 'Bearer ' + viewerToken } });
        assert.equal(response.status, 200); return response.json();
    };
    let recorded = 0, gatewayRevalidations = 0;
    gateway = await httpFixture(async (req, res) => {
        try {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', idempotency: 'durable', capabilities: [
                { id: 'quote.send_priced', version: '1.0.0', pricingValidation: 'before_send' }] }));
            let raw = ''; for await (const chunk of req) raw += chunk; const request = JSON.parse(raw);
            assert.equal(request.capabilityId, 'quote.send_priced');
            const current = await getPublic(request.input.pricing.quoteId); gatewayRevalidations++;
            assert.equal(current.state, 'issued'); assert(Date.parse(current.valid_until) > Date.now());
            assert.equal(hash(current), request.input.pricing.customerHash);
            assert.deepEqual(current, request.input.quote);
            // This is a recording test endpoint, never an email provider.
            recorded++;
            res.end(JSON.stringify({ status: 'completed', idempotencyKey: request.idempotencyKey,
                pricingCustomerHash: hash(current), actualCostMicros: 0,
                output: { correlationId: 'synthetic-pricing-thread-' + recorded, receipts: [{ recipient: request.input.to,
                    providerId: 'synthetic-recording-' + recorded, acceptedAt: new Date().toISOString() }] } }));
        } catch (e) { res.writeHead(409).end(JSON.stringify({ error: String(e) })); }
    });
    const reg = configured(setup.url, gateway.url), first = await getPublic(setup.quotes[0].id);
    const adapter = new PricingAdapter(); assert.equal((await adapter.doctor(reg.get('quote.import'))).ready, true);
    const approvedOnly = { ...first, quote_number: setup.quotes[2].id };
    await assert.rejects(() => adapter.execute(adapterRequest(reg, approvedOnly)), e => e.code === 'PRICING_NOT_FINALIZED');
    const valid = workflow(reg, first); stores.push(valid.store);
    await valid.until('WAITING_APPROVAL'); assert.equal(recorded, 0);
    assert.deepEqual(valid.store.approvalFor('test-tenant', valid.run.id, 'approve').payload.quote, first);
    await valid.approved(); const sent = await valid.tick(); assert.equal(sent.steps.send.status, 'completed');
    assert.equal(recorded, 1); assert.equal(gatewayRevalidations, 1);
    await valid.tick(); assert.equal(recorded, 1); // Waiting does not redispatch.
    const second = await getPublic(setup.quotes[1].id), withdrawn = workflow(reg, second); stores.push(withdrawn.store);
    await withdrawn.approved(); const q = setup.quotes[1];
    const response = await fetch(setup.url + '/v1/quotes/' + q.id + '/withdraw', { method: 'POST', headers: {
        authorization: 'Bearer ' + 'isolated-pricing-approver-fixture-'.repeat(2), 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: 'withdraw-live-test', expected_version: q.version, content_hash: q.content_hash,
            reason: 'SYNTHETIC withdrawal after TWC approval, before dispatch' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).state, 'withdrawn');
    const blocked = await withdrawn.tick(); assert.equal(blocked.status, 'FAILED'); assert.equal(blocked.steps.send, undefined);
    assert.equal(recorded, 1);
    console.log(JSON.stringify({ test: 'cross-repository pricing API + TWC Engine + HTTP recording gateway',
        pricingVersion: '0.2.0', finalizedImport: 'passed', unfinalizedBlocked: 'passed', independentApproval: 'passed',
        exactPublicProjection: 'passed', gatewayRevalidation: 'passed', waitDoesNotResend: 'passed',
        withdrawnAfterApprovalBlockedBeforeDispatch: 'passed', recordedTestDeliveries: recorded,
        realEmailsSent: 0, syntheticFixturesOnly: true }, null, 2));
} finally {
    for (const store of stores) store.close();
    if (gateway) await gateway.close();
    lines?.close();
    if (child && !exited) { const done = once(child, 'exit'); child.kill('SIGTERM'); await Promise.race([done, delay(3000)]);
        if (!exited) { child.kill('SIGKILL'); await done; } }
    rmSync(dir, { recursive: true, force: true });
}
