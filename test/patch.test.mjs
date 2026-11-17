import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatch,
  createPatch,
  threeWayMerge,
} from "../dist/index.js";

test("patch application is idempotent for nested objects and arrays", () => {
  const current = {
    a: { keep: true, change: 1, remove: "x" },
    list: [{ id: 1, value: "a" }],
  };
  const target = {
    a: { keep: true, change: 2 },
    list: [{ id: 1, value: "b" }],
  };
  const patch = createPatch(current, target);

  const once = applyPatch(current, patch);
  const twice = applyPatch(once, patch);
  assert.deepEqual(once, target);
  assert.deepEqual(twice, target);
  assert.deepEqual(current.a.remove, "x");
});

test("patch removes keys and can merge into a non-object root", () => {
  const remove = createPatch({ a: 1, b: 2 }, { a: 1 });
  assert.deepEqual(applyPatch({ a: 1, b: 2 }, remove), { a: 1 });
  assert.deepEqual(applyPatch({ a: 1 }, remove), { a: 1 });
  const replace = createPatch(3, { a: 1 });
  assert.deepEqual(applyPatch(3, replace), { a: 1 });
  assert.deepEqual(applyPatch({ a: 1 }, replace), { a: 1 });
});

test("patches do not mutate their payload or target", () => {
  const value = { nested: { list: [1, 2] } };
  const patch = { op: "merge", fields: { added: { op: "replace", value } } };
  const document = { existing: true };
  const result = applyPatch(document, patch);

  assert.deepEqual(result, { added: { nested: { list: [1, 2] } }, existing: true });
  result.added.nested.list.push(3);
  assert.deepEqual(value, { nested: { list: [1, 2] } });
  assert.deepEqual(document, { existing: true });
});

test("conflict path ordering is stable across key insertion order", () => {
  const baseA = {
    spec: { zeta: 1, alpha: 1 },
    metadata: { name: "a" },
  };
  const baseB = {
    metadata: { name: "a" },
    spec: { alpha: 1, zeta: 1 },
  };
  const currentA = {
    spec: { zeta: 2, alpha: 2 },
    metadata: { name: "a" },
  };
  const currentB = {
    metadata: { name: "a" },
    spec: { alpha: 2, zeta: 2 },
  };
  const desiredA = {
    spec: { zeta: 3, alpha: 3 },
    metadata: { name: "a" },
  };
  const desiredB = {
    metadata: { name: "a" },
    spec: { alpha: 3, zeta: 3 },
  };

  const first = threeWayMerge(baseA, currentA, desiredA);
  const second = threeWayMerge(baseB, currentB, desiredB);
  assert.deepEqual(
    first.conflicts.map((conflict) => conflict.path),
    ["/spec/alpha", "/spec/zeta"],
  );
  assert.deepEqual(
    second.conflicts.map((conflict) => conflict.path),
    first.conflicts.map((conflict) => conflict.path),
  );
});

test("keyed conflict paths are independent of container ordering", () => {
  const options = {
    lists: { "spec.containers": { strategy: "keyed", key: "name" } },
  };
  const base = {
    spec: {
      containers: [
        { name: "a", image: "a1" },
        { name: "b", image: "b1" },
      ],
    },
  };
  const current = {
    spec: {
      containers: [
        { name: "b", image: "b2" },
        { name: "a", image: "a1" },
      ],
    },
  };
  const desired = {
    spec: {
      containers: [
        { name: "a", image: "a1" },
        { name: "b", image: "b3" },
      ],
    },
  };
  const reordered = {
    spec: {
      containers: [
        { name: "b", image: "b3" },
        { name: "a", image: "a1" },
      ],
    },
  };

  const first = threeWayMerge(base, current, desired, options);
  const second = threeWayMerge(base, current, reordered, options);
  assert.equal(first.conflicts[0].path, "/spec/containers/[name=b]/image");
  assert.equal(second.conflicts[0].path, first.conflicts[0].path);
});
