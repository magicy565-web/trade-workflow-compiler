export interface Schema {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean | Schema;
    items?: Schema;
    minItems?: number;
    maxItems?: number;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    enum?: unknown[];
    const?: unknown;
    oneOf?: Schema[];
    format?: 'uri' | 'date-time' | 'email';
    pattern?: string;
}
export declare function validate(schema: Schema, value: unknown, path?: string, depth?: number): string[];
export declare function assertSchema(schema: Schema, value: unknown, code?: string): void;
export declare const str: (min?: number, max?: number) => Schema;
export declare const int: (min?: number, max?: number) => Schema;
export declare const array: (items: Schema, min?: number, max?: number) => Schema;
export declare const obj: (properties: Record<string, Schema>, required?: string[]) => Schema;
