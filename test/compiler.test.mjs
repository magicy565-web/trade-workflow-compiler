import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, extractIntent } from '../dist/compiler/compiler.js';
import { validateWorkflow } from '../dist/compiler/validator.js';
import { Registry, defaultCapabilities } from '../dist/registry.js';
import { validate, obj, str } from '../dist/schema.js';
import { hash, secureUrl, ownField } from '../dist/util.js';
import { actor, request, registry, definition } from './helpers.mjs';
for (const id of ['buyer-development', 'inquiry-quote', 'sample-followup'])
    test('compile registered playbook: ' + id, () => { const result = compile(request(id), actor, registry()); assert.equal(result.status, 'ready_for_approval'); assert.equal(validateWorkflow(result.workflow, registry()).length, 0); });
test('default registry is disabled; compiling never invents tools', () => { const r = compile(request(), actor, new Registry()); assert.equal(r.status, 'blocked'); assert(r.errors.some(e => e.code === 'CAPABILITY_UNAVAILABLE')); });
test('unknown goal is not silently converted into buyer development', () => { const r = request(); delete r.playbook; r.request = '请建设一个工厂ERP'; assert.equal(compile(r, actor, registry()).workflow, null); });
test('missing enterprise facts are not hallucinated', () => { const r = request(); r.context.companyName = ''; r.context.products = []; r.context.targetMarkets = []; const c = compile(r, actor, registry()); assert.equal(c.status, 'blocked'); assert.equal(c.workflow.context.products.length, 0); });
test('unsupported request fields are rejected', () => assert.throws(() => compile({ ...request(), executeShell: 'rm -rf /' }, actor, registry()), /unknown field/));
test('market extraction gives hints, does not silently rewrite profile', () => { const r = request(); r.context.targetMarkets = []; const intent = extractIntent(r); assert.deepEqual(intent.marketHints, ['US']); assert.deepEqual(r.context.targetMarkets, []); });
const checks = [
    ['duplicate IDs', 'DUPLICATE_NODE', s => s.nodes.push(structuredClone(s.nodes[0]))],
    ['cycle', 'CYCLE', s => s.nodes.find(n => n.id === 'classify').next = 'research'],
    ['dangling edge', 'DANGLING_EDGE', s => s.nodes[0].next = 'missing'],
    ['unreachable node', 'UNREACHABLE', s => s.nodes.push({ ...s.nodes[0], id: 'unreachable', next: 'END' })],
    ['fictional capability', 'UNKNOWN_CAPABILITY', s => s.nodes[0].capability = 'imaginary.tool'],
    ['pinned capability version', 'CAPABILITY_VERSION', s => s.nodes[0].capabilityVersion = '99.0.0'],
    ['data contract mismatch', 'CONTRACT_MISMATCH', s => s.nodes.find(n => n.id === 'draft').input = 'research'],
    ['contract forgery', 'CONTRACT_TAMPER', s => s.nodes[0].outputContract = 'FakeV1'],
    ['approval deletion', 'APPROVAL_REQUIRED', s => delete s.nodes.find(n => n.id === 'send').approvalNode],
    ['approval bypass', 'APPROVAL_REQUIRED', s => { s.nodes.find(n => n.id === 'draft').next = 'fork'; s.nodes.push({ id: 'fork', label: 'fork', type: 'decision', input: 'draft', field: 'messages', equals: [], next: 'approve', otherwise: 'send' }); }],
    ['different approved payload', 'APPROVAL_REQUIRED', s => s.nodes.find(n => n.id === 'approve').input = 'qualify'],
    ['rejected approval path', 'UNSAFE_REJECTION', s => s.nodes.find(n => n.id === 'approve').onReject = 'send'],
    ['external automatic retries', 'UNSAFE_RETRY', s => s.nodes.find(n => n.id === 'send').maxAttempts = 2],
    ['side effect disguised as research', 'SIDE_EFFECT_TYPE', s => s.nodes.find(n => n.id === 'send').type = 'agent_task'],
    ['cost underestimation', 'COST_UNDERESTIMATE', s => s.nodes[0].maxCostMicros = 0],
    ['insufficient total budget', 'BUDGET', s => s.context.budgetMicros = 1],
    ['missing facts cannot be published', 'MISSING_FACT', s => s.context.products = []],
    ['invented correlation field', 'CORRELATION_FIELD', s => s.nodes.find(n => n.id === 'wait').correlationField = 'nonexistent'],
    ['unsafe timeout route', 'TIMEOUT_POLICY', s => s.nodes.find(n => n.id === 'wait').onTimeout = 'classify'],
    ['dynamic JS condition', 'SCHEMA', s => s.nodes.find(n => n.id === 'route').expression = 'process.exit()'],
    ['unsafe field access', 'UNSAFE_FIELD', s => s.nodes.find(n => n.id === 'route').field = 'constructor']
];
for (const [name, code, change] of checks)
    test('validator blocks ' + name, () => { const s = definition(); change(s); assert(validateWorkflow(s, registry()).some(e => e.code === code), JSON.stringify(validateWorkflow(s, registry()))); });
test('JSON Schema subset fails on unsupported keywords', () => assert(validate({ type: 'string', not: {} }, 'a').some(x => x.includes('unsupported'))));
test('canonical hashes ignore key order but bind content', () => { assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 })); assert.notEqual(hash({ a: 1 }), hash({ a: 2 })); });
test('prototype field traversal is forbidden', () => assert.throws(() => ownField({}, '__proto__')));
test('unsafe HTTP and credential-bearing URLs are blocked', () => { for (const url of ['http://example.com', 'https://user:pass@example.com', 'file:///etc/passwd'])
    assert.throws(() => secureUrl(url)); assert.doesNotThrow(() => secureUrl('http://127.0.0.1:1234')); });
test('external action cannot be bound to a general-purpose bot', () => { const caps = defaultCapabilities(); const cap = caps.find(x => x.id === 'outreach.send'); cap.enabled = true; cap.binding = { adapter: 'openmausbot', command: 'node', botId: 'test', readOnlyProfileAttested: true }; assert.throws(() => new Registry(caps)); });
test('strict nested objects reject prototype pollution payloads', () => assert(validate(obj({ name: str() }), JSON.parse('{"name":"x","__proto__":{"admin":true}}')).length));
test('binding drift requires recompile even when capability version is unchanged', () => { const s = definition(), caps = registry().list(); caps[0].binding.endpoint = 'http://127.0.0.1:9999'; assert(validateWorkflow(s, new Registry(caps)).some(e => e.code === 'CAPABILITY_DRIFT')); });
