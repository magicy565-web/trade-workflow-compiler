// Synthetic protocol server for tests ONLY. This file is never used by the production configuration.
import readline from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const path = process.env.TWC_FIXTURE_STATE;
let state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { tasks: 0, sends: 0, seen: {} };
function save() { writeFileSync(path, JSON.stringify(state)); }
const names = ['get_system_health', 'list_bots', 'create_task', 'send_bot_message', 'wait_for_conversation', 'get_bot_messages'];
function tool(name, args) {
    if (name === 'get_system_health')
        return { app: 'openmausbot', status: 'connected' };
    if (name === 'list_bots')
        return { bots: [{ id: 'fixture-bot' }] };
    if (name === 'create_task') {
        state.tasks++;
        save();
        return { success: true, task: { taskId: 'fixture-task-' + state.tasks } };
    }
    if (name === 'send_bot_message') {
        if (!state.seen[args.send_id]) {
            state.sends++;
            state.seen[args.send_id] = true;
            state.job = JSON.parse(args.text);
            save();
        }
        return { success: true, messageId: 'fixture-message', at: Date.now() };
    }
    if (name === 'wait_for_conversation')
        return { status: 'settled', state: process.env.TWC_FIXTURE_JOB_STATE ?? 'completed', job: { version: 'v1', since: Date.now() } };
    if (name === 'get_bot_messages')
        return { messages: [{ role: 'bot', kind: 'text', text: JSON.stringify({ requestId: process.env.TWC_FIXTURE_BAD_ID ? 'wrong' : state.job.requestId, contract: state.job.outputContract, data: JSON.parse(readFileSync(process.env.TWC_FIXTURE_OUTPUT, 'utf8')) }) }] };
    throw Error('unknown tool');
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
    let req;
    try {
        req = JSON.parse(line);
    }
    catch {
        return;
    }
    if (req.id === undefined)
        return;
    let result;
    if (req.method === 'initialize')
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'TEST ONLY', version: '1' } };
    else if (req.method === 'tools/list')
        result = { tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) };
    else if (req.method === 'tools/call')
        result = { content: [{ type: 'text', text: JSON.stringify(tool(req.params.name, req.params.arguments)) }] };
    else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'not supported' } }) + '\n');
        return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
});
