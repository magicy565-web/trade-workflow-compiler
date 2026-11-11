import { randomUUID } from 'node:crypto';
import type { CompileInput, CompileResult, Intent, PlaybookId, Principal } from '../types.js';
import { Registry } from '../registry.js';
import { assertSchema } from '../schema.js';
import { compileInputSchema } from '../contracts.js';
import { buildPlaybook } from './playbooks.js';
import { validateWorkflow } from './validator.js';
export function extractIntent(input: CompileInput): Intent {
    let playbook: PlaybookId | null = input.playbook ?? null;
    if (!playbook) {
        const text = input.request.toLowerCase();
        if (/样品|sample/.test(text))
            playbook = 'sample-followup';
        else if (/询盘|报价|rfq|quotation|quote/.test(text) && !/开发.*客户|买家开发/.test(text))
            playbook = 'inquiry-quote';
        else if (/开发.*客户|买家|买手|buyer|prospect|outreach|客户开发/.test(text))
            playbook = 'buyer-development';
    }
    const missing: string[] = [];
    if (!input.context.companyName.trim())
        missing.push('companyName');
    if (!input.context.products.length)
        missing.push('products');
    if (!input.context.targetMarkets.length)
        missing.push('targetMarkets');
    if (input.context.budgetMicros <= 0)
        missing.push('budgetMicros');
    if (!playbook)
        missing.push('playbook');
    const marketHints = /美国|\bUS\b|United States/i.test(input.request) ? ['US'] : [];
    return { playbook, marketHints, missing, method: 'rules', evidence: [input.request] };
}
export function compile(input: CompileInput, actor: Principal, registry: Registry): CompileResult {
    assertSchema(compileInputSchema, input);
    const intent = extractIntent(input), errors = intent.missing.map(field => ({ code: 'MISSING_FACT', message: `Missing explicit enterprise fact: ${field}` }));
    if (!intent.playbook)
        return { status: 'blocked', intent, errors, warnings: [], workflow: null };
    const workflow = buildPlaybook(intent.playbook, input.context, input.request, actor.tenantId, randomUUID(), registry);
    errors.push(...validateWorkflow(workflow, registry));
    return { status: errors.length ? 'blocked' : 'ready_for_approval', intent, errors, workflow,
        warnings: [{ code: 'BUDGET_SCOPE', message: 'Budget is a dispatch authorization/reservation, not a provider billing hard cap.' },
            { code: 'HUMAN_VERIFICATION', message: 'Research evidence is source-reported, not independently certified. Check recipients and commercial claims before approval.' }] };
}
