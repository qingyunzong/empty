import { test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import type { RootSchema, Schema } from "../src/schema.js";
import { comparePaths, sortErrors } from "../src/schema.js";
import { validate } from "../src/validate.js";
import { validateReference } from "../src/reference.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["a", "b", "c", "z", "é", "x y"];

class RandomGen {
  constructor(private readonly rand: () => number) {}

  int(bound: number): number {
    return Math.floor(this.rand() * bound);
  }

  pick<T>(items: T[]): T {
    return items[this.int(items.length)]!;
  }

  schema(depth: number, defs: string[]): Schema {
    if (depth <= 0) {
      return this.pick<Schema>([
        { type: "integer" },
        { type: "array", items: { type: "integer" } },
        { type: "object", properties: {} },
      ]);
    }
    switch (this.int(6)) {
      case 0:
      case 1:
        return { type: "integer" };
      case 2: {
        const properties: Record<string, Schema> = {};
        const count = this.int(4);
        for (let i = 0; i < count; i++) {
          properties[this.pick(KEYS)] = this.schema(depth - 1, defs);
        }
        const keys = Object.keys(properties);
        const required = keys.filter(() => this.rand() < 0.5);
        return required.length > 0
          ? { type: "object", properties, required }
          : { type: "object", properties };
      }
      case 3:
        return { type: "array", items: this.schema(depth - 1, defs) };
      case 4: {
        const branches: Schema[] = [];
        const count = 2 + this.int(2);
        for (let i = 0; i < count; i++) {
          branches.push(this.schema(depth - 1, defs));
        }
        return { oneOf: branches };
      }
      default:
        if (defs.length > 0 && this.rand() < 0.7) {
          return { $ref: `#/definitions/${this.pick(defs)}` };
        }
        return { type: "integer" };
    }
  }

  rootSchema(): RootSchema {
    const defNames: string[] = [];
    const defCount = this.int(3);
    for (let i = 0; i < defCount; i++) {
      defNames.push(`d${i}`);
    }
    const definitions: Record<string, Schema> = {};
    for (const name of defNames) {
      definitions[name] = this.schema(2, defNames);
    }
    const root = this.schema(3, defNames) as RootSchema;
    if (defNames.length > 0) {
      root.definitions = definitions;
    }
    return root;
  }

  value(depth: number): unknown {
    switch (this.int(8)) {
      case 0:
      case 1:
      case 2:
        return this.int(21) - 10;
      case 3:
        return this.pick(["s", "", "é", "x/y"]);
      case 4:
        return this.pick([true, false, null, 1.5]);
      case 5: {
        if (depth <= 0) return this.int(10);
        const length = this.int(4);
        const arr: unknown[] = [];
        for (let i = 0; i < length; i++) {
          arr.push(this.value(depth - 1));
        }
        return arr;
      }
      default: {
        if (depth <= 0) return this.int(10);
        const obj: Record<string, unknown> = {};
        const count = this.int(5);
        for (let i = 0; i < count; i++) {
          obj[this.pick(KEYS)] = this.value(depth - 1);
        }
        return obj;
      }
    }
  }

  conforming(schema: Schema, root: RootSchema, fuel: number): unknown {
    let current = schema;
    while ("$ref" in current) {
      if (fuel <= 0) {
        return this.int(10);
      }
      fuel--;
      const name = current.$ref.slice("#/definitions/".length);
      current = root.definitions![name]!;
    }
    if ("oneOf" in current) {
      return this.conforming(this.pick(current.oneOf), root, fuel);
    }
    switch (current.type) {
      case "integer":
        return this.int(21) - 10;
      case "array": {
        if (fuel <= 0) return [];
        const length = this.int(3);
        const arr: unknown[] = [];
        for (let i = 0; i < length; i++) {
          arr.push(this.conforming(current.items, root, fuel - 1));
        }
        return arr;
      }
      case "object": {
        const obj: Record<string, unknown> = {};
        const properties = current.properties ?? {};
        for (const key of Object.keys(properties)) {
          const required = (current.required ?? []).includes(key);
          if (required || this.rand() < 0.7) {
            obj[key] =
              fuel <= 0
                ? this.value(1)
                : this.conforming(properties[key]!, root, fuel - 1);
          }
        }
        return obj;
      }
    }
  }

  caseValue(root: RootSchema): unknown {
    const roll = this.rand();
    let result: unknown;
    if (roll < 0.45) {
      result = this.conforming(root, root, 5);
    } else {
      result = this.value(4);
    }
    if (this.rand() < 0.15 && (Array.isArray(result) || (typeof result === "object" && result !== null))) {
      this.shareOrCycle(result);
    }
    return result;
  }

  private containers(value: unknown, out: object[]): void {
    if (typeof value !== "object" || value === null || out.includes(value)) {
      return;
    }
    out.push(value);
    for (const child of Object.values(value)) {
      this.containers(child, out);
    }
  }

  private shareOrCycle(root: object): void {
    const all: object[] = [];
    this.containers(root, all);
    if (all.length === 0) {
      return;
    }
    const source = this.pick(all);
    // Descendants of `source` that can hold a new reference back to it.
    const descendants: object[] = [];
    this.containers(source, descendants);
    const targets = descendants.filter((item) => item !== source);
    if (this.rand() < 0.5 || targets.length === 0) {
      // Shared (DAG) reference, or a direct self-loop.
      const target = this.pick(all);
      if (Array.isArray(target)) {
        target.push(source);
      } else {
        (target as Record<string, unknown>)[this.pick(KEYS)] = source;
      }
      return;
    }
    // Guaranteed cycle: an existing slot of a descendant now points back to
    // one of its ancestors.
    const target = this.pick(targets);
    if (Array.isArray(target)) {
      target.push(source);
    } else {
      const keys = Object.keys(target);
      const key = keys.length > 0 ? this.pick(keys) : this.pick(KEYS);
      (target as Record<string, unknown>)[key] = source;
    }
  }

  listValue(maxDepth: number): Record<string, unknown> {
    const chain: Record<string, unknown>[] = [];
    const depth = 1 + this.int(maxDepth);
    let current: Record<string, unknown> = {};
    for (let i = 0; i < depth; i++) {
      current["value"] = this.rand() < 0.85 ? this.int(21) - 10 : "bad";
      chain.push(current);
      const next: Record<string, unknown> = {};
      if (i < depth - 1) {
        current["next"] = next;
      }
      current = next;
    }
    if (this.rand() < 0.4 && chain.length > 0) {
      // Close a cycle from a node back to one of its ancestors.
      const tail = this.pick(chain);
      tail["next"] = this.pick(chain);
    }
    return chain[0]!;
  }
}

const listSchema: RootSchema = {
  $ref: "#/definitions/node",
  definitions: {
    node: {
      type: "object",
      required: ["value"],
      properties: {
        value: { type: "integer" },
        next: { $ref: "#/definitions/node" },
      },
    },
  },
};

test("iterative validator matches the direct recursive model on random cases", () => {
  const gen = new RandomGen(mulberry32(0x5eed));
  const iterations = 1000;
  let ambiguous = 0;
  let cyclic = 0;
  let valid = 0;
  let schemaErrors = 0;
  for (let i = 0; i < iterations; i++) {
    const root = gen.rootSchema();
    const value = gen.caseValue(root);
    const run = (fn: () => unknown): { ok: unknown } | { thrown: string } => {
      try {
        return { ok: fn() };
      } catch (error) {
        return { thrown: String(error) };
      }
    };
    const actualResult = run(() => validate(root, value));
    const expectedResult = run(() => validateReference(root, value));
    deepEqual(
      actualResult,
      expectedResult,
      `case ${i} diverged: schema=${JSON.stringify(root)}`,
    );
    if ("thrown" in actualResult) {
      schemaErrors++;
      continue;
    }
    const actual = actualResult.ok as ReturnType<typeof validate>;
    deepEqual(actual, sortErrors(actual), `case ${i} errors not sorted`);
    for (let j = 1; j < actual.length; j++) {
      ok(
        comparePaths(actual[j - 1]!.path, actual[j]!.path) <= 0,
        `case ${i} path order violated at ${j}`,
      );
    }
    if (actual.length === 0) valid++;
    if (actual.some((e) => e.message.includes("ambiguous"))) ambiguous++;
    if (actual.some((e) => e.message.includes("circular"))) cyclic++;
  }
  ok(valid > 0, "expected some valid cases");
  ok(ambiguous > 0, "expected some ambiguous oneOf cases");
  ok(cyclic > 0, "expected some cyclic-value cases");
  console.log(
    `differential: ${iterations} cases, valid=${valid}, ambiguous=${ambiguous}, cyclic=${cyclic}, schemaErrors=${schemaErrors}`,
  );
});

test("recursive list schema with cyclic and acyclic data matches the model", () => {
  const gen = new RandomGen(mulberry32(0xc7c1e));
  const iterations = 500;
  let cyclic = 0;
  for (let i = 0; i < iterations; i++) {
    const value = gen.listValue(6);
    const actual = validate(listSchema, value);
    const expected = validateReference(listSchema, value);
    deepEqual(actual, expected, `list case ${i} diverged`);
    deepEqual(actual, sortErrors(actual), `list case ${i} errors not sorted`);
    if (actual.some((e) => e.message.includes("circular"))) cyclic++;
  }
  ok(cyclic > 0, "expected some cyclic list cases");
  console.log(`list differential: ${iterations} cases, cyclic=${cyclic}`);
});
