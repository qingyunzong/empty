import test from "node:test";
import assert from "node:assert/strict";
import { compileProjection, type ColumnSpec } from "../src/compile.ts";
import { projectRecord, type JsonValue } from "../src/project.ts";
import { referenceProject } from "./reference.ts";
import { mulberry32, normalizeRows, randomInt } from "./helpers.ts";

type Rng = () => number;

const KEYS = ["a", "b", "c", "d"];
const FUZZ_ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 500);
const FUZZ_SEED_A = Number(process.env.FUZZ_SEED_A ?? 0xc0ffee);
const FUZZ_SEED_B = Number(process.env.FUZZ_SEED_B ?? 0x5eed);

function randomScalar(rng: Rng): JsonValue {
  switch (randomInt(rng, 5)) {
    case 0:
      return null;
    case 1:
      return true;
    case 2:
      return false;
    case 3:
      return randomInt(rng, 100);
    default:
      return `s${randomInt(rng, 10)}`;
  }
}

function randomValue(rng: Rng, depth: number): JsonValue {
  const roll = rng();
  if (depth <= 0 || roll < 0.3) return randomScalar(rng);
  if (roll < 0.6) {
    const length = randomInt(rng, 3);
    const out: JsonValue[] = [];
    for (let i = 0; i < length; i++) out.push(randomValue(rng, depth - 1));
    return out;
  }
  const obj: { [key: string]: JsonValue } = {};
  const keys = [...KEYS];
  const count = randomInt(rng, 4);
  for (let i = 0; i < count && keys.length > 0; i++) {
    const key = keys.splice(randomInt(rng, keys.length), 1)[0];
    obj[key] = randomValue(rng, depth - 1);
  }
  return obj;
}

function randomPath(rng: Rng): string {
  const stepCount = 1 + randomInt(rng, 4);
  let arrays = 0;
  let path = "";
  for (let i = 0; i < stepCount; i++) {
    if (arrays < 2 && rng() < 0.35) {
      arrays++;
      path += "[*]";
    } else {
      const name = KEYS[randomInt(rng, KEYS.length)];
      path += path === "" ? name : `.${name}`;
    }
  }
  return path;
}

function randomColumns(rng: Rng): ColumnSpec[] {
  const count = 1 + randomInt(rng, 3);
  return Array.from({ length: count }, (_, i) => ({ name: `c${i}`, path: randomPath(rng) }));
}

function compare(
  columns: ColumnSpec[],
  record: JsonValue,
  maxRows: number | undefined,
  label: string,
): void {
  const context = `record=${JSON.stringify(record)} columns=${JSON.stringify(columns)} maxRows=${maxRows}`;
  const compiled = compileProjection(columns);
  const run = (fn: () => unknown): { rows?: unknown; code?: string } => {
    try {
      return { rows: fn() };
    } catch (error) {
      return { code: (error as { code?: string }).code ?? String(error) };
    }
  };
  const main = run(() =>
    normalizeRows(projectRecord(compiled, record, maxRows === undefined ? {} : { maxRows })),
  );
  const reference = run(() => normalizeRows(referenceProject(columns, record, maxRows)));
  assert.equal(main.code, reference.code, `${label}: error codes differ; ${context}`);
  if (main.code === undefined) {
    assert.deepStrictEqual(main.rows, reference.rows, `${label}: rows differ; ${context}`);
  }
}

test("fuzz: random records and random paths match the reference", () => {
  const rng = mulberry32(FUZZ_SEED_A);
  for (let iter = 0; iter < FUZZ_ITERATIONS; iter++) {
    compare(randomColumns(rng), randomValue(rng, 4), undefined, `iter ${iter}`);
  }
});

type Schema =
  | { readonly kind: "leaf" }
  | { readonly kind: "array"; readonly element: Schema }
  | {
      readonly kind: "object";
      readonly fields: ReadonlyArray<{ name: string; optional: boolean; schema: Schema }>;
    };

function randomSchema(rng: Rng, depth: number): Schema {
  if (depth <= 0) return { kind: "leaf" };
  const roll = rng();
  if (roll < 0.3) return { kind: "array", element: randomSchema(rng, depth - 1) };
  if (roll < 0.75) {
    const keys = [...KEYS];
    const count = 1 + randomInt(rng, 3);
    const fields: Array<{ name: string; optional: boolean; schema: Schema }> = [];
    for (let i = 0; i < count && keys.length > 0; i++) {
      const name = keys.splice(randomInt(rng, keys.length), 1)[0];
      fields.push({ name, optional: rng() < 0.35, schema: randomSchema(rng, depth - 1) });
    }
    return { kind: "object", fields };
  }
  return { kind: "leaf" };
}

function randomObjectSchema(rng: Rng, depth: number): Schema {
  for (;;) {
    const schema = randomSchema(rng, depth);
    if (schema.kind === "object") return schema;
  }
}

function valueFromSchema(rng: Rng, schema: Schema): JsonValue {
  switch (schema.kind) {
    case "leaf":
      return randomScalar(rng);
    case "array": {
      const roll = rng();
      const length = roll < 0.25 ? 0 : roll < 0.6 ? 1 : 2;
      const out: JsonValue[] = [];
      for (let i = 0; i < length; i++) out.push(valueFromSchema(rng, schema.element));
      return out;
    }
    case "object": {
      const obj: { [key: string]: JsonValue } = {};
      for (const field of schema.fields) {
        if (field.optional && rng() < 0.4) continue;
        obj[field.name] = valueFromSchema(rng, field.schema);
      }
      return obj;
    }
  }
}

function pathsFromSchema(schema: Schema): string[] {
  const out: string[] = [];
  const walk = (node: Schema, prefix: string): void => {
    if (node.kind === "leaf") {
      out.push(prefix);
      return;
    }
    if (node.kind === "array") {
      walk(node.element, `${prefix}[*]`);
      return;
    }
    for (const field of node.fields) {
      walk(field.schema, prefix === "" ? field.name : `${prefix}.${field.name}`);
    }
  };
  walk(schema, "");
  return out;
}

test("fuzz: schema-conformant records with row limits match the reference", () => {
  const rng = mulberry32(FUZZ_SEED_B);
  const limits: Array<number | undefined> = [undefined, 0, 1, 2, 3, 5, 8, 16];
  for (let iter = 0; iter < FUZZ_ITERATIONS; iter++) {
    const schema = randomObjectSchema(rng, 4);
    const record = valueFromSchema(rng, schema);
    const paths = pathsFromSchema(schema);
    for (let i = paths.length - 1; i > 0; i--) {
      const j = randomInt(rng, i + 1);
      [paths[i], paths[j]] = [paths[j], paths[i]];
    }
    const count = 1 + randomInt(rng, Math.min(4, paths.length));
    const columns = paths.slice(0, count).map((path, i) => ({ name: `c${i}`, path }));
    const maxRows = limits[randomInt(rng, limits.length)];
    compare(columns, record, maxRows, `iter ${iter}`);
  }
});
