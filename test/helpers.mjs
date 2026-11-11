// TEST FIXTURES ONLY. No fixture is ever loaded by production code or the default registry.
import { Registry, defaultCapabilities } from '../dist/registry.js';
import { compile } from '../dist/compiler/compiler.js';
import { Store } from '../dist/store.js';
import { Engine } from '../dist/runtime/engine.js';
export const actor = { tenantId: 'test-tenant', userId: 'test-operator', role: 'operator' };
export const approver = { tenantId: 'test-tenant', userId: 'test-approver', role: 'approver' };
export const context = { companyName: 'TEST FIXTURE — NOT A REAL COMPANY', products: ['fixture fabric'], targetMarkets: ['US'], goal: 'TEST ONLY', budgetMicros: 50000000, currency: 'USD', facts: { fixture: true } };
export const evidence = [{ url: 'https://fixture.invalid/source', capturedAt: '2026-01-01T00:00:00.000Z', excerpt: 'SYNTHETIC TEST FIXTURE ONLY', verification: 'unverified' }];
export const buyer = { companyName: 'TEST BUYER', website: 'https://fixture.invalid', contactEmail: 'test@fixture.invalid', evidence, rationale: 'SYNTHETIC TEST FIXTURE' };
export const output = {
    'market.research': { context, findings: ['FIXTURE'], evidence },
    'buyers.discover': { candidates: [buyer], evidence },
    'buyers.qualify': { buyers: [buyer], exclusions: [], evidence },
    'outreach.draft': { messages: [{ to: 'test@fixture.invalid', subject: 'FIXTURE ONLY', body: 'NOT A REAL EMAIL', evidence, claimReview: 'human_required' }] },
    'outreach.send': { correlationId: 'fixture-thread-1', receipts: [{ recipient: 'test@fixture.invalid', providerId: 'fixture-provider-1', acceptedAt: '2026-01-01T00:00:00.000Z' }] },
    'replies.classify': { category: 'rfq', reason: 'FIXTURE', needsHuman: true },
    'inquiry.normalize': { customer: 'FIXTURE', requirement: 'FIXTURE', missingFields: [], evidence },
    'quote.prepare': { to: 'test@fixture.invalid', subject: 'FIXTURE', body: 'FIXTURE', terms: { currency: 'USD', priceMinor: 100, moq: 10, leadDays: 10, validityDate: '2026-12-01' }, evidence, claimReview: 'human_required' },
    'quote.send': { correlationId: 'fixture-quote-1', receipts: [{ recipient: 'test@fixture.invalid', providerId: 'fixture-provider-2', acceptedAt: '2026-01-01T00:00:00.000Z' }] },
    'sample.plan': { customer: 'FIXTURE', product: 'FIXTURE', quantity: 1, address: 'TEST ADDRESS', notes: 'FIXTURE', evidence },
    'sample.request': { correlationId: 'fixture-sample-1', requestId: 'fixture-request-1', acceptedAt: '2026-01-01T00:00:00.000Z' },
    'sample.summarize': { outcome: 'FIXTURE', nextAction: 'FIXTURE', evidence }
};
export const reply = { from: 'test@fixture.invalid', subject: 'FIXTURE', body: 'SYNTHETIC REPLY', messageId: 'fixture-message-1' };
export function registry() { return new Registry(defaultCapabilities().map(c => ({ ...c, enabled: true, binding: { adapter: 'http', endpoint: 'http://127.0.0.1:1', secretEnv: 'TWC_TEST_GATEWAY_SECRET' } }))); }
export function request(playbook = 'buyer-development') { return { request: '我们主营服装面料，要开发美国中小品牌客户', context: structuredClone(context), playbook }; }
export function definition(reg = registry(), playbook = 'buyer-development') { const result = compile(request(playbook), actor, reg); if (result.errors.length)
    throw Error(JSON.stringify(result.errors)); return result.workflow; }
export function setup({ path = ':memory:', adapter, playbook = 'buyer-development', budgetMicros } = {}) {
    const reg = registry(), store = new Store(path), spec = definition(reg, playbook); if(budgetMicros!==undefined) spec.context.budgetMicros=budgetMicros; const def = store.saveDefinition(spec, actor);
    store.publish(actor.tenantId, spec.id, 1, def.hash, approver);
    const run = store.createRun(actor.tenantId, spec.id, 1, 'fixture-request-key-0001', actor);
    let now = Date.now(), calls = [];
    const a = adapter ?? { async execute(req) { calls.push(req); return { status: 'completed', output: structuredClone(output[req.capability.id]) }; } };
    const engine = new Engine(store, reg, { http: a }, () => now);
    return { reg, store, spec, run, engine, calls, now: () => now, advance: (ms = 2500) => now += ms,
        async until(status, max = 40) { for (let i = 0; i < max; i++) {
            now += 2500;
            const r = await engine.tick(actor.tenantId, run.id);
            if (r.status === status)
                return r;
            if (['FAILED', 'NEEDS_RECONCILIATION', 'TIMED_OUT', 'REJECTED'].includes(r.status) && r.status !== status)
                throw Error(JSON.stringify(r));
        } throw Error('Did not reach ' + status); },
        approve(ok = true) { const a = store.listApprovals(actor.tenantId).find(x => x.runId === run.id); return store.decideApproval(actor.tenantId, a.id, a.payloadHash, ok, approver, now); }
    };
}
