import { array, int, obj, str } from '../schema.js';
import { contextSchema } from '../contracts.js';
const id = { ...str(1, 80), pattern: '^[a-z][a-z0-9_-]*$' };
const ref = { ...str(1, 80), pattern: '^(\\$context|[a-z][a-z0-9_-]*)$' };
const next = { ...str(1, 80), pattern: '^(END|[a-z][a-z0-9_-]*)$' };
const base = { id, label: str(1, 200), next };
const task = obj({ ...base, type: { enum: ['agent_task', 'action'] }, capability: str(1, 100), capabilityVersion: str(1, 30), capabilityHash: str(64, 64), input: ref,
    inputContract: str(1, 100), outputContract: str(1, 100), maxCostMicros: int(0, 1e9), timeoutSeconds: int(1, 3600), maxAttempts: int(1, 3), approvalNode: id
}, ['id', 'label', 'next', 'type', 'capability', 'capabilityVersion', 'capabilityHash', 'input', 'inputContract', 'outputContract', 'maxCostMicros', 'timeoutSeconds', 'maxAttempts']);
const approval = obj({ ...base, type: { const: 'human_approval' }, actionId: id, input: ref, role: { const: 'approver' }, timeoutSeconds: int(1, 604800), onReject: next, onTimeout: next });
const wait = obj({ ...base, type: { const: 'wait_event' }, eventType: str(1, 100), correlationFrom: id, correlationField: { ...str(1, 100), pattern: '^[A-Za-z][A-Za-z0-9_]*$' }, outputContract: str(1, 100), timeoutSeconds: int(1, 2592000), onTimeout: next });
const decision = obj({ ...base, type: { const: 'decision' }, input: ref, field: { ...str(1, 100), pattern: '^[A-Za-z][A-Za-z0-9_]*$' }, equals: {}, otherwise: next });
export const workflowSchema = obj({
    schemaVersion: { const: '1' }, id: str(1, 100), version: int(1, 100000), tenantId: str(1, 100), title: str(1, 200), request: str(1, 12000),
    context: contextSchema, playbook: { enum: ['buyer-development', 'inquiry-quote', 'sample-followup'] }, entry: id,
    nodes: array({ oneOf: [task, approval, wait, decision] }, 1, 50),
    policy: obj({ fourEyes: { const: true }, maxRunSeconds: int(1, 5184000), maxTransitions: int(1, 100) })
});
//# sourceMappingURL=spec-schema.js.map