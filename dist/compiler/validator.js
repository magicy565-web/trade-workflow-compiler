import { hash } from '../util.js';
import { validate } from '../schema.js';
import { workflowSchema } from './spec-schema.js';
import { contracts } from '../contracts.js';
export function edges(n) {
    if (n.type === 'human_approval')
        return [...new Set([n.next, n.onReject, n.onTimeout])];
    if (n.type === 'wait_event')
        return [...new Set([n.next, n.onTimeout])];
    if (n.type === 'decision')
        return [...new Set([n.next, n.otherwise])];
    return [n.next];
}
export function validateWorkflow(value, registry, checkEnabled = true) {
    const shape = validate(workflowSchema, value);
    if (shape.length)
        return shape.map(message => ({ code: 'SCHEMA', message }));
    const spec = value, errors = [];
    const add = (code, message, nodeId) => errors.push({ code, message, nodeId });
    const nodes = new Map();
    for (const n of spec.nodes) {
        if (nodes.has(n.id))
            add('DUPLICATE_NODE', 'Duplicate node', n.id);
        nodes.set(n.id, n);
    }
    if (!nodes.has(spec.entry))
        add('ENTRY', 'Entry node does not exist');
    for (const n of spec.nodes)
        for (const e of edges(n))
            if (e !== 'END' && !nodes.has(e))
                add('DANGLING_EDGE', `Missing successor ${e}`, n.id);
    if (!spec.context.companyName.trim() || !spec.context.products.length || !spec.context.targetMarkets.length || spec.context.budgetMicros <= 0)
        add('MISSING_FACT', 'Company, products, target markets and explicit budget are required');
    if (errors.length)
        return errors;
    const visiting = new Set(), seen = new Set(), order = [];
    function visit(id) {
        if (id === 'END')
            return;
        if (visiting.has(id)) {
            add('CYCLE', 'Cycles are not supported in v1', id);
            return;
        }
        if (seen.has(id))
            return;
        visiting.add(id);
        for (const e of edges(nodes.get(id)))
            visit(e);
        visiting.delete(id);
        seen.add(id);
        order.unshift(id);
    }
    visit(spec.entry);
    for (const id of nodes.keys())
        if (!seen.has(id))
            add('UNREACHABLE', 'Unreachable node', id);
    if (errors.length)
        return errors;
    const predecessors = new Map();
    for (const n of spec.nodes)
        for (const e of edges(n)) {
            const p = predecessors.get(e) ?? [];
            p.push(n.id);
            predecessors.set(e, p);
        }
    const dominators = new Map();
    for (const id of order) {
        const preds = predecessors.get(id) ?? [];
        let d = new Set();
        if (id !== spec.entry && preds.length) {
            d = new Set(dominators.get(preds[0]) ?? []);
            for (const p of preds.slice(1))
                d = new Set([...d].filter(x => dominators.get(p)?.has(x)));
        }
        d.add(id);
        dominators.set(id, d);
    }
    function dataContract(ref, consumer) {
        if (ref === '$context')
            return 'EnterpriseContextV1';
        const src = nodes.get(ref);
        if (!src) {
            add('MISSING_INPUT', `Unknown input ${ref}`, consumer);
            return;
        }
        if (ref === consumer || !dominators.get(consumer)?.has(ref))
            add('INPUT_NOT_DOMINATING', `Input ${ref} is not available on every incoming path`, consumer);
        if (src.type === 'agent_task' || src.type === 'action' || src.type === 'wait_event')
            return src.outputContract;
        add('INVALID_INPUT', 'This node does not produce a business data contract', consumer);
        return;
    }
    let reserve = 0;
    for (const n of spec.nodes) {
        if (n.type === 'agent_task' || n.type === 'action') {
            const c = registry.get(n.capability);
            if (!c) {
                add('UNKNOWN_CAPABILITY', `Unregistered capability ${n.capability}`, n.id);
                continue;
            }
            if (checkEnabled && (!c.enabled || !c.binding))
                add('CAPABILITY_UNAVAILABLE', `${c.id} has no enabled real binding`, n.id);
            if (hash(c) !== n.capabilityHash)
                add('CAPABILITY_DRIFT', 'Capability binding or policy changed; recompile and approve a new version', n.id);
            if (c.version !== n.capabilityVersion)
                add('CAPABILITY_VERSION', 'Pinned capability version mismatch', n.id);
            if (n.inputContract !== c.inputContract || n.outputContract !== c.outputContract)
                add('CONTRACT_TAMPER', 'Contracts must match capability registry', n.id);
            const inputType = dataContract(n.input, n.id);
            if (inputType && inputType !== c.inputContract)
                add('CONTRACT_MISMATCH', `${inputType} cannot feed ${c.inputContract}`, n.id);
            if (n.maxCostMicros < c.maxCostMicros)
                add('COST_UNDERESTIMATE', 'Node budget is below capability reservation', n.id);
            reserve += n.maxCostMicros * n.maxAttempts;
            if (c.effect === 'external') {
                if (n.type !== 'action')
                    add('SIDE_EFFECT_TYPE', 'External capability must be an action', n.id);
                if (n.maxAttempts !== 1)
                    add('UNSAFE_RETRY', 'External actions cannot auto-retry', n.id);
                const gate = n.approvalNode ? nodes.get(n.approvalNode) : undefined;
                if (!gate || gate.type !== 'human_approval' || gate.actionId !== n.id || gate.input !== n.input || gate.next !== n.id || !dominators.get(n.id)?.has(gate.id))
                    add('APPROVAL_REQUIRED', 'Every path to an external action needs its exact payload approval', n.id);
                else if (gate.onReject !== 'END' || gate.onTimeout !== 'END')
                    add('UNSAFE_REJECTION', 'Rejected or expired approval must terminate', gate.id);
            }
            else if (n.type !== 'agent_task')
                add('READ_TASK_TYPE', 'Read capability must be an agent_task', n.id);
        }
        else if (n.type === 'human_approval') {
            dataContract(n.input, n.id);
            const action = nodes.get(n.actionId);
            if (!action || action.type !== 'action' || action.approvalNode !== n.id)
                add('APPROVAL_TARGET', 'Approval must target a registered action', n.id);
        }
        else if (n.type === 'wait_event') {
            if (n.onTimeout !== 'END')
                add('TIMEOUT_POLICY', 'v1 wait timeouts must terminate', n.id);
            const type = dataContract(n.correlationFrom, n.id);
            if (!contracts[n.outputContract])
                add('UNKNOWN_CONTRACT', 'Unknown event output contract', n.id);
            const field = type ? contracts[type]?.properties?.[n.correlationField] : undefined;
            if (field?.type !== 'string')
                add('CORRELATION_FIELD', 'Correlation field must be a declared string', n.id);
            if (['constructor', 'prototype', '__proto__'].includes(n.correlationField))
                add('UNSAFE_FIELD', 'Unsafe correlation field', n.id);
        }
        else if (n.type === 'decision') {
            const type = dataContract(n.input, n.id);
            if (!type || !Object.hasOwn(contracts[type]?.properties ?? {}, n.field))
                add('DECISION_FIELD', 'Decision must use an explicit output field', n.id);
            if (['constructor', 'prototype', '__proto__'].includes(n.field))
                add('UNSAFE_FIELD', 'Unsafe decision field', n.id);
        }
    }
    if (reserve > spec.context.budgetMicros)
        add('BUDGET', 'Worst-case reserved cost including retries exceeds authorized budget');
    if (spec.nodes.length > spec.policy.maxTransitions)
        add('TRANSITION_LIMIT', 'Too few authorized transitions');
    return errors;
}
//# sourceMappingURL=validator.js.map