import { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { Engine } from './runtime/engine.js';
import { Store } from './store.js';
export declare function createApi(config: Config, store: Store, engine: Engine): import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
export declare function startScheduler(store: Store, engine: Engine): () => Promise<void>;
