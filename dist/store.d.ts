import { DatabaseSync } from 'node:sqlite';
import type { Approval, BusinessEvent, Definition, Principal, Run, RunStatus, WorkflowSpec } from './types.js';
export declare const terminal: Set<RunStatus>;
export declare class Store {
    readonly db: DatabaseSync;
    constructor(path: string);
    close(): void;
    transaction<T>(fn: () => T): T;
    audit(tenant: string, actor: string, type: string, payload: unknown): void;
    verifyAudit(): boolean;
    auditLog(tenant: string): unknown[];
    saveDefinition(spec: WorkflowSpec, actor: Principal): Definition;
    getDefinition(tenant: string, id: string, version: number): Definition;
    listDefinitions(tenant: string): Definition[];
    publish(tenant: string, id: string, version: number, expectedHash: string, actor: Principal): Definition;
    createRun(tenant: string, workflowId: string, version: number, key: string, actor: Principal): Run;
    getRun(tenant: string, id: string): Run;
    putRun(r: Run): void;
    mutateRun(tenant: string, id: string, fn: (run: Run) => void): Run;
    listRuns(tenant?: string): Run[];
    acquire(tenant: string, id: string, owner: string, now: number): boolean;
    release(tenant: string, id: string, owner: string): void;
    getApproval(tenant: string, id: string): Approval;
    approvalFor(tenant: string, runId: string, nodeId: string): Approval | undefined;
    createApproval(a: Approval): void;
    listApprovals(tenant: string): Approval[];
    approvalsByRun(tenant: string, runId: string): Approval[];
    decideApproval(tenant: string, id: string, expectedHash: string, approved: boolean, actor: Principal, now?: number): Approval;
    ingest(e: BusinessEvent, actor: Principal): {
        duplicate: boolean;
        state: string;
    };
    matchingEvent(tenant: string, type: string, correlation: string, after: number, through: number): BusinessEvent | undefined;
    consumeEvent(e: BusinessEvent, runId: string): boolean;
    suppress(tenant: string, email: string, reason: string, actor: Principal): void;
    isSuppressed(tenant: string, email: string): boolean;
}
