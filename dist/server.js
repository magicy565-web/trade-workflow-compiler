import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './runtime/engine.js';
import { PricingAdapter } from './adapters/pricing.js';
import { HttpGatewayAdapter } from './adapters/http.js';
import { OpenMausBotAdapter } from './adapters/openmausbot.js';
import { createApi, startScheduler } from './api.js';
const config = loadConfig(), store = new Store(resolve(config.dataDir, 'twc.sqlite'));
const engine = new Engine(store, config.registry, { pricing: new PricingAdapter(), http: new HttpGatewayAdapter(), openmausbot: new OpenMausBotAdapter() });
const server = createApi(config, store, engine);
const stop = config.scheduler === 'embedded' ? startScheduler(store, engine) : async () => { };
server.requestTimeout = 35000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => console.log(`Trade Workflow Compiler v0.5.0: http://${config.host}:${config.port} | scheduler=${config.scheduler} | unbound capabilities cannot execute`));
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        void stop().then(() => server.close(() => { store.close(); process.exit(0); }));
        setTimeout(() => process.exit(1), 35000).unref();
    });
//# sourceMappingURL=server.js.map