export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type Obj = Record<string, unknown>;
export type Role = 'admin' | 'operator' | 'approver' | 'worker' | 'ingest' | 'viewer';
export interface Principal {
    tenantId: string;
    userId: string;
    role: Role;
}
export interface Context {
    companyName: string;
    products: string[];
    targetMarkets: string[];
    goal: string;
    budgetMicros: number;
    currency: 'USD';
    facts: Record<string, Json>;
}
export type PlaybookId = 'buyer-development' | 'inquiry-quote' | 'sample-followup';
export interface CompileInput {
    request: string;
    context: Context;
    playbook?: PlaybookId;
}
export interface Intent {
    playbook: PlaybookId | null;
    marketHints: string[];
    missing: string[];
    method: 'rules' | 'llm';
    evidence: string[];
}
export interface BaseNode {
    id: string;
    label: string;
    next: string;
}
export interface TaskNode extends BaseNode {
    type: 'agent_task' | 'action';
    capability: string;
    capabilityVersion: string;
    capabilityHash: string;
    input: string;
    inputContract: string;
    outputContract: string;
    maxCostMicros: number;
    timeoutSeconds: number;
    maxAttempts: number;
    approvalNode?: string;
}
export interface ApprovalNode extends BaseNode {
    type: 'human_approval';
    actionId: string;
    input: string;
    role: 'approver';
    timeoutSeconds: number;
    onReject: string;
    onTimeout: string;
}
export interface WaitNode extends BaseNode {
    type: 'wait_event';
    eventType: string;
    correlationFrom: string;
    correlationField: string;
    outputContract: string;
    timeoutSeconds: number;
    onTimeout: string;
}
export interface DecisionNode extends BaseNode {
    type: 'decision';
    input: string;
    field: string;
    equals: Json;
    otherwise: string;
}
export type WorkflowNode = TaskNode | ApprovalNode | WaitNode | DecisionNode;
export interface WorkflowSpec {
    schemaVersion: '1';
    id: string;
    version: number;
    tenantId: string;
    title: string;
    request: string;
    context: Context;
    playbook: PlaybookId;
    entry: string;
    nodes: WorkflowNode[];
    policy: {
        fourEyes: boolean;
        maxRunSeconds: number;
        maxTransitions: number;
    };
}
export interface Problem {
    code: string;
    message: string;
    nodeId?: string;
}
export interface CompileResult {
    status: 'blocked' | 'ready_for_approval';
    intent: Intent;
    errors: Problem[];
    warnings: Problem[];
    workflow: WorkflowSpec | null;
}
export interface Binding {
    adapter: 'openmausbot' | 'http';
    botId?: string;
    endpoint?: string;
    secretEnv?: string;
    command?: string;
    args?: string[];
    envKeys?: string[];
    readOnlyProfileAttested?: boolean;
}
export interface Capability {
    id: string;
    version: string;
    description: string;
    inputContract: string;
    outputContract: string;
    effect: 'read' | 'external';
    enabled: boolean;
    maxCostMicros: number;
    binding?: Binding;
}
export interface Evidence {
    url: string;
    capturedAt: string;
    excerpt: string;
    verification: 'source_observed' | 'unverified';
}
export interface AdapterRequest {
    idempotencyKey: string;
    tenantId: string;
    runId: string;
    stepId: string;
    capability: Capability;
    input: unknown;
    context: Context;
    businessRequest: string;
    deadlineMs: number;
    continuation?: Obj;
}
export type AdapterResult = {
    status: 'completed';
    output: unknown;
    actualCostMicros?: number;
} | {
    status: 'pending';
    continuation: Obj;
    retryAfterMs: number;
};
export interface Adapter {
    execute(request: AdapterRequest): Promise<AdapterResult>;
    doctor?(capability: Capability): Promise<{
        ready: boolean;
        detail: string;
    }>;
}
export type RunStatus = 'PENDING' | 'RUNNING' | 'BATCH_READY' | 'WAITING_APPROVAL' | 'WAITING_EVENT' | 'RETRY_WAIT' | 'COMPLETED' | 'REJECTED' | 'TIMED_OUT' | 'FAILED' | 'CANCELLED' | 'NEEDS_RECONCILIATION';
export interface StepState {
    inheritedFromRunId?: string;
    status: 'running' | 'pending' | 'completed' | 'failed';
    attempts: number;
    startedAt: number;
    output?: unknown;
    error?: string;
    continuation?: Obj;
}
export interface Run {
    deadlineAt?: number;
    batchId?: string;
    sourceRunId?: string;
    targetEmail?: string;
    id: string;
    tenantId: string;
    workflowId: string;
    version: number;
    requestKey: string;
    createdBy: string;
    spec: WorkflowSpec;
    status: RunStatus;
    current: string;
    steps: Record<string, StepState>;
    reservedMicros: number;
    actualMicros: number;
    transitions: number;
    createdAt: number;
    updatedAt: number;
    nextWakeAt: number | null;
    error?: string;
}
export interface Approval {
    id: string;
    tenantId: string;
    runId: string;
    nodeId: string;
    actionId: string;
    payload: unknown;
    payloadHash: string;
    expiresAt: number;
    state: 'pending' | 'approved' | 'rejected';
    decidedBy?: string;
    decidedAt?: number;
}
export interface BusinessEvent {
    sourceId?: string;
    externalId?: string;
    id: string;
    tenantId: string;
    type: string;
    correlationId: string;
    payload: unknown;
    receivedAt: number;
    consumedBy?: string;
}
export interface Definition {
    spec: WorkflowSpec;
    hash: string;
    author: string;
    status: 'draft' | 'published';
    publishedBy?: string;
    publishedAt?: number;
}
