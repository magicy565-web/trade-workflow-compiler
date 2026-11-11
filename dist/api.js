import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { authenticate } from './config.js';
import { terminal } from './store.js';
import { compile } from './compiler/compiler.js';
import { validateWorkflow } from './compiler/validator.js';
import { selectPlaybook } from './compiler/llm.js';
import { contracts, compileInputSchema } from './contracts.js';
import { assertSchema, obj, str, int, array } from './schema.js';
import { DomainError, fail, hash } from './util.js';
import { Batches } from './batches.js';
import { EventInbox, eventInputSchema, verifyWebhook } from './events.js';
import { Outcomes, outcomeInputSchema } from './outcomes.js';
import { Followups, followupUpdateSchema } from './followups.js';
const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const assets = new Map(Object.entries(staticFiles).map(([url, [path, type]]) => [url, { type, content: readFileSync(fileURLToPath(new URL('../public/' + path, import.meta.url))) }]));
async function rawBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json'))
        fail('CONTENT_TYPE', 'Use application/json', 415);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const b = Buffer.from(chunk);
        size += b.length;
        if (size > 1048576)
            fail('BODY_LIMIT', 'Request exceeds 1 MB', 413);
        chunks.push(b);
    }
    return Buffer.concat(chunks);
}
function parseJson(raw) {
    try {
        return JSON.parse(raw.toString('utf8'));
    }
    catch {
        return fail('JSON', 'Malformed JSON');
    }
}
async function body(req) { return parseJson(await rawBody(req)); }
function permit(actor, ...roles) {
    if (!roles.includes(actor.role))
        fail('FORBIDDEN', 'This role cannot perform that operation', 403);
}
function reply(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
export function createApi(config, store, engine) {
    const batches = new Batches(store), inbox = new EventInbox(store), outcomes = new Outcomes(store), followups = new Followups(store);
    return createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader('x-request-id', requestId);
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        try {
            const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname, method = req.method ?? 'GET';
            if (method === 'GET' && path === '/health') {
                reply(res, 200, { status: 'ok', service: 'trade-workflow-compiler', version: '0.4.0', externalIntegrationsVerified: false });
                return;
            }
            if (method === 'GET' && assets.has(path)) {
                const a = assets.get(path);
                res.writeHead(200, { 'content-type': a.type });
                res.end(a.content);
                return;
            }
            const origin = req.headers.origin;
            if (origin && origin !== (config.publicOrigin ?? `http://${req.headers.host}`))
                fail('ORIGIN', 'Cross-origin requests are forbidden', 403);
            const webhook = path.match(/^\/api\/webhooks\/([a-zA-Z0-9_-]{1,80})$/);
            if (method === 'POST' && webhook) {
                const source = config.eventSources?.find(s => s.id === webhook[1]);
                if (!source?.enabled)
                    fail('WEBHOOK_DISABLED', 'Event source unavailable', 404);
                const raw = await rawBody(req);
                const ts = req.headers['x-twc-timestamp'], sig = req.headers['x-twc-signature'];
                verifyWebhook(source, typeof ts === 'string' ? ts : undefined, typeof sig === 'string' ? sig : undefined, raw);
                const input = parseJson(raw);
                assertSchema(eventInputSchema, input);
                const p = input;
                const eventId = 'wh_' + hash({ sourceId: source.id, providerEventId: p.id });
                reply(res, 202, { eventId, ...inbox.ingest({ ...p, id: eventId, sourceId: source.id, externalId: p.id, tenantId: source.tenantId, receivedAt: Date.now() }, { tenantId: source.tenantId, userId: 'webhook:' + source.id, role: 'ingest' }) });
                return;
            }
            const actor = authenticate(req.headers.authorization, config.keys), tenant = actor.tenantId;
            if (method === 'GET' && path === '/api/me') {
                reply(res, 200, actor);
                return;
            }
            if (method === 'GET' && path === '/api/capabilities') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, config.registry.list().map(({ binding, ...c }) => ({ ...c, bound: !!binding, adapter: binding?.adapter })));
                return;
            }
            if (method === 'GET' && path === '/api/workflows') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, store.listDefinitions(tenant));
                return;
            }
            if (method === 'GET' && path === '/api/runs') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer', 'worker');
                reply(res, 200, store.listRuns(tenant));
                return;
            }
            if (method === 'GET' && path === '/api/approvals') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, store.listApprovals(tenant));
                return;
            }
            if (method === 'GET' && path === '/api/audit') {
                permit(actor, 'admin', 'approver', 'viewer');
                reply(res, 200, { chainValid: store.verifyAudit(), events: store.auditLog(tenant) });
                return;
            }
            if (method === 'POST' && path === '/api/compile') {
                permit(actor, 'admin', 'operator');
                const input = await body(req);
                assertSchema(compileInputSchema, input);
                const result = compile(input, actor, config.registry);
                const definition = result.workflow ? store.saveDefinition(result.workflow, actor) : null;
                reply(res, 200, { ...result, definition });
                return;
            }
            if (method === 'POST' && path === '/api/plan') {
                permit(actor, 'admin', 'operator');
                const input = await body(req);
                assertSchema(compileInputSchema, input);
                const endpoint = process.env.TWC_PLANNER_ENDPOINT, apiKey = process.env.TWC_PLANNER_KEY, model = process.env.TWC_PLANNER_MODEL;
                if (!endpoint || !apiKey || !model)
                    fail('PLANNER_DISABLED', 'Optional model planner is not configured', 409);
                const selected = await selectPlaybook(input, { endpoint, apiKey, model });
                const result = compile({ ...input, playbook: selected.playbook }, actor, config.registry);
                result.intent.method = 'llm';
                result.intent.evidence = selected.supportingQuotes;
                reply(res, 200, { ...result, definition: result.workflow ? store.saveDefinition(result.workflow, actor) : null });
                return;
            }
            if (method === 'GET' && path === '/api/batches') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, batches.list(tenant));
                return;
            }
            if (method === 'POST' && path === '/api/batches') {
                permit(actor, 'admin', 'operator');
                const input = await body(req);
                assertSchema(obj({ sourceRunId: str(1, 100), recipients: array({ type: 'string', format: 'email' }, 1, 50), idempotencyKey: str(16, 80) }), input);
                const p = input;
                const b = batches.create(tenant, p.sourceRunId, p.recipients, p.idempotencyKey, actor, config.registry);
                reply(res, 201, batches.view(tenant, b.id));
                return;
            }
            if (method === 'GET' && path === '/api/events') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, inbox.list(tenant, url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined, Number(url.searchParams.get('limit') ?? 100)));
                return;
            }
            if (method === 'GET' && path === '/api/outcomes') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, outcomes.list(tenant, Number(url.searchParams.get('limit') ?? 200)));
                return;
            }
            if (method === 'POST' && path === '/api/outcomes') {
                permit(actor, 'admin', 'operator');
                const input = await body(req);
                assertSchema(outcomeInputSchema, input, 'OUTCOME_SCHEMA');
                reply(res, 201, outcomes.report(tenant, input, actor));
                return;
            }
            if (method === 'GET' && path === '/api/outcomes/summary') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, outcomes.summary(tenant));
                return;
            }
            let match;
            if (method === 'GET' && path === '/api/followups') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, { ...followups.list(tenant, (url.searchParams.get('state') ?? 'active'), url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined, Number(url.searchParams.get('limit') ?? 50)), summary: followups.summary(tenant) });
                return;
            }
            if ((match = path.match(/^\/api\/followups\/([^/]+)$/))) {
                if (method === 'GET') {
                    permit(actor, 'admin', 'operator', 'approver', 'viewer');
                    reply(res, 200, { ...followups.get(tenant, match[1]), history: followups.history(tenant, match[1]) });
                    return;
                }
                if (method === 'POST') {
                    permit(actor, 'admin', 'operator');
                    const input = await body(req);
                    assertSchema(followupUpdateSchema, input, 'FOLLOWUP_SCHEMA');
                    reply(res, 200, followups.update(tenant, match[1], input, actor));
                    return;
                }
            }
            if ((match = path.match(/^\/api\/outcomes\/([^/]+)(?:\/(decision))?$/))) {
                if (method === 'GET' && !match[2]) {
                    permit(actor, 'admin', 'operator', 'approver', 'viewer');
                    reply(res, 200, outcomes.get(tenant, match[1]));
                    return;
                }
                if (method === 'POST' && match[2]) {
                    permit(actor, 'approver');
                    const input = await body(req);
                    assertSchema(obj({ hash: str(64, 64), approved: { type: 'boolean' }, note: str(10, 3000) }), input);
                    const p = input;
                    reply(res, 200, outcomes.decide(tenant, match[1], p.hash, p.approved, p.note, actor));
                    return;
                }
            }
            if (method === 'GET' && (match = path.match(/^\/api\/runs\/([^/]+)\/(outcomes|dossier)$/))) {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, match[2] === 'dossier' ? outcomes.dossier(tenant, match[1]) : outcomes.byRun(tenant, match[1]));
                return;
            }
            if ((match = path.match(/^\/api\/runs\/([^/]+)\/batch-preview$/)) && method === 'GET') {
                permit(actor, 'admin', 'operator', 'approver', 'viewer');
                reply(res, 200, batches.preview(tenant, match[1]));
                return;
            }
            if ((match = path.match(/^\/api\/batches\/([^/]+)(?:\/(pause|resume|cancel))?$/))) {
                if (method === 'GET' && !match[2]) {
                    permit(actor, 'admin', 'operator', 'approver', 'viewer');
                    reply(res, 200, batches.view(tenant, match[1]));
                    return;
                }
                if (method === 'POST' && match[2]) {
                    permit(actor, 'admin', 'operator');
                    const state = match[2] === 'resume' ? 'active' : match[2] === 'cancel' ? 'cancelled' : 'paused';
                    batches.control(tenant, match[1], state, actor);
                    reply(res, 200, batches.view(tenant, match[1]));
                    return;
                }
            }
            if ((match = path.match(/^\/api\/events\/([^/]+)(?:\/(recheck))?$/))) {
                if (method === 'GET' && !match[2]) {
                    permit(actor, 'admin', 'operator', 'approver', 'viewer');
                    reply(res, 200, inbox.get(tenant, decodeURIComponent(match[1])));
                    return;
                }
                if (method === 'POST' && match[2]) {
                    permit(actor, 'admin', 'operator');
                    reply(res, 200, inbox.recheck(tenant, decodeURIComponent(match[1]), actor));
                    return;
                }
            }
            if (method === 'POST' && (match = path.match(/^\/api\/workflows\/([^/]+)\/(\d+)\/publish$/))) {
                permit(actor, 'approver');
                const input = await body(req);
                assertSchema(obj({ hash: str(64, 64) }), input);
                const d = store.getDefinition(tenant, match[1], Number(match[2]));
                const errors = validateWorkflow(d.spec, config.registry);
                if (errors.length) {
                    reply(res, 409, { code: 'COMPILE_BLOCKED', errors });
                    return;
                }
                reply(res, 200, store.publish(tenant, match[1], Number(match[2]), input.hash, actor));
                return;
            }
            if (method === 'POST' && (match = path.match(/^\/api\/workflows\/([^/]+)\/(\d+)\/revise$/))) {
                permit(actor, 'admin', 'operator');
                const prior = store.getDefinition(tenant, match[1], Number(match[2]));
                const input = await body(req);
                const spec = input;
                const errors = validateWorkflow(spec, config.registry, false);
                if (errors.length) {
                    reply(res, 400, { code: 'INVALID_SPEC', errors });
                    return;
                }
                if (spec.tenantId !== tenant || spec.id !== prior.spec.id || spec.version !== prior.spec.version + 1)
                    fail('VERSION', 'Revision must preserve tenant/id and increment version by one');
                reply(res, 201, store.saveDefinition(spec, actor));
                return;
            }
            if (method === 'POST' && path === '/api/runs') {
                permit(actor, 'admin', 'operator');
                const input = await body(req);
                assertSchema(obj({ workflowId: str(1, 100), version: int(1, 100000), idempotencyKey: str(16, 80) }), input);
                const p = input;
                const def = store.getDefinition(tenant, p.workflowId, p.version), errors = validateWorkflow(def.spec, config.registry);
                if (errors.length) {
                    reply(res, 409, { code: 'COMPILE_BLOCKED', errors });
                    return;
                }
                reply(res, 201, store.createRun(tenant, p.workflowId, p.version, p.idempotencyKey, actor));
                return;
            }
            if ((match = path.match(/^\/api\/runs\/([^/]+)(?:\/(advance|cancel|reconcile))?$/))) {
                const id = match[1], action = match[2];
                if (method === 'GET' && !action) {
                    permit(actor, 'admin', 'operator', 'approver', 'viewer', 'worker');
                    reply(res, 200, store.getRun(tenant, id));
                    return;
                }
                if (method === 'POST' && action === 'advance') {
                    permit(actor, 'worker');
                    reply(res, 200, await engine.tick(tenant, id));
                    return;
                }
                if (method === 'POST' && action === 'cancel') {
                    permit(actor, 'admin', 'operator');
                    reply(res, 200, engine.cancel(tenant, id, actor));
                    return;
                }
                if (method === 'POST' && action === 'reconcile') {
                    permit(actor, 'approver');
                    const input = await body(req);
                    assertSchema(obj({ output: {}, providerEvidence: str(10, 3000) }), input);
                    const p = input;
                    reply(res, 200, engine.reconcile(tenant, id, p.output, p.providerEvidence, actor));
                    return;
                }
            }
            if (method === 'POST' && (match = path.match(/^\/api\/approvals\/([^/]+)\/decision$/))) {
                permit(actor, 'approver');
                const input = await body(req);
                assertSchema(obj({ hash: str(64, 64), approved: { type: 'boolean' } }), input);
                const p = input;
                reply(res, 200, store.decideApproval(tenant, match[1], p.hash, p.approved, actor));
                return;
            }
            if (method === 'POST' && path === '/api/events') {
                permit(actor, 'ingest');
                const input = await body(req);
                assertSchema(eventInputSchema, input);
                const p = input;
                assertSchema(contracts[p.type === 'sample.update' ? 'SampleUpdateV1' : 'BuyerReplyV1'], p.payload, 'EVENT_CONTRACT');
                reply(res, 202, store.ingest({ ...p, tenantId: tenant, receivedAt: Date.now() }, actor));
                return;
            }
            if (method === 'POST' && path === '/api/suppressions') {
                permit(actor, 'admin', 'operator', 'ingest');
                const input = await body(req);
                assertSchema(obj({ email: { type: 'string', format: 'email' }, reason: str(1, 3000) }), input);
                const p = input;
                store.suppress(tenant, p.email, p.reason, actor);
                reply(res, 201, { status: 'suppressed' });
                return;
            }
            fail('NOT_FOUND', 'Route not found', 404);
        }
        catch (error) {
            if (error instanceof DomainError)
                reply(res, error.httpStatus, { code: error.code, message: error.message, requestId });
            else
                reply(res, 500, { code: 'INTERNAL_ERROR', message: 'Request failed. Inspect the audit trail without exposing credentials.', requestId });
        }
    });
}
export function startScheduler(store, engine) {
    let busy = false;
    const timer = setInterval(async () => {
        if (busy)
            return;
        busy = true;
        try {
            const now = Date.now();
            const candidates = store.listRuns().filter(r => !terminal.has(r.status) && (!r.batchId || new Batches(store).get(r.tenantId, r.batchId).state === 'active') && (r.nextWakeAt === null || r.nextWakeAt <= now));
            // Bounded concurrency; per-run SQLite leases protect against duplicate dispatch.
            for (let i = 0; i < candidates.length; i += 4)
                await Promise.all(candidates.slice(i, i + 4).map(r => engine.tick(r.tenantId, r.id).catch(() => { })));
        }
        finally {
            busy = false;
        }
    }, 500);
    timer.unref();
    return async () => {
        clearInterval(timer);
        while (busy)
            await new Promise(resolve => setTimeout(resolve, 50));
    };
}
//# sourceMappingURL=api.js.map