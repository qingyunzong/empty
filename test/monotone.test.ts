import { test } from "node:test";
import assert from "node:assert/strict";
import {
  E,
  NonMonotoneConditionError,
  SchemaError,
  compileSchema,
} from "../src/index";

test("not(filled(x)) is rejected as non-monotone", () => {
  assert.throws(
    () => compileSchema({ fields: [{ name: "a", when: E.not(E.filled("b")) }, { name: "b" }] }),
    (err: unknown) =>
      err instanceof NonMonotoneConditionError && /non-monotone/.test((err as Error).message),
  );
});

test("neq on a field is rejected as non-monotone", () => {
  assert.throws(
    () => compileSchema({ fields: [{ name: "a", when: E.neq("b", 1) }, { name: "b" }] }),
    NonMonotoneConditionError,
  );
});

test("not(value(x)) nested inside and/or is rejected", () => {
  assert.throws(
    () =>
      compileSchema({
        fields: [
          { name: "a", when: E.or(E.filled("b"), E.not(E.value("c"))) },
          { name: "b" },
          { name: "c" },
        ],
      }),
    NonMonotoneConditionError,
  );
});

test("not around visibility-independent expressions is allowed", () => {
  const schema = compileSchema({
    fields: [{ name: "a", when: E.and(E.not(E.const(false)), E.not(E.const(true))) }],
  });
  assert.equal(schema.fields.length, 1);
});

test("unknown field references are rejected", () => {
  assert.throws(
    () => compileSchema({ fields: [{ name: "a", when: E.filled("ghost") }] }),
    SchemaError,
  );
});

test("duplicate field names are rejected", () => {
  assert.throws(
    () => compileSchema({ fields: [{ name: "a" }, { name: "a" }] }),
    SchemaError,
  );
});
