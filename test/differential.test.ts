import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validate.js';
import { validateRecursive } from '../src/recursiveModel.js';
import type { Schema, SchemaDocument } from '../src/schema.js';

type Rand = () => number;

function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

const KEYS = ['a', 'b', 'c', 'x y', '', 'é', '𐀀', '0'];

function genSchema(rand: Rand, defNames: readonly string[], depth: number): Schema {
  const options = ['integer'];
  if (depth > 0) options.push('object', 'array', 'oneOf');
  if (defNames.length > 0) options.push('ref');
  const kind = pick(rand, options);
  switch (kind) {
    case 'ref':
      return { $ref: pick(rand, defNames) };
    case 'array':
      return { type: 'array', items: genSchema(rand, defNames, depth - 1) };
    case 'oneOf': {
      const count = 1 + Math.floor(rand() * 3);
      return {
        oneOf: Array.from({ length: count }, () => genSchema(rand, defNames, depth - 1)),
      };
    }
    case 'object': {
      const count = 1 + Math.floor(rand() * 3);
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const key = `${pick(rand, KEYS)}${i}`;
        properties[key] = genSchema(rand, defNames, depth - 1);
        if (rand() < 0.5) required.push(key);
      }
      return { type: 'object', properties, required };
    }
    default:
      return { type: 'integer' };
  }
}

function genDoc(rand: Rand): SchemaDocument {
  const defCount = Math.floor(rand() * 3);
  const defNames = Array.from({ length: defCount }, (_, i) => `def${i}`);
  const definitions: Record<string, Schema> = {};
  for (const name of defNames) {
    definitions[name] = genSchema(rand, defNames, 2);
  }
  return { root: genSchema(rand, defNames, 3), definitions };
}

function genGuidedData(schema: Schema, doc: SchemaDocument, rand: Rand, depth: number): unknown {
  let current = schema;
  const seen = new Set<string>();
  while ('$ref' in current) {
    if (depth <= 0 || seen.has(current.$ref)) return 0;
    seen.add(current.$ref);
    const target = doc.definitions?.[current.$ref];
    if (target === undefined) return null;
    current = target;
  }
  if ('oneOf' in current) {
    return genGuidedData(pick(rand, [...current.oneOf]), doc, rand, depth - 1);
  }
  if (current.type === 'integer') return Math.floor(rand() * 20) - 10;
  if (current.type === 'array') {
    const count = depth <= 0 ? 0 : Math.floor(rand() * 3);
    return Array.from({ length: count }, () => genGuidedData(current.items, doc, rand, depth - 1));
  }
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(current.properties)) {
    const isRequired = (current.required ?? []).includes(key);
    if (isRequired || rand() < 0.7) {
      obj[key] = genGuidedData(current.properties[key] as Schema, doc, rand, depth - 1);
    }
  }
  return obj;
}

function genArbitraryData(rand: Rand, depth: number): unknown {
  const options =
    depth > 0
      ? ['int', 'float', 'string', 'bool', 'null', 'array', 'object']
      : ['int', 'float', 'string', 'bool', 'null'];
  switch (pick(rand, options)) {
    case 'int':
      return Math.floor(rand() * 100) - 50;
    case 'float':
      return rand() * 10;
    case 'string':
      return pick(rand, ['', 'a', 'hello', 'é', '𐀀', '0']);
    case 'bool':
      return rand() < 0.5;
    case 'null':
      return null;
    case 'array':
      return Array.from({ length: Math.floor(rand() * 4) }, () => genArbitraryData(rand, depth - 1));
    default: {
      const obj: Record<string, unknown> = {};
      const count = Math.floor(rand() * 4);
      for (let i = 0; i < count; i += 1) {
        obj[pick(rand, KEYS)] = genArbitraryData(rand, depth - 1);
      }
      return obj;
    }
  }
}

function maybeInjectCycle(rand: Rand, data: unknown): unknown {
  if (rand() >= 0.08) return data;
  if (Array.isArray(data)) {
    data.push(data);
  } else if (typeof data === 'object' && data !== null) {
    (data as Record<string, unknown>).loop = data;
  }
  return data;
}

function show(value: unknown): string {
  const seen = new Set<unknown>();
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === 'object' && nested !== null) {
      if (seen.has(nested)) return '<cycle>';
      seen.add(nested);
    }
    return nested;
  });
}

test('differential: iterative engine matches the direct recursive model', () => {
  const cases = 400;
  for (let seed = 1; seed <= cases; seed += 1) {
    const rand = mulberry32(seed);
    const doc = genDoc(rand);
    const base = rand() < 0.5 ? genGuidedData(doc.root, doc, rand, 4) : genArbitraryData(rand, 4);
    const data = maybeInjectCycle(rand, base);
    const expected = validateRecursive(data, doc);
    const actual = validate(data, doc);
    assert.deepEqual(
      actual,
      expected,
      `seed ${seed} mismatch\nschema: ${show(doc)}\ndata: ${show(data)}`,
    );
  }
});

// The recursive oracle is inherently call-stack bound (that is exactly why
// the primary engine is iterative), so parity on deep data is checked at a
// depth the oracle survives; validate.test.ts drives the iterative engine
// alone through a 200k-node list.
test('differential: deep recursive data at moderate depth agrees', () => {
  const doc: SchemaDocument = {
    definitions: {
      List: {
        type: 'object',
        properties: {
          value: { type: 'integer' },
          next: { oneOf: [{ $ref: 'List' }, { type: 'integer' }] },
        },
        required: ['value'],
      },
    },
    root: { $ref: 'List' },
  };
  const depth = 500;
  let node: Record<string, unknown> = { value: depth - 1, next: 0 };
  for (let i = depth - 2; i >= 0; i -= 1) {
    node = { value: i, next: node };
  }
  assert.deepEqual(validate(node, doc), validateRecursive(node, doc));
  assert.deepEqual(validate(node, doc), []);
});
