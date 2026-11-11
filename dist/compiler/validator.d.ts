import type { Problem, WorkflowNode } from '../types.js';
import type { Registry } from '../registry.js';
export declare function edges(n: WorkflowNode): string[];
export declare function validateWorkflow(value: unknown, registry: Registry, checkEnabled?: boolean): Problem[];
