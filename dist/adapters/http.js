import { createHmac } from 'node:crypto';
import { boundedJson, fail, record, secureUrl } from '../util.js';
/** Contract: authenticated GET {base}/health and POST {base}/execute. See docs/gateway-contract.md. */
export class HttpGatewayAdapter {
    settings(c) {
        const b = c.binding;
        if (!b?.endpoint || !b.secretEnv)
            fail('GATEWAY_CONFIG', 'Gateway binding is incomplete');
        const u = secureUrl(b.endpoint);
        if (u.search)
            fail('GATEWAY_CONFIG', 'Gateway base must not have a query string');
        const secret = process.env[b.secretEnv];
        if (!secret || secret.length < 32)
            fail('GATEWAY_SECRET', 'Gateway secret must be configured and at least 32 characters');
        return { base: u.toString().replace(/\/$/, ''), secret };
    }
    async doctor(c) {
        try {
            const { base, secret } = this.settings(c);
            const response = await fetch(base + '/health', { headers: { authorization: 'Bearer ' + secret }, redirect: 'error', signal: AbortSignal.timeout(5000) });
            if (!response.ok)
                return { ready: false, detail: `Gateway health HTTP ${response.status}` };
            const data = await boundedJson(response);
            const listed = record(data) && Array.isArray(data.capabilities) && data.capabilities.some(v => record(v) && v.id === c.id && v.version === c.version && (c.id !== 'quote.send_priced' || v.pricingValidation === 'before_send'));
            const ready = !!listed && record(data) && data.status === 'ok' && (c.effect !== 'external' || data.idempotency === 'durable');
            return { ready, detail: ready ? 'Gateway responded and advertised the pinned capability. This does not verify business quality.' : 'Required capability or durable idempotency contract was not advertised' };
        }
        catch {
            return { ready: false, detail: 'Gateway unavailable or configuration invalid' };
        }
    }
    async execute(req) {
        const health = await this.doctor(req.capability);
        if (!health.ready)
            fail('GATEWAY_NOT_READY', health.detail);
        const { base, secret } = this.settings(req.capability), timestamp = String(Date.now());
        const body = JSON.stringify({ idempotencyKey: req.idempotencyKey, tenantId: req.tenantId, runId: req.runId, stepId: req.stepId, capabilityId: req.capability.id, capabilityVersion: req.capability.version, input: req.input, context: req.context, businessRequest: req.businessRequest, maxCostMicros: req.capability.maxCostMicros });
        const signature = createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
        const response = await fetch(base + '/execute', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(req.deadlineMs), headers: {
                authorization: 'Bearer ' + secret, 'content-type': 'application/json', 'idempotency-key': req.idempotencyKey, 'x-twc-timestamp': timestamp, 'x-twc-signature': signature
            }, body });
        if (!response.ok)
            fail('GATEWAY_HTTP', `Gateway returned HTTP ${response.status}`);
        const data = await boundedJson(response);
        if (!record(data) || data.idempotencyKey !== req.idempotencyKey || data.status !== 'completed' || !Object.hasOwn(data, 'output'))
            fail('GATEWAY_RECEIPT', 'Missing final receipt or mismatched idempotency key');
        if (req.capability.id === 'quote.send_priced' &&
            (!record(req.input) || !record(req.input.pricing) || data.pricingCustomerHash !== req.input.pricing.customerHash))
            fail('PRICING_RECEIPT', 'Gateway did not confirm the exact pricing customer snapshot');
        return { status: 'completed', output: data.output, actualCostMicros: typeof data.actualCostMicros === 'number' ? data.actualCostMicros : undefined };
    }
}
//# sourceMappingURL=http.js.map