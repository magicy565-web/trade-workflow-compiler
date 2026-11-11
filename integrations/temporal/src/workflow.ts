import { proxyActivities, defineSignal, setHandler, condition, continueAsNew } from '@temporalio/workflow';
import type * as activities from './activities.js';
const { advanceRun } = proxyActivities<typeof activities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 10, initialInterval: '2 seconds', maximumInterval: '1 minute' } });
export const wakeSignal = defineSignal('wake');
const terminal = new Set(['COMPLETED', 'REJECTED', 'TIMED_OUT', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION']);
export async function tradeWorkflow(runId: string): Promise<string> {
    let wake = false;
    setHandler(wakeSignal, () => { wake = true; });
    for (let iteration = 0; iteration < 500; iteration++) {
        wake = false;
        const r = await advanceRun(runId);
        if (terminal.has(r.status))
            return r.status;
        const delay = Math.max(1000, Math.min(30000, (r.nextWakeAt ?? Date.now() + 1000) - Date.now()));
        await condition(() => wake, delay);
    }
    // Keep history bounded. The immutable workflow spec and execution journal remain in TWC's SQLite database.
    return await continueAsNew<typeof tradeWorkflow>(runId);
}
