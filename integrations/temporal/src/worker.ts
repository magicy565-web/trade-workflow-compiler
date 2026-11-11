import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { advanceRun, listRuns } from './activities.js';
const terminal = new Set(['COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION']);
const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', namespace = process.env.TEMPORAL_NAMESPACE ?? 'default', taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'trade-workflows';
// This package targets a LOCAL/self-hosted Temporal service. Configure authenticated TLS before remote production use.
const connection = await Connection.connect({ address });
const native = await NativeConnection.connect({ address });
const client = new Client({ connection, namespace });
const worker = await Worker.create({ connection: native, namespace, taskQueue, workflowsPath: fileURLToPath(new URL('./workflow.js', import.meta.url)), activities: { advanceRun } });
let stopped = false;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function scan(): Promise<void> {
    while (!stopped) {
        try {
            const runs = await listRuns();
            for (const r of runs) {
                if (terminal.has(r.status))
                    continue;
                const workflowId = 'twc-' + createHash('sha256').update(r.tenantId + ':' + r.id).digest('hex');
                try {
                    await client.workflow.start('tradeWorkflow', { workflowId, taskQueue, args: [r.id], workflowIdReusePolicy: 'ALLOW_DUPLICATE' });
                }
                catch (error) {
                    if (!(error instanceof WorkflowExecutionAlreadyStartedError))
                        throw error;
                }
            }
        }
        catch {
            console.error('Temporal discovery failed; no local fallback or permission bypass was attempted.');
        }
        await sleep(3000);
    }
}
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => { stopped = true; worker.shutdown(); });
const scanner = scan();
try {
    await worker.run();
}
finally {
    stopped = true;
    await scanner;
    await connection.close();
    await native.close();
}
