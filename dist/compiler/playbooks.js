import { hash } from '../util.js';
export function buildPlaybook(id, context, request, tenantId, workflowId, registry) {
    const nodes = [];
    function task(nodeId, capability, input, next, approvalNode) {
        const c = registry.get(capability);
        if (!c)
            throw Error('Missing built-in capability: ' + capability);
        const n = { id: nodeId, label: c.description, type: c.effect === 'read' ? 'agent_task' : 'action', capability, capabilityVersion: c.version, capabilityHash: hash(c), input,
            inputContract: c.inputContract, outputContract: c.outputContract, maxCostMicros: c.maxCostMicros, timeoutSeconds: c.effect === 'read' ? 900 : 60, maxAttempts: c.effect === 'read' ? 2 : 1, next };
        if (approvalNode)
            n.approvalNode = approvalNode;
        nodes.push(n);
    }
    function gate(actionId, input) { nodes.push({ id: 'approve', label: '核对具体内容并审批', type: 'human_approval', actionId, input, role: 'approver', timeoutSeconds: 86400, next: actionId, onReject: 'END', onTimeout: 'END' }); }
    function wait(from, eventType, outputContract, next) { nodes.push({ id: 'wait', label: '等待真实业务事件', type: 'wait_event', correlationFrom: from, correlationField: 'correlationId', eventType, outputContract, timeoutSeconds: 604800, next, onTimeout: 'END' }); }
    let title;
    if (id === 'buyer-development') {
        title = '海外买家开发';
        task('research', 'market.research', '$context', 'discover');
        task('discover', 'buyers.discover', 'research', 'qualify');
        task('qualify', 'buyers.qualify', 'discover', 'draft');
        task('draft', 'outreach.draft', 'qualify', 'approve');
        gate('send', 'draft');
        task('send', 'outreach.send', 'draft', 'wait', 'approve');
        wait('send', 'buyer.reply_received', 'BuyerReplyV1', 'classify');
        task('classify', 'replies.classify', 'wait', 'route');
        nodes.push({ id: 'route', label: '识别需销售跟进的询价', type: 'decision', input: 'classify', field: 'category', equals: 'rfq', next: 'END', otherwise: 'END' });
    }
    else if (id === 'inquiry-quote') {
        title = '询盘整理与报价';
        task('normalize', 'inquiry.normalize', '$context', 'draft');
        task('draft', 'quote.prepare', 'normalize', 'approve');
        gate('send', 'draft');
        task('send', 'quote.send', 'draft', 'wait', 'approve');
        wait('send', 'buyer.reply_received', 'BuyerReplyV1', 'classify');
        task('classify', 'replies.classify', 'wait', 'END');
    }
    else {
        title = '样品申请与反馈';
        task('draft', 'sample.plan', '$context', 'approve');
        gate('submit', 'draft');
        task('submit', 'sample.request', 'draft', 'wait', 'approve');
        wait('submit', 'sample.update', 'SampleUpdateV1', 'summary');
        task('summary', 'sample.summarize', 'wait', 'END');
    }
    return { schemaVersion: '1', id: workflowId, version: 1, tenantId, title, request, context: structuredClone(context), playbook: id,
        entry: nodes[0].id, nodes, policy: { fourEyes: true, maxRunSeconds: 2592000, maxTransitions: 50 } };
}
//# sourceMappingURL=playbooks.js.map