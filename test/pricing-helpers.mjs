// ISOLATED SYNTHETIC FIXTURES ONLY. No provider sends, market data or production seeding.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Registry, defaultCapabilities } from '../dist/registry.js';
import { compile } from '../dist/compiler/compiler.js';
import { Store } from '../dist/store.js';
import { Engine } from '../dist/runtime/engine.js';
import { PricingAdapter } from '../dist/adapters/pricing.js';
import { HttpGatewayAdapter } from '../dist/adapters/http.js';
import { actor, approver, context } from './helpers.mjs';
export { actor, approver };
export const viewerToken = 'isolated-pricing-viewer-fixture-'.repeat(2);
export function customerQuote() { return {
    quote_number: 'fixture-quote', state: 'issued', seller: 'Synthetic seller', customer: 'Synthetic buyer',
    description: 'SYNTHETIC TEST ONLY', product_id: 'test-sku', product_revision: 'rev1',
    quantity: '100', unit: 'meter', currency: 'KWD', unit_price: '0.01234567', total: '1.235',
    incoterm: 'EXW', named_place: 'Synthetic factory gate', edition: '2020', payment_terms: '100% prepayment',
    lead_time_days: 20, valid_until: new Date(Date.now() + 86400000).toISOString(),
    delivery_status: 'NOT_SENT', note: 'Synthetic quotation only; no contract acceptance.'
}; }
export async function httpFixture(handler) {
    const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return { url: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
export async function pricingFixture() {
    const state = { quote: customerQuote(), role: 'viewer', tenant: 'factory-test', status: 200, paths: [], redirect: false };
    const http = await httpFixture((req, res) => {
        state.paths.push(req.method + ' ' + req.url);
        if (req.headers.authorization !== 'Bearer ' + viewerToken) { res.writeHead(401).end(); return; }
        if (state.redirect) { res.writeHead(302, { location: '/internal-costs' }).end(); return; }
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/me') res.end(JSON.stringify({ role: state.role, tenant: state.tenant, seller: state.quote.seller }));
        else { res.statusCode = state.status; res.end(JSON.stringify(state.quote)); }
    });
    return { ...http, state };
}
export function configured(pricingUrl, gatewayUrl = 'http://127.0.0.1:1') {
    process.env.TWC_TEST_PRICING_VIEWER = viewerToken;
    process.env.TWC_TEST_PRICED_GATEWAY = 'isolated-gateway-fixture-'.repeat(2);
    return new Registry(defaultCapabilities().map(c => c.id === 'quote.import' ? { ...c, enabled: true,
        binding: { adapter: 'pricing', endpoint: pricingUrl, secretEnv: 'TWC_TEST_PRICING_VIEWER', tenantId: actor.tenantId, pricingTenantId: 'factory-test' } }
        : ['quote.send_priced', 'replies.classify'].includes(c.id) ? { ...c, enabled: true,
            binding: { adapter: 'http', endpoint: gatewayUrl, secretEnv: 'TWC_TEST_PRICED_GATEWAY' } } : c));
}
export function pricingInput(quote = customerQuote()) {
    return { playbook: 'inquiry-quote', request: 'Send this finalized pricing quotation after independent review',
        context: { ...structuredClone(context), companyName: quote.seller,
            facts: { pricingQuote: { quoteId: quote.quote_number, customer: quote.customer, to: 'test@fixture.invalid' } } } };
}
export function adapterRequest(reg, quote = customerQuote()) {
    const input = pricingInput(quote).context;
    return { tenantId: actor.tenantId, runId: 'fixture-run', stepId: 'draft', idempotencyKey: 'p'.repeat(64),
        capability: reg.get('quote.import'), context: input, input, businessRequest: 'SYNTHETIC TEST ONLY', deadlineMs: 5000 };
}
export function workflow(reg, quote, options = {}) {
    const result = compile(pricingInput(quote), actor, reg);
    if (result.errors.length) throw Error(JSON.stringify(result.errors));
    const spec = result.workflow, store = new Store(':memory:'), def = store.saveDefinition(spec, actor);
    store.publish(actor.tenantId, spec.id, 1, def.hash, approver);
    const run = store.createRun(actor.tenantId, spec.id, 1, 'pricing-fixture-run-key-01', actor);
    let now = Date.now();
    const engine = new Engine(store, reg, { pricing: new PricingAdapter(), http: new HttpGatewayAdapter(), ...options.adapters }, () => now);
    return { store, engine, run, async tick() { now += 2500; return engine.tick(actor.tenantId, run.id); },
        async until(status) { for (let i = 0; i < 15; i++) { const r = await this.tick(); if (r.status === status) return r;
            if (['FAILED', 'NEEDS_RECONCILIATION', 'CANCELLED'].includes(r.status)) throw Error(JSON.stringify(r)); }
            throw Error('Did not reach ' + status); },
        async approved() { await this.until('WAITING_APPROVAL'); const a = store.approvalFor(actor.tenantId, run.id, 'approve');
            store.decideApproval(actor.tenantId, a.id, a.payloadHash, true, approver, now); await this.tick(); }
    };
}
