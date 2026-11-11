import { readFileSync } from 'node:fs';
import type { Capability, Binding } from './types.js';
import { contracts } from './contracts.js';
import { assertSchema, array, int, obj, str } from './schema.js';
import { fail, secureUrl } from './util.js';
const bindingSchema = obj({
    adapter: { enum: ['openmausbot', 'http', 'pricing'] }, botId: str(1, 200), endpoint: str(1, 2000), secretEnv: { ...str(1, 100), pattern: '^[A-Z][A-Z0-9_]*$' },
    tenantId: str(1, 100), pricingTenantId: str(1, 100),
    command: str(1, 1000), args: array(str(0, 1000), 0, 50), envKeys: array(str(1, 100), 0, 30), readOnlyProfileAttested: { type: 'boolean' }
}, ['adapter']);
const capabilitySchema = obj({ id: { ...str(1, 100), pattern: '^[a-z][a-z0-9_.-]+$' }, version: { ...str(1, 30), pattern: '^\\d+\\.\\d+\\.\\d+$' }, description: str(1, 3000),
    inputContract: str(1, 100), outputContract: str(1, 100), effect: { enum: ['read', 'external'] }, enabled: { type: 'boolean' }, maxCostMicros: int(0, 1000000000), binding: bindingSchema
}, ['id', 'version', 'description', 'inputContract', 'outputContract', 'effect', 'enabled', 'maxCostMicros']);
const catalog: [
    string,
    string,
    string,
    string,
    'read' | 'external'
][] = [
    ['market.research', '研究目标市场', 'EnterpriseContextV1', 'MarketBriefV1', 'read'],
    ['buyers.discover', '发现潜在买家并附来源', 'MarketBriefV1', 'BuyerCandidatesV1', 'read'],
    ['buyers.qualify', '验证采购匹配度', 'BuyerCandidatesV1', 'QualifiedBuyersV1', 'read'],
    ['outreach.draft', '起草开发信，不发送', 'QualifiedBuyersV1', 'OutreachDraftsV1', 'read'],
    ['outreach.send', '发送已审批的开发信', 'OutreachDraftsV1', 'SendReceiptsV1', 'external'],
    ['replies.classify', '分类真实买家回复', 'BuyerReplyV1', 'ReplyClassificationV1', 'read'],
    ['inquiry.normalize', '整理询盘与缺失字段', 'EnterpriseContextV1', 'InquiryV1', 'read'],
    ['quote.prepare', '根据企业真实价格规则起草报价', 'InquiryV1', 'QuoteDraftV1', 'read'],
    ['quote.send', '发送已审批的报价', 'QuoteDraftV1', 'SendReceiptsV1', 'external'],
    ['sample.plan', '生成样品申请，不发货', 'EnterpriseContextV1', 'SampleDraftV1', 'read'],
    ['sample.request', '提交已审批的样品申请', 'SampleDraftV1', 'SampleReceiptV1', 'external'],
    ['sample.summarize', '整理样品反馈', 'SampleUpdateV1', 'SampleSummaryV1', 'read'],
    ['quote.import', '读取定价引擎已定稿的对客报价', 'EnterpriseContextV1', 'PricedQuoteV1', 'read'],
    ['quote.send_priced', '发送经双重核验及内容审批的定价报价', 'PricedQuoteV1', 'SendReceiptsV1', 'external']
];
export function defaultCapabilities(): Capability[] {
    return catalog.map(([id, description, inputContract, outputContract, effect]) => ({ id, description, inputContract, outputContract, effect, version: '1.0.0', enabled: false, maxCostMicros: 500000 }));
}
export class Registry {
    private entries = new Map<string, Capability>();
    constructor(capabilities: Capability[] = defaultCapabilities()) {
        assertSchema(array(capabilitySchema, 1, 100), capabilities, 'REGISTRY_SCHEMA');
        for (const c of capabilities) {
            if (this.entries.has(c.id))
                fail('DUPLICATE_CAPABILITY', c.id);
            if (!contracts[c.inputContract] || !contracts[c.outputContract])
                fail('UNKNOWN_CONTRACT', c.id);
            if (c.outputContract === 'PricedQuoteV1' && c.id !== 'quote.import' ||
                c.inputContract === 'PricedQuoteV1' && c.id !== 'quote.send_priced')
                fail('PRICING_CONFIG', 'PricedQuoteV1 is reserved for the dedicated pricing handoff');
            if (c.enabled && !c.binding)
                fail('MISSING_BINDING', c.id);
            if (c.binding)
                this.checkBinding(c.binding, c);
            this.entries.set(c.id, structuredClone(c));
        }
    }
    private checkBinding(b: Binding, c: Capability): void {
        if (c.id === 'quote.import' && (b.adapter !== 'pricing' || c.effect !== 'read' || c.inputContract !== 'EnterpriseContextV1' || c.outputContract !== 'PricedQuoteV1'))
            fail('PRICING_CONFIG', 'Quote import must use the dedicated read-only pricing adapter and contract');
        if (c.id === 'quote.send_priced' && (b.adapter !== 'http' || c.effect !== 'external' || c.inputContract !== 'PricedQuoteV1' || c.outputContract !== 'SendReceiptsV1'))
            fail('PRICING_CONFIG', 'Priced quote delivery requires the dedicated external HTTP gateway contract');
        if (b.adapter === 'pricing') {
            if (c.id !== 'quote.import' || !b.endpoint || !b.secretEnv || !b.tenantId || !b.pricingTenantId)
                fail('PRICING_CONFIG', 'Pricing binding requires explicit workflow/pricing tenant mapping and viewer credential');
            const endpoint = secureUrl(b.endpoint);
            if (endpoint.search) fail('PRICING_CONFIG', 'Pricing endpoint cannot have a query string');
            return;
        }
        if (b.adapter === 'http') {
            if (!b.endpoint)
                fail('MISSING_ENDPOINT', c.id);
            secureUrl(b.endpoint);
            if (!b.secretEnv || !/^[A-Z][A-Z0-9_]*$/.test(b.secretEnv))
                fail('MISSING_GATEWAY_SECRET', c.id);
        }
        else {
            if (!b.botId || !b.command)
                fail('MISSING_BOT_BINDING', c.id);
            if (c.effect !== 'read')
                fail('UNSAFE_BOT_EFFECT', 'External actions must use a dedicated HTTP gateway, not a general-purpose bot');
            if (c.enabled && !b.readOnlyProfileAttested)
                fail('UNATTESTED_BOT', 'An administrator must first isolate and attest a read-only bot profile');
        }
    }
    get(id: string): Capability | undefined { const c = this.entries.get(id); return c ? structuredClone(c) : undefined; }
    list(): Capability[] { return Array.from(this.entries.values(), c => structuredClone(c)); }
    static fromFile(path: string): Registry { return new Registry(JSON.parse(readFileSync(path, 'utf8')) as Capability[]); }
}
