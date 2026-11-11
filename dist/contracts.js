import { array, int, obj, str } from './schema.js';
export const contextSchema = obj({ companyName: str(0, 200), products: array(str(1, 300)), targetMarkets: array(str(1, 100)), goal: str(0, 3000), budgetMicros: int(), currency: { const: 'USD' }, facts: { type: 'object', additionalProperties: true } });
export const compileInputSchema = obj({ request: str(1, 12000), context: contextSchema, playbook: { enum: ['buyer-development', 'inquiry-quote', 'sample-followup'] } }, ['request', 'context']);
export const evidenceSchema = obj({ url: { type: 'string', format: 'uri' }, capturedAt: { type: 'string', format: 'date-time' }, excerpt: str(1, 4000), verification: { enum: ['source_observed', 'unverified'] } });
const evidence = array(evidenceSchema, 1, 50);
const candidate = obj({ companyName: str(1, 300), website: { type: 'string', format: 'uri' }, contactEmail: { type: 'string', format: 'email' }, evidence, rationale: str(1, 3000) }, ['companyName', 'website', 'evidence', 'rationale']);
const mail = obj({ to: { type: 'string', format: 'email' }, subject: { ...str(1, 500), pattern: '^[^\\r\\n]+$' }, body: str(1, 20000), evidence, claimReview: { const: 'human_required' } });
const decimal = { ...str(1, 80), pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' };
export const pricingReferenceSchema = obj({
    quoteId: { ...str(1, 100), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' },
    customer: str(1, 500), to: { type: 'string', format: 'email' }
});
export const pricingCustomerSchema = obj({
    quote_number: str(1, 100), state: { const: 'issued' }, seller: str(1, 500), customer: str(1, 500),
    description: str(1, 500), product_id: str(1, 100), product_revision: str(1, 100),
    quantity: decimal, unit: { enum: ['piece', 'meter', 'kilogram', 'set', 'pair'] },
    currency: { enum: ['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'AED', 'KWD'] },
    unit_price: decimal, total: decimal, incoterm: { enum: ['EXW', 'FCA', 'FOB', 'CIF', 'DAP'] },
    named_place: str(1, 500), edition: { const: '2020' }, payment_terms: str(1, 500),
    lead_time_days: int(1, 730), valid_until: { type: 'string', format: 'date-time' },
    delivery_status: { const: 'NOT_SENT' }, note: str(1, 2000)
});
export const pricedQuoteSchema = obj({
    to: { type: 'string', format: 'email' }, subject: { ...str(1, 500), pattern: '^[^\\r\\n]+$' }, body: str(1, 20000),
    quote: pricingCustomerSchema,
    pricing: obj({ provider: { const: 'trade-pricing-engine' }, quoteId: str(1, 100), customerHash: { ...str(64, 64), pattern: '^[a-f0-9]+$' } }),
    claimReview: { const: 'human_required' }
});
export const contracts = {
    EnterpriseContextV1: contextSchema,
    PricedQuoteV1: pricedQuoteSchema,
    MarketBriefV1: obj({ context: contextSchema, findings: array(str(1, 3000), 1, 30), evidence }),
    BuyerCandidatesV1: obj({ candidates: array(candidate, 0, 50), evidence }),
    QualifiedBuyersV1: obj({ buyers: array(candidate, 0, 50), exclusions: array(str(1, 1000), 0, 100), evidence }),
    // v1 executes one recipient per run. Batch fan-out requires separate runs; never drop later replies.
    OutreachDraftsV1: obj({ messages: array(mail, 1, 1) }),
    SendReceiptsV1: obj({ correlationId: str(1, 200), receipts: array(obj({ recipient: { type: 'string', format: 'email' }, providerId: str(1, 300), acceptedAt: { type: 'string', format: 'date-time' } }), 1, 1) }),
    BuyerReplyV1: obj({ from: { type: 'string', format: 'email' }, subject: str(0, 500), body: str(1, 30000), messageId: str(1, 300) }),
    ReplyClassificationV1: obj({ category: { enum: ['rfq', 'interested', 'declined', 'unsubscribe', 'other'] }, reason: str(1, 3000), needsHuman: { type: 'boolean' } }),
    InquiryV1: obj({ customer: str(1, 300), requirement: str(1, 15000), missingFields: array(str(1, 100), 0, 50), evidence }),
    QuoteDraftV1: obj({ to: { type: 'string', format: 'email' }, subject: { ...str(1, 500), pattern: '^[^\\r\\n]+$' }, body: str(1, 20000), terms: obj({ currency: str(3, 3), priceMinor: int(), moq: int(1), leadDays: int(0, 3650), validityDate: str(10, 40) }), evidence, claimReview: { const: 'human_required' } }),
    SampleDraftV1: obj({ customer: str(1, 300), product: str(1, 500), quantity: int(1, 100), address: str(1, 2000), notes: str(0, 5000), evidence }),
    SampleReceiptV1: obj({ correlationId: str(1, 200), requestId: str(1, 200), acceptedAt: { type: 'string', format: 'date-time' } }),
    SampleUpdateV1: obj({ status: { enum: ['received', 'delayed', 'cancelled', 'feedback'] }, note: str(1, 5000), evidence }),
    SampleSummaryV1: obj({ outcome: str(1, 5000), nextAction: str(1, 5000), evidence })
};
//# sourceMappingURL=contracts.js.map