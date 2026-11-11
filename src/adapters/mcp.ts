import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DomainError, fail, record } from '../util.js';
import type { Obj } from '../types.js';
export interface McpOptions {
    command: string;
    args: string[];
    env: Record<string, string>;
    timeoutMs: number;
}
/** Narrow stdio JSON-RPC client. No remote commands, sampling, roots, credential discovery or shell execution. */
export class McpClient {
    private child: ChildProcessWithoutNullStreams;
    private sequence = 0;
    private buffer = '';
    private closed = false;
    private pending = new Map<number, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private tools: Obj[] = [];
    constructor(private options: McpOptions) {
        this.child = spawn(options.command, options.args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
        this.child.stderr.on('data', () => { }); // Drain, do not leak upstream credentials or transcripts into HTTP logs.
        this.child.on('error', () => this.abort(new DomainError('MCP_PROCESS', 'Could not start configured MCP executable')));
        this.child.on('close', () => this.abort(new DomainError('MCP_CLOSED', 'MCP process exited')));
    }
    private receive(chunk: string): void {
        this.buffer += chunk;
        if (this.buffer.length > 1048576) {
            this.abort(new DomainError('MCP_SIZE', 'MCP frame exceeded 1 MB'));
            this.child.kill();
            return;
        }
        let at: number;
        while ((at = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, at).trim();
            this.buffer = this.buffer.slice(at + 1);
            if (!line)
                continue;
            let frame: unknown;
            try {
                frame = JSON.parse(line);
            }
            catch {
                this.abort(new DomainError('MCP_FRAME', 'Non-JSON output on MCP stdout'));
                return;
            }
            if (!record(frame))
                continue;
            if (typeof frame.method === 'string') {
                if (frame.id !== undefined)
                    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Client method not supported' } }) + '\n');
                continue;
            }
            if (typeof frame.id !== 'number')
                continue;
            const p = this.pending.get(frame.id);
            if (!p)
                continue;
            clearTimeout(p.timer);
            this.pending.delete(frame.id);
            if (frame.error)
                p.reject(new DomainError('MCP_RPC', 'MCP returned an RPC error'));
            else
                p.resolve(frame.result);
        }
    }
    private abort(error: Error): void { this.closed = true; for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
    } this.pending.clear(); }
    request(method: string, params: unknown): Promise<unknown> {
        if (this.closed)
            return Promise.reject(new DomainError('MCP_CLOSED', 'MCP client is closed'));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new DomainError('MCP_TIMEOUT', 'MCP request timed out')); }, this.options.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', e => { if (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new DomainError('MCP_WRITE', 'MCP pipe write failed'));
            } });
        });
    }
    async connect(): Promise<void> {
        const result = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'trade-workflow-compiler', version: '0.1.0' } });
        if (!record(result) || !record(result.capabilities) || !record(result.capabilities.tools))
            fail('MCP_PROTOCOL', 'Server did not advertise tools');
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const listed = await this.request('tools/list', {});
        if (!record(listed) || !Array.isArray(listed.tools))
            fail('MCP_PROTOCOL', 'No tool registry');
        this.tools = listed.tools.filter(record);
    }
    hasTool(name: string): boolean { return this.tools.some(t => t.name === name); }
    async call(name: string, args: Obj): Promise<Obj> {
        const tool = this.tools.find(t => t.name === name);
        if (!tool)
            fail('MCP_CAPABILITY', 'Required MCP tool is missing: ' + name);
        if (!record(tool.inputSchema))
            fail('MCP_SCHEMA', 'Tool input schema missing');
        const required = tool.inputSchema.required;
        if (Array.isArray(required) && required.some(k => typeof k === 'string' && !Object.hasOwn(args, k)))
            fail('MCP_SCHEMA', 'Tool requires unsupported arguments');
        const response = await this.request('tools/call', { name, arguments: args });
        if (!record(response) || response.isError === true)
            fail('MCP_TOOL', 'MCP tool failed');
        if (record(response.structuredContent)) {
            if (response.structuredContent.success === false)
                fail('MCP_TOOL', 'MCP tool returned a failure');
            return response.structuredContent;
        }
        const texts = Array.isArray(response.content) ? response.content.filter(v => record(v) && v.type === 'text' && typeof v.text === 'string') : [];
        if (texts.length !== 1)
            fail('MCP_RESULT', 'Expected one JSON tool result');
        let parsed: unknown;
        try {
            parsed = JSON.parse((texts[0] as Obj).text as string);
        }
        catch {
            return fail('MCP_RESULT', 'Tool result was not structured JSON');
        }
        if (!record(parsed) || parsed.success === false)
            fail('MCP_RESULT', 'Tool returned an invalid result');
        return parsed;
    }
    close(): void { this.abort(new DomainError('MCP_CLOSED', 'Client closed')); this.child.stdin.end(); this.child.kill(); }
}
