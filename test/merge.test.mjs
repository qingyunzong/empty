import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatch,
  merge3,
  threeWayMerge,
} from "../dist/index.js";
import {
  assertPatchContract,
  clone,
  deepFreeze,
  installApply,
} from "./helpers.mjs";

installApply(applyPatch);

test("merges disjoint field ownership and preserves unknown fields", () => {
  const base = {
    metadata: { name: "api", labels: { team: "core" } },
    spec: { image: "v1", replicas: 2 },
  };
  const current = {
    metadata: { name: "api", labels: { team: "core", live: "yes" } },
    spec: { image: "v1", replicas: 3 },
    status: { ready: true, runtime: "unknown-to-schema" },
  };
  const desired = {
    metadata: { name: "api", labels: { team: "platform" } },
    spec: { image: "v2", replicas: 2 },
  };

  const result = threeWayMerge(base, current, desired);

  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.merged, {
    metadata: {
      name: "api",
      labels: { live: "yes", team: "platform" },
    },
    spec: { image: "v2", replicas: 3 },
    status: { ready: true, runtime: "unknown-to-schema" },
  });
  assertPatchContract(result, current);
});

test("does not mutate frozen inputs", () => {
  const base = deepFreeze({ spec: { image: "v1", replicas: 1 } });
  const current = deepFreeze({ spec: { image: "v1", replicas: 2 } });
  const desired = deepFreeze({ spec: { image: "v2", replicas: 1 } });

  const result = merge3(base, current, desired);
  assert.deepEqual(result.merged, {
    spec: { image: "v2", replicas: 2 },
  });
  assert.deepEqual(base, { spec: { image: "v1", replicas: 1 } });
  assert.deepEqual(current, { spec: { image: "v1", replicas: 2 } });
  assert.deepEqual(desired, { spec: { image: "v2", replicas: 1 } });
});

test("reports a stable path for concurrent updates and keeps live value", () => {
  const base = { spec: { replicas: 2, image: "v1" } };
  const current = { spec: { replicas: 3, image: "v1" } };
  const desired = { spec: { replicas: 4, image: "v2" } };

  const first = threeWayMerge(base, current, desired);
  const second = threeWayMerge(base, current, desired);

  assert.equal(first.hasConflicts, true);
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].path, "/spec/replicas");
  assert.deepEqual(first.conflicts[0].pathSegments, ["spec", "replicas"]);
  assert.equal(first.conflicts[0].kind, "modify");
  assert.equal(first.conflicts[0].winner, "current");
  assert.deepEqual(first.conflicts[0].resolved, { present: true, value: 3 });
  assert.deepEqual(first.merged, { spec: { image: "v2", replicas: 3 } });
  assert.equal(second.conflicts[0].path, first.conflicts[0].path);
  assertPatchContract(first, current);
});

test("detects delete versus modify in both directions", () => {
  const base = {
    spec: { legacy: { enabled: true }, port: 80 },
  };
  const current = {
    spec: { port: 8080 },
  };
  const desired = {
    spec: { legacy: { enabled: false } },
  };

  const result = threeWayMerge(base, current, desired, {
    conflictResolution: "current",
  });
  assert.deepEqual(
    result.conflicts.map(({ path, kind }) => ({ path, kind })),
    [
      { path: "/spec/legacy", kind: "delete-modify" },
      { path: "/spec/port", kind: "modify-delete" },
    ],
  );
  assert.deepEqual(result.merged, { spec: { port: 8080 } });
  assertPatchContract(result, current);
});

test("accepts a concurrent deletion when the desired value is unchanged", () => {
  const base = { spec: { image: "v1", obsolete: true } };
  const current = { spec: { image: "v1" } };
  const desired = { spec: { image: "v2", obsolete: true } };

  const result = threeWayMerge(base, current, desired);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged, { spec: { image: "v2" } });
});

test("treats null as a value, not a deletion marker", () => {
  const base = { spec: { value: "set" } };
  const current = { spec: { value: "set" } };
  const desired = { spec: { value: null } };

  const result = threeWayMerge(base, current, desired);
  assert.deepEqual(result.merged, { spec: { value: null } });
  assertPatchContract(result, current);
});

test("add/add conflicts are reported while disjoint additions merge", () => {
  const base = { spec: {} };
  const current = { spec: { owner: "alpha", tier: "gold" } };
  const desired = { spec: { owner: "beta", region: "cn" } };

  const result = threeWayMerge(base, current, desired);
  assert.deepEqual(
    result.conflicts.map(({ path, kind }) => ({ path, kind })),
    [{ path: "/spec/owner", kind: "add" }],
  );
  assert.deepEqual(result.merged, {
    spec: { owner: "alpha", region: "cn", tier: "gold" },
  });
  assertPatchContract(result, current);
});

test("conflict resolution can explicitly prefer desired", () => {
  const base = { spec: { replicas: 2 } };
  const current = { spec: { replicas: 3 } };
  const desired = { spec: { replicas: 4 } };

  const result = threeWayMerge(base, current, desired, {
    conflictResolution: "desired",
  });
  assert.equal(result.conflicts[0].winner, "desired");
  assert.deepEqual(result.conflicts[0].resolved, {
    present: true,
    value: 4,
  });
  assert.deepEqual(result.merged, { spec: { replicas: 4 } });
  assertPatchContract(result, current);
});

test("empty merges still return a usable idempotent patch", () => {
  const document = { a: 1 };
  const result = threeWayMerge(document, clone(document), clone(document));
  assert.deepEqual(result.merged, document);
  assert.deepEqual(applyPatch(document, result.patch), document);
  assert.deepEqual(applyPatch(applyPatch(document, result.patch), result.patch), document);
});

test("handles prototype-looking keys without polluting prototypes", () => {
  const base = JSON.parse('{"spec":{"__proto__":{"safe":true}}}');
  const current = JSON.parse(
    '{"spec":{"__proto__":{"safe":true},"runtime":"x"}}',
  );
  const desired = JSON.parse('{"spec":{"__proto__":{"safe":false}}}');

  const result = threeWayMerge(base, current, desired);
  assert.equal({}.safe, undefined);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result.merged.spec.__proto__, { safe: false });
  assert.ok(Object.hasOwn(result.merged.spec, "__proto__"));
  assertPatchContract(result, current);
});
