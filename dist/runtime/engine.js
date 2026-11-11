import { randomUUID } from 'node:crypto';
import { terminal } from '../store.js';
import { contracts } from '../contracts.js';
import { assertSchema } from '../schema.js';
import { DomainError, fail, hash, ownField, record, errorCode } from '../util.js';
import { validateWorkflow } from '../compiler/validator.js';
import { Batches } from '../batches.js';
import { EventInbox, normalizeEmail } from '../events.js';
export function resolveInput(run, ref) {
    if (ref === '$context')
        return structuredClone(run.spec.context);
    const step = run.steps[ref];
    if (!step || step.status !== 'completed')
        fail('MISSING_INPUT', 'Required upstream result is unavailable');
    return structuredClone(step.output);
}
export class Engine {
    store;
    registry;
    adapters;
    now;
    owner = randomUUID();
    constructor(store, registry, adapters, now = Date.now) {
        this.store = store;
        this.registry = registry;
        this.adapters = adapters;
        this.now = now;
    }
    async tick(tenant, id) {
        if (!this.store.acquire(tenant, id, this.owner, this.now()))
            return this.store.getRun(tenant, id);
        try {
            let r = this.store.getRun(tenant, id);
            if (terminal.has(r.status))
                return r;
            const interrupted = r.spec.nodes.find(n => n.id === r.current);
            if (interrupted?.type === 'action' && r.steps[interrupted.id]?.status === 'running')
                return this.finish(r, 'NEEDS_RECONCILIATION', 'Interrupted external action requires a provider receipt before resuming');
            if (r.batchId && new Batches(this.store).get(tenant, r.batchId).state !== 'active')
                return r;
            if (r.nextWakeAt !== null && r.nextWakeAt > this.now())
                return r;
            const issues = validateWorkflow(r.spec, this.registry);
            if (issues.length)
                return this.finish(r, 'FAILED', 'RUNTIME_VALIDATION: ' + issues.map(e => e.code).join(','));
            const definition = this.store.getDefinition(tenant, r.workflowId, r.version);
            if (definition.status !== 'published' || definition.hash !== hash(r.spec))
                return this.finish(r, 'FAILED', 'WORKFLOW_INTEGRITY');
            if (this.now() >= Math.min(r.createdAt + r.spec.policy.maxRunSeconds * 1000, r.deadlineAt ?? Infinity))
                return this.finish(r, 'TIMED_OUT', 'Run deadline exceeded');
            if (r.status === 'BATCH_READY')
                return r;
            if (r.transitions >= r.spec.policy.maxTransitions)
                return this.finish(r, 'FAILED', 'Transition limit exceeded');
            const node = r.spec.nodes.find(n => n.id === r.current);
            if (!node)
                return this.finish(r, 'FAILED', 'Unknown current node');
            if (node.type === 'agent_task' || node.type === 'action')
                return await this.task(r, node);
            return this.store.transaction(() => {
                r = this.store.getRun(tenant, id);
                if (terminal.has(r.status))
                    return r;
                if (node.type === 'human_approval') {
                    const input = resolveInput(r, node.input), payloadHash = hash(input);
                    let a = this.store.approvalFor(tenant, id, node.id);
                    if (!a) {
                        a = { id: randomUUID(), tenantId: tenant, runId: id, nodeId: node.id, actionId: node.actionId, payload: input, payloadHash, expiresAt: this.now() + node.timeoutSeconds * 1000, state: 'pending' };
                        this.store.createApproval(a);
                        this.store.audit(tenant, 'engine', 'approval.requested', { id: a.id, runId: id, payloadHash });
                    }
                    if (a.payloadHash !== payloadHash)
                        return this.finishInside(r, 'FAILED', 'Approval input changed');
                    if (a.state === 'rejected')
                        return this.finishInside(r, 'REJECTED', 'Human rejected the operation');
                    if (a.expiresAt <= this.now())
                        return this.finishInside(r, 'TIMED_OUT', 'Approval expired');
                    if (a.state === 'approved')
                        this.advance(r, node, { approvalId: a.id, payloadHash }, node.next);
                    else {
                        r.status = 'WAITING_APPROVAL';
                        r.nextWakeAt = Math.min(a.expiresAt, this.now() + 2000);
                        this.store.putRun(r);
                    }
                }
                else if (node.type === 'wait_event') {
                    const upstream = resolveInput(r, node.correlationFrom), correlation = ownField(upstream, node.correlationField);
                    if (typeof correlation !== 'string' || !correlation)
                        return this.finishInside(r, 'FAILED', 'Missing correlation id');
                    // Also binds receipts of runs created under v0.1 when resuming after upgrade.
                    const action = r.spec.nodes.find(n => n.id === node.correlationFrom);
                    if (action?.type === 'action')
                        new EventInbox(this.store).bindReceiptInside(r, action, resolveInput(r, action.input), upstream);
                    const first = r.steps[node.id]?.startedAt ?? this.now(), deadline = first + node.timeoutSeconds * 1000;
                    r.steps[node.id] ??= { status: 'pending', attempts: 0, startedAt: first };
                    const event = this.store.matchingEvent(tenant, node.eventType, correlation, r.createdAt, deadline);
                    if (event) {
                        assertSchema(contracts[node.outputContract], event.payload, 'EVENT_CONTRACT');
                        if (!this.store.consumeEvent(event, id))
                            fail('EVENT_RACE', 'Event already consumed', 409);
                        this.advance(r, node, event.payload, node.next);
                        this.store.audit(tenant, 'engine', 'event.consumed', { eventId: event.id, runId: id });
                    }
                    else if (this.now() >= deadline)
                        return this.finishInside(r, 'TIMED_OUT', 'Business event deadline exceeded');
                    else {
                        r.status = 'WAITING_EVENT';
                        r.nextWakeAt = Math.min(deadline, this.now() + 2000);
                        this.store.putRun(r);
                    }
                }
                else if (node.type === 'decision') {
                    const output = resolveInput(r, node.input), value = ownField(output, node.field);
                    const matched = hash(value) === hash(node.equals);
                    this.advance(r, node, { matched }, matched ? node.next : node.otherwise);
                }
                return r;
            });
        }
        catch (error) {
            const r = this.store.getRun(tenant, id);
            if (terminal.has(r.status))
                return r;
            const node = r.spec.nodes.find(n => n.id === r.current);
            return this.finish(r, node?.type === 'action' && r.steps[node.id]?.status === 'running' ? 'NEEDS_RECONCILIATION' : 'FAILED', errorCode(error));
        }
        finally {
            this.store.release(tenant, id, this.owner);
        }
    }
    finishInside(r, status, error) {
        r.status = status;
        r.error = error;
        r.nextWakeAt = null;
        this.store.putRun(r);
        new EventInbox(this.store).refreshRunInside(r.tenantId, r.id);
        if (status === 'NEEDS_RECONCILIATION' && r.batchId) {
            const batches = new Batches(this.store), batch = batches.get(r.tenantId, r.batchId);
            if (batch.state !== 'cancelled') {
                batch.state = 'paused';
                batches.putInside(batch);
            }
        }
        this.store.audit(r.tenantId, 'engine', 'run.' + status.toLowerCase(), { runId: r.id, error });
        return r;
    }
    finish(r, status, error) {
        return this.store.transaction(() => {
            const latest = this.store.getRun(r.tenantId, r.id);
            if (terminal.has(latest.status))
                return latest;
            return this.finishInside(latest, status, error);
        });
    }
    advance(r, node, output, next) {
        r.steps[node.id] = { ...(r.steps[node.id] ?? { attempts: 0, startedAt: this.now() }), status: 'completed', output };
        r.current = next;
        r.transitions++;
        r.status = next === 'END' ? 'COMPLETED' : 'PENDING';
        r.nextWakeAt = next === 'END' ? null : this.now();
        this.store.putRun(r);
        if (next === 'END')
            new EventInbox(this.store).refreshRunInside(r.tenantId, r.id);
        this.store.audit(r.tenantId, 'engine', 'step.completed', { runId: r.id, stepId: node.id, outputHash: hash(output) });
    }
    verifyApproval(r, node, input) {
        const a = node.approvalNode ? this.store.approvalFor(r.tenantId, r.id, node.approvalNode) : undefined;
        if (!a || a.state !== 'approved' || a.actionId !== node.id || a.payloadHash !== hash(input) || a.expiresAt <= this.now() || a.decidedBy === r.createdBy)
            fail('APPROVAL_REQUIRED', 'Exact payload approval is absent, expired or invalid', 403);
        return a;
    }
    checkSuppression(r, input) {
        if (!record(input))
            return;
        const recipients = typeof input.to === 'string' ? [input.to] : [];
        if (Array.isArray(input.messages))
            for (const m of input.messages)
                if (record(m))
                    recipients.push(m.to);
        if (recipients.some(email => typeof email === 'string' && this.store.isSuppressed(r.tenantId, email)))
            fail('SUPPRESSED', 'Recipient is on the suppression list', 403);
    }
    checkRecipient(r, node, payload) {
        if (!['outreach.draft', 'outreach.send'].includes(node.capability))
            return;
        const draft = r.spec.nodes.find(n => n.type === 'agent_task' && n.capability === 'outreach.draft');
        const q = draft?.type === 'agent_task' ? resolveInput(r, draft.input) : undefined;
        const buyer = record(q) && Array.isArray(q.buyers) && q.buyers.length === 1 ? q.buyers[0] : undefined;
        const expected = r.targetEmail ?? (record(buyer) && typeof buyer.contactEmail === 'string' ? buyer.contactEmail : undefined);
        const messages = record(payload) ? payload.messages : undefined;
        if (!expected || !Array.isArray(messages) || messages.length !== 1 || !record(messages[0]) || typeof messages[0].to !== 'string' || normalizeEmail(messages[0].to) !== normalizeEmail(expected))
            fail('RECIPIENT_SCOPE', 'Draft or send recipient is outside the qualified single-buyer scope');
    }
    async task(run, node) {
        const capability = this.registry.get(node.capability);
        const adapter = capability.binding ? this.adapters[capability.binding.adapter] : undefined;
        if (!adapter)
            return this.finish(run, 'FAILED', 'Adapter unavailable');
        const input = resolveInput(run, node.input);
        assertSchema(contracts[node.inputContract], input, 'INPUT_CONTRACT');
        if (node.capability === 'outreach.draft' && record(input) && Array.isArray(input.buyers)) {
            if (!input.buyers.length)
                return this.finish(run, 'COMPLETED', 'No qualified buyers; no outbound operation created');
            const buyerCount = input.buyers.length;
            if (buyerCount > 1)
                return this.store.mutateRun(run.tenantId, run.id, r => { r.status = 'BATCH_READY'; r.nextWakeAt = Math.min(r.createdAt + r.spec.policy.maxRunSeconds * 1000, r.deadlineAt ?? Infinity); this.store.audit(r.tenantId, 'engine', 'run.batch_ready', { runId: r.id, count: buyerCount }); });
        }
        // This transaction is the durable dispatch boundary. Unknown external outcomes NEVER auto-retry.
        const prepared = this.store.transaction(() => {
            const r = this.store.getRun(run.tenantId, run.id);
            if (terminal.has(r.status))
                return null;
            const old = r.steps[node.id];
            if (old?.status === 'running' && node.type === 'action') {
                this.finishInside(r, 'NEEDS_RECONCILIATION', 'An external dispatch was interrupted; check provider receipt');
                return null;
            }
            if (node.type === 'action') {
                if (r.batchId && new Batches(this.store).get(r.tenantId, r.batchId).state !== 'active')
                    return null;
                this.checkRecipient(r, node, input);
                this.verifyApproval(r, node, input);
                this.checkSuppression(r, input);
            }
            let step = old;
            const continuation = old?.continuation;
            if (!step || step.status === 'failed') {
                const attempts = (step?.attempts ?? 0) + 1;
                if (attempts > node.maxAttempts) {
                    this.finishInside(r, 'FAILED', 'Attempt limit exceeded');
                    return null;
                }
                if (r.reservedMicros + node.maxCostMicros > r.spec.context.budgetMicros) {
                    this.finishInside(r, 'FAILED', 'Budget exhausted');
                    return null;
                }
                if (!new Batches(this.store).reserveInside(r, node.maxCostMicros))
                    return null;
                r.reservedMicros += node.maxCostMicros;
                step = { status: 'running', attempts, startedAt: this.now() };
            }
            else {
                if (this.now() - step.startedAt > node.timeoutSeconds * 1000) {
                    this.finishInside(r, node.type === 'action' ? 'NEEDS_RECONCILIATION' : 'FAILED', 'Step deadline exceeded');
                    return null;
                }
                step.status = 'running';
            }
            r.steps[node.id] = step;
            r.status = 'RUNNING';
            r.nextWakeAt = null;
            this.store.putRun(r);
            this.store.audit(r.tenantId, 'engine', 'step.dispatch', { runId: r.id, stepId: node.id, inputHash: hash(input), attempt: step.attempts });
            return { r, step, continuation };
        });
        if (!prepared)
            return this.store.getRun(run.tenantId, run.id);
        const key = hash({ tenant: run.tenantId, run: run.id, step: node.id });
        try {
            const result = await adapter.execute({ idempotencyKey: key, tenantId: run.tenantId, runId: run.id, stepId: node.id, capability, input, context: structuredClone(run.spec.context), businessRequest: run.spec.request, deadlineMs: Math.min(30000, node.timeoutSeconds * 1000), continuation: prepared.continuation });
            return this.store.transaction(() => {
                const r = this.store.getRun(run.tenantId, run.id);
                if (terminal.has(r.status))
                    return r;
                if (result.status === 'pending') {
                    if (node.type === 'action')
                        return this.finishInside(r, 'NEEDS_RECONCILIATION', 'An external gateway must return a final receipt, not pending');
                    if (!Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0)
                        fail('ADAPTER_RESULT', 'Invalid retry delay');
                    r.steps[node.id].status = 'pending';
                    r.steps[node.id].continuation = result.continuation;
                    r.status = 'RETRY_WAIT';
                    r.nextWakeAt = this.now() + Math.min(30000, Math.max(10, result.retryAfterMs));
                    this.store.putRun(r);
                    return r;
                }
                assertSchema(contracts[node.outputContract], result.output, 'OUTPUT_CONTRACT');
                if (node.capability === 'outreach.draft')
                    this.checkRecipient(r, node, result.output);
                if (node.type === 'action')
                    new EventInbox(this.store).bindReceiptInside(r, node, input, result.output);
                if (result.actualCostMicros !== undefined) {
                    if (!Number.isSafeInteger(result.actualCostMicros) || result.actualCostMicros < 0)
                        fail('COST_RECEIPT', 'Invalid cost receipt');
                    r.actualMicros += result.actualCostMicros;
                    new Batches(this.store).chargeInside(r, result.actualCostMicros, result.actualCostMicros > node.maxCostMicros);
                    if (result.actualCostMicros > node.maxCostMicros) {
                        r.steps[node.id].output = result.output;
                        return this.finishInside(r, 'FAILED', 'Provider reported a budget overrun; output retained, further actions stopped');
                    }
                }
                this.advance(r, node, result.output, node.next);
                return r;
            });
        }
        catch (error) {
            return this.store.transaction(() => {
                const r = this.store.getRun(run.tenantId, run.id);
                if (terminal.has(r.status))
                    return r;
                const step = r.steps[node.id];
                step.error = errorCode(error);
                if (node.type === 'action')
                    return this.finishInside(r, 'NEEDS_RECONCILIATION', step.error);
                step.status = 'failed';
                if (step.attempts >= node.maxAttempts || error instanceof DomainError && ['OUTPUT_CONTRACT', 'NEEDS_USER', 'BOT_FAILED', 'COST_RECEIPT', 'RECIPIENT_SCOPE'].includes(error.code))
                    return this.finishInside(r, 'FAILED', step.error);
                r.status = 'RETRY_WAIT';
                r.nextWakeAt = this.now() + Math.min(30000, 1000 * 2 ** step.attempts);
                this.store.putRun(r);
                return r;
            });
        }
    }
    cancel(tenant, id, actor) {
        return this.store.mutateRun(tenant, id, r => {
            if (terminal.has(r.status))
                return;
            const node = r.spec.nodes.find(n => n.id === r.current);
            r.status = node?.type === 'action' && r.steps[node.id]?.status === 'running' ? 'NEEDS_RECONCILIATION' : 'CANCELLED';
            r.error = 'Local scheduling stopped; this does not undo or cancel an already dispatched remote operation';
            r.nextWakeAt = null;
            this.store.audit(tenant, actor.userId, 'run.cancel_requested', { runId: id, status: r.status });
        });
    }
    reconcile(tenant, id, output, providerEvidence, actor) {
        return this.store.mutateRun(tenant, id, r => {
            if (actor.role !== 'approver' || actor.userId === r.createdBy)
                fail('FORBIDDEN', 'Independent approver required', 403);
            if (r.status !== 'NEEDS_RECONCILIATION')
                fail('STATE', 'Run is not awaiting reconciliation', 409);
            const node = r.spec.nodes.find(n => n.id === r.current);
            if (!node || node.type !== 'action')
                fail('STATE', 'Not an external action', 409);
            if (providerEvidence.trim().length < 10)
                fail('EVIDENCE', 'Supply a provider receipt or incident reference');
            assertSchema(contracts[node.outputContract], output, 'OUTPUT_CONTRACT');
            new EventInbox(this.store).bindReceiptInside(r, node, resolveInput(r, node.input), output);
            this.advance(r, node, output, node.next);
            delete r.error;
            this.store.audit(tenant, actor.userId, 'action.reconciled', { runId: id, stepId: node.id, providerEvidence, outputHash: hash(output) });
        });
    }
}
//# sourceMappingURL=engine.js.map