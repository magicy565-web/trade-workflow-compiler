import type { Adapter, AdapterRequest, AdapterResult, Capability, Obj } from '../types.js';
import { pricingReferenceSchema, pricingCustomerSchema, pricedQuoteSchema } from '../contracts.js';
import { assertSchema } from '../schema.js';
import { boundedJson, fail, hash, record, secureUrl } from '../util.js';

/** Read finalized customer data only. No cost, policy, calculation, approval or send endpoints. */
export class PricingAdapter implements Adapter {
    constructor(private now: () => number = Date.now) { }

    private settings(c: Capability) {
        const b = c.binding;
        if (c.id !== 'quote.import' || c.effect !== 'read' || c.inputContract !== 'EnterpriseContextV1' ||
            c.outputContract !== 'PricedQuoteV1' || b?.adapter !== 'pricing' || !b.endpoint ||
            !b.secretEnv || !b.tenantId || !b.pricingTenantId)
            fail('PRICING_CONFIG', 'Use the dedicated quote.import binding with explicit tenant mapping');
        const url = secureUrl(b.endpoint);
        if (url.search) fail('PRICING_CONFIG', 'Pricing base cannot contain a query string');
        const token = process.env[b.secretEnv];
        if (!token || token.length < 32) fail('PRICING_TOKEN', 'A dedicated pricing viewer token is required');
        return { base: url.toString().replace(/\/$/, ''), token, tenantId: b.tenantId, pricingTenantId: b.pricingTenantId };
    }
    private async get(settings: ReturnType<PricingAdapter['settings']>, path: string, signal: AbortSignal): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(settings.base + path, { headers: { authorization: 'Bearer ' + settings.token }, redirect: 'error', signal });
        } catch { return fail('PRICING_UNAVAILABLE', 'Pricing service could not be reached; no quote is authorized'); }
        if (!response.ok) {
            await response.body?.cancel().catch(() => { });
            // Do not echo upstream bodies: they may contain internal commercial information.
            fail('PRICING_UNAVAILABLE', `Pricing endpoint refused the request (HTTP ${response.status})`);
        }
        return boundedJson(response);
    }
    private async identity(settings: ReturnType<PricingAdapter['settings']>, signal: AbortSignal): Promise<Obj> {
        const me = await this.get(settings, '/v1/me', signal);
        if (!record(me) || me.role !== 'viewer' || me.tenant !== settings.pricingTenantId || typeof me.seller !== 'string')
            fail('PRICING_IDENTITY', 'Pricing viewer identity or tenant does not match the configured binding');
        return me;
    }
    async doctor(c: Capability): Promise<{ ready: boolean; detail: string }> {
        try {
            await this.identity(this.settings(c), AbortSignal.timeout(5000));
            return { ready: true, detail: 'Pricing viewer identity matches. Individual quotes still require finalization, current validity and independent sending approval.' };
        } catch { return { ready: false, detail: 'Pricing endpoint, viewer role or explicit tenant mapping is unavailable' }; }
    }
    private async draft(req: AdapterRequest): Promise<Obj> {
        const settings = this.settings(req.capability);
        if (req.tenantId !== settings.tenantId) fail('PRICING_TENANT', 'Pricing binding belongs to another workflow tenant', 403);
        const ref = req.context.facts.pricingQuote;
        assertSchema(pricingReferenceSchema, ref, 'PRICING_REFERENCE');
        const { quoteId, customer, to } = ref as { quoteId: string; customer: string; to: string };
        const signal = AbortSignal.timeout(Math.min(10000, Math.max(1, req.deadlineMs)));
        const identity = await this.identity(settings, signal);
        if (identity.seller !== req.context.companyName)
            fail('PRICING_SELLER', 'Workflow enterprise does not match the pricing seller');
        const value = await this.get(settings, '/v1/quotes/' + encodeURIComponent(quoteId) + '/customer', signal);
        if (!record(value) || value.state !== 'issued')
            fail('PRICING_NOT_FINALIZED', 'Only an internally finalized quote may enter sending approval');
        assertSchema(pricingCustomerSchema, value, 'PRICING_CONTRACT');
        if (value.quote_number !== quoteId || value.customer !== customer || value.seller !== identity.seller)
            fail('PRICING_SCOPE', 'Quote, customer or seller does not match the explicit handoff');
        if (Date.parse(value.valid_until as string) <= this.now())
            fail('PRICING_EXPIRED', 'Pricing quote has expired');
        if (/^0(?:\.0+)?$/.test(value.quantity as string) || /^0(?:\.0+)?$/.test(value.unit_price as string))
            fail('PRICING_CONTRACT', 'Quantity and unit price must be positive');
        // Preserve decimal strings, including sub-cent unit prices and three-decimal currencies.
        // Rendering is deterministic: a Worker cannot rewrite the approved price or commercial terms.
        const result = {
            to, subject: `Quotation ${quoteId}`,
            body: [
                `Quotation: ${quoteId}`, `Seller: ${value.seller}`, `Prepared for: ${value.customer}`,
                `Product: ${value.product_id} · Revision ${value.product_revision}`, `Description: ${value.description}`,
                `Quantity: ${value.quantity} ${value.unit}`, `Unit price: ${value.currency} ${value.unit_price}`,
                `Total: ${value.currency} ${value.total}`, `Delivery: ${value.incoterm} ${value.named_place}, Incoterms ${value.edition}`,
                `Lead time: ${value.lead_time_days} days, subject to the agreed order/start conditions.`,
                `Payment terms: ${value.payment_terms}`, `Valid until: ${value.valid_until}`, value.note
            ].join('\n'),
            quote: value,
            pricing: { provider: 'trade-pricing-engine', quoteId, customerHash: hash(value) },
            claimReview: 'human_required'
        };
        assertSchema(pricedQuoteSchema, result, 'PRICING_CONTRACT');
        return result;
    }
    async execute(req: AdapterRequest): Promise<AdapterResult> {
        if (hash(req.input) !== hash(req.context)) fail('PRICING_CONTEXT', 'Quote import must use the published enterprise context');
        return { status: 'completed', output: await this.draft(req), actualCostMicros: 0 };
    }
    async validateForDispatch(req: AdapterRequest, approvedPayload: unknown): Promise<void> {
        assertSchema(pricedQuoteSchema, approvedPayload, 'PRICING_CONTRACT');
        const current = await this.draft(req);
        if (hash(current) !== hash(approvedPayload))
            fail('PRICING_CHANGED', 'Current customer quote or rendered message differs from the approved payload', 409);
    }
}
