import test from 'node:test';
import assert from 'node:assert/strict';
import { PricingAdapter } from '../dist/adapters/pricing.js';
import { HttpGatewayAdapter } from '../dist/adapters/http.js';
import { Registry, defaultCapabilities } from '../dist/registry.js';
import { compile } from '../dist/compiler/compiler.js';
import { validateWorkflow } from '../dist/compiler/validator.js';
import { Outcomes } from '../dist/outcomes.js';
import { hash } from '../dist/util.js';
import { actor, approver, pricingFixture, httpFixture, configured, pricingInput, adapterRequest, workflow } from './pricing-helpers.mjs';

test('pricing import preserves decimal precision and reads only identity/customer endpoints', async t => {
    const f = await pricingFixture(); t.after(f.close);
    const req = adapterRequest(configured(f.url), f.state.quote), adapter = new PricingAdapter();
    const result = await adapter.execute(req);
    assert.equal(result.actualCostMicros, 0);
    assert.equal(result.output.quote.unit_price, '0.01234567');
    assert.equal(result.output.quote.total, '1.235');
    assert.match(result.output.body, /KWD 0.01234567/);
    assert.equal(result.output.pricing.customerHash, hash(f.state.quote));
    assert.deepEqual(f.state.paths, ['GET /v1/me', 'GET /v1/quotes/fixture-quote/customer']);
    await adapter.validateForDispatch(req, result.output);
    for (const field of ['body', 'to']) {
        const changed = structuredClone(result.output); changed[field] = field === 'to' ? 'other@fixture.invalid' : 'Different terms';
        await assert.rejects(() => adapter.validateForDispatch(req, changed), e => e.code === 'PRICING_CHANGED');
    }
    f.state.quote.unit_price = '0.01234568';
    await assert.rejects(() => adapter.validateForDispatch(req, result.output), e => e.code === 'PRICING_CHANGED');
});
for (const [name, mutate, code] of [
    ['not finalized', f => f.state.quote.state = 'approved', 'PRICING_NOT_FINALIZED'],
    ['expired', f => f.state.quote.valid_until = new Date(Date.now() - 1000).toISOString(), 'PRICING_EXPIRED'],
    ['withdrawn upstream', f => f.state.status = 409, 'PRICING_UNAVAILABLE'],
    ['privileged credential', f => f.state.role = 'admin', 'PRICING_IDENTITY'],
    ['remote tenant mismatch', f => f.state.tenant = 'other', 'PRICING_IDENTITY'],
    ['extra internal cost field', f => f.state.quote.internal_cost = 'secret', 'PRICING_CONTRACT'],
    ['floating point amount', f => f.state.quote.unit_price = 0.01, 'PRICING_CONTRACT'],
    ['zero quantity', f => f.state.quote.quantity = '0', 'PRICING_CONTRACT'],
    ['redirect', f => f.state.redirect = true, 'PRICING_UNAVAILABLE']
]) test('pricing import fails closed: ' + name, async t => {
    const f = await pricingFixture(); t.after(f.close);
    const req = adapterRequest(configured(f.url), f.state.quote); mutate(f);
    await assert.rejects(() => new PricingAdapter().execute(req), e => e.code === code);
    assert(!f.state.paths.some(p => p.includes('internal-costs')));
});
test('explicit workflow tenant, seller and customer must match', async t => {
    const f = await pricingFixture(); t.after(f.close);
    for (const [field, code] of [['tenant', 'PRICING_TENANT'], ['seller', 'PRICING_SELLER'], ['customer', 'PRICING_SCOPE']]) {
        const req = adapterRequest(configured(f.url), f.state.quote);
        if (field === 'tenant') req.tenantId = 'other';
        if (field === 'seller') req.context.companyName = 'other';
        if (field === 'customer') req.context.facts.pricingQuote.customer = 'other';
        await assert.rejects(() => new PricingAdapter().execute(req), e => e.code === code);
    }
});
test('compiler blocks missing/invalid pricing references and capability provenance bypasses', () => {
    const reg = configured('http://127.0.0.1:1'), input = pricingInput();
    assert.equal(compile(input, actor, new Registry(defaultCapabilities().filter(c => !c.id.startsWith('quote.')))).status, 'blocked');
    const invalid = structuredClone(input); invalid.context.facts.pricingQuote.to = 'not-an-email';
    assert.equal(compile(invalid, actor, reg).workflow, null);
    const wrong = structuredClone(input); wrong.playbook = 'buyer-development';
    assert.equal(compile(wrong, actor, reg).status, 'blocked');
    const result = compile(input, actor, reg); assert.equal(result.status, 'ready_for_approval');
    const spec = structuredClone(result.workflow); spec.nodes.find(n => n.id === 'send').input = '$context';
    assert(validateWorkflow(spec, reg).some(e => e.code === 'PRICING_PROVENANCE'));
    const tenant = structuredClone(result.workflow); tenant.tenantId = 'other';
    assert(validateWorkflow(tenant, reg).some(e => e.code === 'PRICING_PROVENANCE'));
    assert.throws(() => new Registry(reg.list().map(c => c.id === 'quote.import' ? { ...c, id: 'fake.import' } : c)), e => e.code === 'PRICING_CONFIG');
    assert.throws(() => new Registry(reg.list().map(c => c.id === 'quote.import' ? { ...c, binding: { ...c.binding, adapter: 'http' } } : c)), e => e.code === 'PRICING_CONFIG');
});
for (const variant of ['withdrawn', 'changed', 'expired', 'missing guard', 'gateway unattested'])
    test('pre-dispatch refusal records no external send or ambiguous outcome: ' + variant, async t => {
        const f = await pricingFixture(); t.after(f.close);
        let sends = 0;
        const http = { doctor: async () => ({ ready: variant !== 'gateway unattested' }), execute: async () => { sends++; throw Error('must not call'); } };
        const w = workflow(configured(f.url), f.state.quote, { adapters: { http } }); t.after(() => w.store.close());
        await w.approved();
        if (variant === 'withdrawn') f.state.status = 409;
        if (variant === 'changed') f.state.quote.payment_terms = 'changed';
        if (variant === 'expired') f.state.quote.valid_until = new Date(Date.now() - 1000).toISOString();
        if (variant === 'missing guard') w.engine.adapters.pricing = { execute: async () => { throw Error('unused'); } };
        const r = await w.tick(); assert.equal(r.status, 'FAILED'); assert.equal(sends, 0); assert.equal(r.steps.send, undefined);
    });
test('cancellation during pricing preflight prevents subsequent dispatch', async t => {
    const f = await pricingFixture(); t.after(f.close); let sends = 0, enter, release;
    const entered = new Promise(resolve => enter = resolve), gate = new Promise(resolve => release = resolve);
    const adapter = new PricingAdapter(); const original = adapter.validateForDispatch.bind(adapter);
    adapter.validateForDispatch = async (...args) => { await original(...args); enter(); await gate; };
    const w = workflow(configured(f.url), f.state.quote, { adapters: { pricing: adapter,
        http: { doctor: async () => ({ ready: true }), execute: async () => { sends++; } } } }); t.after(() => w.store.close());
    await w.approved(); const tick = w.tick(); await entered;
    w.engine.cancel(actor.tenantId, w.run.id, actor); release();
    assert.equal((await tick).status, 'CANCELLED'); assert.equal(sends, 0);
});
test('priced HTTP gateway requires freshness contract and exact hash receipt', async t => {
    const f = await pricingFixture(); t.after(f.close); let advertise = false, correct = false, sends = 0;
    const gateway = await httpFixture(async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', idempotency: 'durable', capabilities: [
            { id: 'quote.send_priced', version: '1.0.0', ...(advertise ? { pricingValidation: 'before_send' } : {}) }] }));
        let body = ''; for await (const chunk of req) body += chunk; const payload = JSON.parse(body); sends++;
        res.end(JSON.stringify({ status: 'completed', idempotencyKey: payload.idempotencyKey,
            pricingCustomerHash: correct ? payload.input.pricing.customerHash : 'wrong',
            output: { correlationId: 'fixture-' + sends, receipts: [{ recipient: payload.input.to, providerId: 'fixture-' + sends, acceptedAt: new Date().toISOString() }] } }));
    }); t.after(gateway.close);
    const reg = configured(f.url, gateway.url), a = new HttpGatewayAdapter();
    assert.equal((await a.doctor(reg.get('quote.send_priced'))).ready, false);
    const w = workflow(reg, f.state.quote); t.after(() => w.store.close()); await w.approved();
    assert.equal((await w.tick()).status, 'FAILED'); assert.equal(sends, 0);
    advertise = true;
    const bad = workflow(reg, f.state.quote); t.after(() => bad.store.close()); await bad.approved();
    assert.equal((await bad.tick()).status, 'NEEDS_RECONCILIATION'); assert.equal(sends, 1);
    correct = true;
    const good = workflow(reg, f.state.quote); t.after(() => good.store.close()); await good.approved();
    const sent = await good.tick(); assert.equal(sent.steps.send.status, 'completed'); assert.equal(sends, 2);
    const outcome = new Outcomes(good.store).report(actor.tenantId, { runId: good.run.id, idempotencyKey: 'pricing-outcome-fixture-01',
        kind: 'quote_sent', evidence: { kind: 'provider_receipt', reference: 'send', note: 'Isolated synthetic gateway receipt' }, occurredAt: new Date().toISOString() }, actor);
    assert.equal(outcome.state, 'pending'); // Never turn dispatch into a sale claim.
});
