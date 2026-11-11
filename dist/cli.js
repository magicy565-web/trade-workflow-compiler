import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultCapabilities, Registry } from './registry.js';
import { contracts } from './contracts.js';
import { workflowSchema } from './compiler/spec-schema.js';
import { compile } from './compiler/compiler.js';
import { loadConfig } from './config.js';
import { PricingAdapter } from './adapters/pricing.js';
import { HttpGatewayAdapter } from './adapters/http.js';
import { OpenMausBotAdapter } from './adapters/openmausbot.js';
const [command, ...args] = process.argv.slice(2);
try {
    if (command === 'init') {
        const dir = resolve(process.env.TWC_DATA_DIR ?? 'data');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const auth = resolve(dir, 'auth.local.json');
        if (existsSync(auth))
            throw Error('Authentication file already exists; refusing to overwrite credentials');
        const roles = ['admin', 'operator', 'approver', 'worker', 'ingest', 'viewer'];
        writeFileSync(auth, JSON.stringify(roles.map(role => ({ tenantId: 'default', userId: `local-${role}`, role, token: randomBytes(32).toString('hex') })), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        const cap = resolve(dir, 'capabilities.local.json');
        if (!existsSync(cap))
            writeFileSync(cap, JSON.stringify(defaultCapabilities(), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        const events = resolve(dir, 'event-sources.local.json');
        if (!existsSync(events))
            writeFileSync(events, '[]\n', { mode: 0o600, flag: 'wx' });
        console.log(`Created ${auth}\nCreated disabled capability configuration in ${cap}\nTokens are not printed. Give operator/approver credentials to DIFFERENT people. Do not commit data/.`);
    }
    else if (command === 'compile') {
        if (!args[0])
            throw Error('Usage: npm run compile -- path/to/business-request.json [path/to/capabilities.json]');
        const input = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
        const registry = args[1] ? Registry.fromFile(resolve(args[1])) : new Registry();
        const result = compile(input, { tenantId: 'default', userId: 'cli-operator', role: 'operator' }, registry);
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.status === 'blocked' ? 2 : 0;
    }
    else if (command === 'schemas') {
        mkdirSync('schemas', { recursive: true });
        writeFileSync('schemas/workflow-v1.schema.json', JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...workflowSchema }, null, 2) + '\n');
        for (const [name, schema] of Object.entries(contracts))
            writeFileSync(`schemas/${name}.schema.json`, JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema }, null, 2) + '\n');
        console.log('Wrote schema files');
    }
    else if (command === 'doctor') {
        const config = loadConfig(), adapters = { pricing: new PricingAdapter(), http: new HttpGatewayAdapter(), openmausbot: new OpenMausBotAdapter() };
        const results = [];
        for (const c of config.registry.list()) {
            if (!c.enabled || !c.binding) {
                results.push({ id: c.id, ready: false, detail: 'Disabled or unbound; execution blocked' });
                continue;
            }
            results.push({ id: c.id, ...await adapters[c.binding.adapter].doctor(c) });
        }
        console.log(JSON.stringify({ node: process.version, results }, null, 2));
        if (results.some(r => !r.ready))
            process.exitCode = 2;
    }
    else {
        console.log('Commands: init | compile <request.json> [registry.json] | schemas | doctor');
        process.exitCode = command ? 1 : 0;
    }
}
catch (error) {
    console.error(error instanceof Error ? error.message : 'Command failed');
    process.exitCode = 1;
}
//# sourceMappingURL=cli.js.map