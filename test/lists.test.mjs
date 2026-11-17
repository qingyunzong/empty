import assert from "node:assert/strict";
import test from "node:test";
import {
  MergeError,
  applyPatch,
  threeWayMerge,
} from "../dist/index.js";
import {
  assertPatchContract,
  installApply,
} from "./helpers.mjs";

installApply(applyPatch);

test("atomic lists report one conflict at the list path", () => {
  const base = { spec: { args: ["--one", "--two"] } };
  const current = { spec: { args: ["--one", "--live"] } };
  const desired = { spec: { args: ["--one", "--desired"] } };

  const result = threeWayMerge(base, current, desired);
  assert.deepEqual(
    result.conflicts.map(({ path, kind }) => ({ path, kind })),
    [{ path: "/spec/args", kind: "modify" }],
  );
  assert.deepEqual(result.merged, { spec: { args: ["--one", "--live"] } });
  assertPatchContract(result, current);
});

test("set lists union concurrent additions and apply removals once", () => {
  const options = { lists: { "spec.tags": "set" } };
  const base = { spec: { tags: ["a", "b"] } };
  const current = { spec: { tags: ["a", "c", "c"] } };
  const desired = { spec: { tags: ["b", "d", "c"] } };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged, { spec: { tags: ["c", "d"] } });
  assertPatchContract(result, current);
});

test("set lists preserve concurrent additions that desired does not know", () => {
  const options = { listRules: [{ path: "/spec/regions", strategy: "set" }] };
  const base = { spec: { regions: ["cn"] } };
  const current = { spec: { regions: ["cn", "us"] } };
  const desired = { spec: { regions: ["cn"] } };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged, { spec: { regions: ["cn", "us"] } });
});

test("keyed lists merge nested fields and preserve unknown item fields", () => {
  const options = {
    lists: {
      "spec.containers": { strategy: "keyed", key: "name" },
      "spec.containers.env": { kind: "keyed", mergeKey: "name" },
    },
  };
  const base = {
    spec: {
      containers: [
        {
          name: "app",
          image: "v1",
          env: [{ name: "LOG", value: "info" }],
        },
        { name: "db", image: "pg1" },
      ],
    },
  };
  const current = {
    spec: {
      containers: [
        {
          name: "app",
          image: "v1",
          env: [{ name: "LOG", value: "info" }],
          runtimeField: "keep-me",
        },
        { name: "db", image: "pg1" },
        { name: "sidecar", image: "proxy:1" },
      ],
    },
  };
  const desired = {
    spec: {
      containers: [
        {
          name: "app",
          image: "v2",
          env: [{ name: "LOG", value: "debug" }],
        },
        { name: "db", image: "pg2" },
        { name: "web", image: "web:1" },
      ],
    },
  };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged, {
    spec: {
      containers: [
        {
          env: [{ name: "LOG", value: "debug" }],
          image: "v2",
          name: "app",
          runtimeField: "keep-me",
        },
        { image: "pg2", name: "db" },
        { image: "proxy:1", name: "sidecar" },
        { image: "web:1", name: "web" },
      ],
    },
  });
  assertPatchContract(result, current);
});

test("keyed add/add merges disjoint item fields", () => {
  const options = {
    lists: { "spec.services": { strategy: "keyed", key: "name" } },
  };
  const base = { spec: { services: [] } };
  const current = {
    spec: { services: [{ name: "api", port: 8080 }] },
  };
  const desired = {
    spec: { services: [{ name: "api", protocol: "http" }] },
  };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged, {
    spec: { services: [{ name: "api", port: 8080, protocol: "http" }] },
  });
});

test("keyed delete versus modify conflict uses a stable item path", () => {
  const options = {
    lists: { "spec.containers": { strategy: "keyed", key: "name" } },
  };
  const base = {
    spec: {
      containers: [
        { name: "app", image: "v1" },
        { name: "db", image: "pg1" },
      ],
    },
  };
  const current = {
    spec: {
      containers: [
        { name: "app", image: "v1" },
        { name: "db", image: "pg2" },
      ],
    },
  };
  const desired = {
    spec: { containers: [{ name: "app", image: "v2" }] },
  };

  const first = threeWayMerge(base, current, desired, options);
  const second = threeWayMerge(base, current, desired, options);
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].path, "/spec/containers/[name=db]");
  assert.equal(first.conflicts[0].kind, "modify-delete");
  assert.equal(second.conflicts[0].path, first.conflicts[0].path);
  assert.deepEqual(first.merged, {
    spec: {
      containers: [
        { name: "app", image: "v2" },
        { name: "db", image: "pg2" },
      ],
    },
  });
  assertPatchContract(first, current);
});

test("keyed conflicts inside an item include the item selector", () => {
  const options = {
    lists: { "spec.containers": { strategy: "keyed", keys: ["name"] } },
  };
  const base = {
    spec: { containers: [{ name: "web", image: "v1", replicas: 1 }] },
  };
  const current = {
    spec: { containers: [{ name: "web", image: "v2", replicas: 1 }] },
  };
  const desired = {
    spec: { containers: [{ name: "web", image: "v3", replicas: 1 }] },
  };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.conflicts[0].path, "/spec/containers/[name=web]/image");
  assert.deepEqual(result.conflicts[0].pathSegments, [
    "spec",
    "containers",
    "[name=web]",
    "image",
  ]);
});

test("supports composite keys and JSON Pointer rule paths", () => {
  const options = {
    listRules: [
      {
        path: "/spec/containers",
        strategy: "keyed",
        keys: ["metadata.name", "metadata.namespace"],
      },
    ],
  };
  const base = {
    spec: {
      containers: [
        {
          metadata: { name: "api", namespace: "prod" },
          image: "v1",
        },
      ],
    },
  };
  const current = {
    spec: {
      containers: [
        {
          metadata: { name: "api", namespace: "prod" },
          image: "v2",
        },
      ],
    },
  };
  const desired = {
    spec: {
      containers: [
        {
          metadata: { name: "api", namespace: "prod" },
          image: "v2",
          replicas: 3,
        },
      ],
    },
  };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged.spec.containers[0], {
    image: "v2",
    metadata: { name: "api", namespace: "prod" },
    replicas: 3,
  });
});

test("supports wildcard rule paths and a global default", () => {
  const options = {
    defaultListStrategy: "atomic",
    lists: { "spec.*.tags": "set" },
  };
  const base = {
    spec: {
      left: { tags: ["a"] },
      right: { tags: ["x"] },
    },
  };
  const current = {
    spec: {
      left: { tags: ["a", "b"] },
      right: { tags: ["x", "y"] },
    },
  };
  const desired = {
    spec: {
      left: { tags: ["a", "c"] },
      right: { tags: ["x", "z"] },
    },
  };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged, {
    spec: {
      left: { tags: ["a", "b", "c"] },
      right: { tags: ["x", "y", "z"] },
    },
  });
});

test("supports array markers in nested rule paths and mergeKeys maps", () => {
  const options = {
    mergeKeys: {
      "spec.containers": "name",
      "spec.containers[].env": "name",
    },
  };
  const base = {
    spec: {
      containers: [
        {
          name: "app",
          env: [{ name: "LOG", value: "info" }],
        },
      ],
    },
  };
  const current = {
    spec: {
      containers: [
        {
          name: "app",
          env: [{ name: "LOG", value: "info" }],
        },
      ],
    },
  };
  const desired = {
    spec: {
      containers: [
        {
          name: "app",
          env: [{ name: "LOG", value: "debug" }],
        },
      ],
    },
  };

  const result = threeWayMerge(base, current, desired, options);
  assert.equal(result.hasConflicts, false);
  assert.deepEqual(result.merged, {
    spec: {
      containers: [
        {
          name: "app",
          env: [{ name: "LOG", value: "debug" }],
        },
      ],
    },
  });
});

test("rejects duplicate or missing keyed identities", () => {
  const options = {
    lists: { "spec.items": { strategy: "keyed", key: "name" } },
  };
  assert.throws(
    () =>
      threeWayMerge(
        { spec: { items: [] } },
        { spec: { items: [{ name: "a" }, { name: "a" }] } },
        { spec: { items: [{ name: "b" }] } },
        options,
      ),
    (error) =>
      error instanceof MergeError &&
      error.message.includes("Duplicate merge key"),
  );
  assert.throws(
    () =>
      threeWayMerge(
        { spec: { items: [] } },
        { spec: { items: [{ image: "no-name" }] } },
        { spec: { items: [{ name: "b" }] } },
        options,
      ),
    (error) =>
      error instanceof MergeError &&
      error.message.includes("Missing merge key"),
  );
});
