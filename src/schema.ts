export type Schema =
  | { readonly type: 'integer' }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, Schema>>;
      readonly required?: readonly string[];
    }
  | { readonly type: 'array'; readonly items: Schema }
  | { readonly $ref: string }
  | { readonly oneOf: readonly Schema[] };

export type ConcreteSchema = Exclude<Schema, { readonly $ref: string }>;

export interface SchemaDocument {
  readonly root: Schema;
  readonly definitions?: Readonly<Record<string, Schema>>;
}

export type ResolveResult =
  | { readonly ok: true; readonly schema: ConcreteSchema }
  | {
      readonly ok: false;
      readonly code: 'ref.unresolved' | 'ref.loop';
      readonly message: string;
    };

// Follows a chain of bare `$ref` schemas (`A -> B -> ...`) until a concrete
// schema is reached. A chain that revisits a definition name without ever
// descending into the data can never make progress, so it is reported as a
// schema-level `ref.loop` error instead of spinning forever.
export function resolveRefChain(schema: Schema, doc: SchemaDocument): ResolveResult {
  let current: Schema = schema;
  const seen = new Set<string>();
  while ('$ref' in current) {
    const name = current.$ref;
    if (seen.has(name)) {
      const chain = [...seen, name].join(' -> ');
      return {
        ok: false,
        code: 'ref.loop',
        message: `reference cycle that never consumes data: ${chain}`,
      };
    }
    seen.add(name);
    const target = doc.definitions?.[name];
    if (target === undefined) {
      return {
        ok: false,
        code: 'ref.unresolved',
        message: `unresolved reference ${JSON.stringify(name)}`,
      };
    }
    current = target;
  }
  return { ok: true, schema: current };
}
