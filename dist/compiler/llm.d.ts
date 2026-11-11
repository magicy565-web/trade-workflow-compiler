import type { CompileInput, PlaybookId } from '../types.js';
export declare function selectPlaybook(input: CompileInput, config: {
    endpoint: string;
    apiKey: string;
    model: string;
}): Promise<{
    playbook: PlaybookId;
    supportingQuotes: string[];
}>;
