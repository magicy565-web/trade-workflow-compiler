import type { CompileInput, CompileResult, Intent, Principal } from '../types.js';
import { Registry } from '../registry.js';
export declare function extractIntent(input: CompileInput): Intent;
export declare function compile(input: CompileInput, actor: Principal, registry: Registry): CompileResult;
