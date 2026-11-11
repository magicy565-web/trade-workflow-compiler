import type { Context, PlaybookId, WorkflowSpec } from '../types.js';
import type { Registry } from '../registry.js';
export declare function buildPlaybook(id: PlaybookId, context: Context, request: string, tenantId: string, workflowId: string, registry: Registry): WorkflowSpec;
