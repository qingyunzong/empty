import { test } from "node:test";
import { deepEqual, equal, match, ok, throws } from "node:assert/strict";
import type { RootSchema } from "../src/schema.js";
import { encodePath } from "../src/schema.js";
import { validate } from "../src/validate.js";
import { validateReference } from "../src/reference.js";

const nodeSchema: RootSchema = {
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

test("integer accepted, non-integers rejected", () => {
  const schema: RootSchema = { type: "integer" };
  deepEqual(validate(schema, 42), []);
  deepEqual(validate(schema, -7), []);
  deepEqual(validate(schema, 1.5), [
    { path: [], message: "expected integer, got number" },
  ]);
  deepEqual(validate(schema, "1"), [
    { path: [], message: "expected integer, got string" },
  ]);
});

test("object required and nested property paths", () => {
  const schema: RootSchema = {
    type: "object",
    required: ["a"],
    properties: {
      a: { type: "integer" },
      nested: {
        type: "object",
        properties: { b: { type: "integer" } },
      },
    },
  };
  deepEqual(validate(schema, { a: 1, nested: { b: 2 } }), []);
  deepEqual(validate(schema, { nested: { b: "x" } }), [
    { path: [], message: 'missing required property "a"' },
    { path: ["nested", "b"], message: "expected integer, got string" },
  ]);
});

test("array element errors carry numeric index segments", () => {
  const schema: RootSchema = { type: "array", items: { type: "integer" } };
  deepEqual(validate(schema, [1, 2, 3]), []);
  deepEqual(validate(schema, [1, "x"]), [
    { path: [1], message: "expected integer, got string" },
  ]);
});

test("oneOf passes only when exactly one branch matches", () => {
  const schema: RootSchema = {
    type: "object",
    properties: {
      n: {
        oneOf: [
          { type: "integer" },
          { type: "array", items: { type: "integer" } },
        ],
      },
    },
  };
  deepEqual(validate(schema, { n: 5 }), []);
  deepEqual(validate(schema, { n: [1, 2] }), []);
  deepEqual(validate(schema, { n: "x" }), [
    { path: ["n"], message: "oneOf: no branch matched" },
  ]);
});

test("oneOf reports the ambiguity path when several branches match", () => {
  const schema: RootSchema = {
    type: "object",
    properties: {
      n: {
        oneOf: [
          { type: "integer" },
          { type: "integer" },
          { type: "array", items: { type: "integer" } },
        ],
      },
    },
  };
  const errors = validate(schema, { n: 3 });
  equal(errors.length, 1);
  deepEqual(errors[0]!.path, ["n"]);
  match(errors[0]!.message, /^oneOf: ambiguous, branches \[0, 1\] all matched$/);
});

test("recursive $ref schema validates recursive data", () => {
  deepEqual(validate(nodeSchema, { value: 1, next: { value: 2 } }), []);
  deepEqual(
    validate(nodeSchema, { value: 1, next: { next: { value: "x" } } }),
    [
      { path: ["next"], message: 'missing required property "value"' },
      { path: ["next", "next", "value"], message: "expected integer, got string" },
    ],
  );
});

test("cyclic data is rejected, shared DAG subvalues are allowed", () => {
  const cyclic: Record<string, unknown> = { value: 1 };
  cyclic["next"] = cyclic;
  deepEqual(validate(nodeSchema, cyclic), [
    { path: ["next"], message: "circular reference in value" },
  ]);

  const pairSchema: RootSchema = {
    type: "object",
    properties: {
      a: { $ref: "#/definitions/node" },
      b: { $ref: "#/definitions/node" },
    },
    definitions: nodeSchema.definitions,
  };
  const shared = { value: 9 };
  deepEqual(validate(pairSchema, { a: shared, b: shared }), []);
});

test("errors are sorted by path byte order, not numeric or locale order", () => {
  const schema: RootSchema = {
    type: "object",
    properties: {
      a: { type: "array", items: { type: "integer" } },
      b: { type: "integer" },
      z: { type: "integer" },
      "é": { type: "integer" },
    },
  };
  const value = {
    a: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    b: "x",
    z: "x",
    "é": "x",
  };
  const paths = validate(schema, value).map((error) => encodePath(error.path));
  deepEqual(paths, [
    "/a/0",
    "/a/1",
    "/a/10",
    "/a/11",
    "/a/2",
    "/a/3",
    "/a/4",
    "/a/5",
    "/a/6",
    "/a/7",
    "/a/8",
    "/a/9",
    "/b",
    "/z",
    "/é",
  ]);
});

test("unresolvable and circular $ref chains are schema errors", () => {
  throws(() => validate({ $ref: "#/definitions/missing" }, 1), /unresolvable \$ref/);
  const loop: RootSchema = {
    $ref: "#/definitions/a",
    definitions: {
      a: { $ref: "#/definitions/b" },
      b: { $ref: "#/definitions/a" },
    },
  };
  throws(() => validate(loop, 1), /circular \$ref chain/);
});

test("oneOf/$ref cycle at the same value is a schema error, not a hang", () => {
  const schema: RootSchema = {
    $ref: "#/definitions/d0",
    definitions: {
      d0: {
        oneOf: [{ type: "integer" }, { $ref: "#/definitions/d0" }],
      },
    },
  };
  throws(() => validate(schema, []), /non-productive recursive schema/);
  throws(() => validateReference(schema, []), /non-productive recursive schema/);
});

test("iterative validator handles 100k-deep nesting without stack overflow", () => {
  const depth = 100_000;
  const schema: RootSchema = {
    $ref: "#/definitions/nest",
    definitions: {
      nest: {
        oneOf: [{ type: "integer" }, { type: "array", items: { $ref: "#/definitions/nest" } }],
      },
    },
  };
  let value: unknown = 0;
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  deepEqual(validate(schema, value), []);

  // A failing leaf fails its own oneOf; the failure then fails the enclosing
  // oneOf branch, and so on, but branch internals stay inside the discarded
  // branch sinks: only the outermost oneOf reports, at the root path.
  // Shallow enough for the naive recursive reference model to cross-check.
  const badDepth = 200;
  let bad: unknown = "leaf";
  for (let i = 0; i < badDepth; i++) {
    bad = [bad];
  }
  const errors = validate(schema, bad);
  equal(errors.length, 1);
  deepEqual(errors[0]!.path, []);
  equal(errors[0]!.message, "oneOf: no branch matched");
  deepEqual(validateReference(schema, bad), errors);
});

test("reference model agrees on the fixed examples above", () => {
  deepEqual(validateReference(nodeSchema, { value: 1, next: { value: 2 } }), []);
  const cyclic: Record<string, unknown> = { value: 1 };
  cyclic["next"] = cyclic;
  deepEqual(validateReference(nodeSchema, cyclic), [
    { path: ["next"], message: "circular reference in value" },
  ]);
  ok(true);
});
