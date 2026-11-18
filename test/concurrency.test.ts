import test from "node:test";
import assert from "node:assert/strict";
import {
  ConversionError,
  ResourceConverter,
  canonicalStringify,
  cloneJson,
  type ConversionTable,
  type ResourceObject,
} from "../index.ts";
import {
  SMALL_ALPHA,
  SMALL_BETA,
  SMALL_HUB,
  SMALL_RETENTION_KEY,
  SMALL_TABLE,
} from "./fixtures.ts";

const TABLE_A: ConversionTable = SMALL_TABLE;

const TABLE_B: ConversionTable = {
  hubVersion: SMALL_HUB,
  retention: { annotationKey: SMALL_RETENTION_KEY },
  versions: [
    {
      version: SMALL_HUB,
      fields: ["spec.a", "spec.b", "spec.c", "spec.d"],
      defaults: [
        { path: "spec.a", value: 2 },
        { path: "spec.b", value: "hub-b-v2" },
      ],
    },
    {
      version: SMALL_ALPHA,
      fields: ["spec.a", "spec.oldB", "spec.d"],
      toHub: [{ from: "spec.oldB", to: "spec.b" }],
      defaults: [{ path: "spec.oldB", value: 9 }],
    },
    {
      version: SMALL_BETA,
      fields: ["spec.b", "spec.c", "spec.renamedD"],
      toHub: [{ from: "spec.renamedD", to: "spec.d" }],
      defaults: [{ path: "spec.b", value: "beta-b-v2" }],
    },
  ],
};

const INPUT: ResourceObject = {
  apiVersion: SMALL_ALPHA,
  kind: "Thing",
  metadata: { name: "hot-swap" },
  spec: {
    a: 0,
    oldB: "",
    d: [0, 1],
  },
};

function expected(table: ConversionTable): string {
  return canonicalStringify(
    new ResourceConverter(table).convert(INPUT, SMALL_BETA),
  );
}

test("an in-flight asynchronous conversion keeps the snapshot it started with", async () => {
  const converter = new ResourceConverter(TABLE_A);
  const expectedA = expected(TABLE_A);
  let observedSnapshot = -1;

  const result = await converter.convertAsync(INPUT, SMALL_BETA, {
    betweenStages: async (context) => {
      observedSnapshot = context.snapshotId;
      assert.equal(context.sourceVersion, SMALL_ALPHA);
      assert.equal(context.targetVersion, SMALL_BETA);
      converter.replaceTable(TABLE_B);
      await Promise.resolve();
      converter.replaceTable(TABLE_A);
      await Promise.resolve();
    },
  });

  assert.equal(observedSnapshot, 1);
  assert.equal(canonicalStringify(result), expectedA);
  assert.equal(converter.snapshotId, 3);
});

test("interleaved requests never observe a partially updated table", async () => {
  const converter = new ResourceConverter(TABLE_A);
  const expectedA = expected(TABLE_A);
  const expectedB = expected(TABLE_B);
  const tasks: Promise<ResourceObject>[] = [];

  for (let index = 0; index < 240; index += 1) {
    tasks.push(
      converter.convertAsync(INPUT, SMALL_BETA, {
        betweenStages: async () => {
          await Promise.resolve();
          await Promise.resolve();
        },
      }),
    );
    if (index % 2 === 0) {
      converter.replaceTable(index % 4 === 0 ? TABLE_B : TABLE_A);
    }
  }

  const results = await Promise.all(tasks);
  let sawA = 0;
  let sawB = 0;
  for (const result of results) {
    const encoded = canonicalStringify(result);
    if (encoded === expectedA) {
      sawA += 1;
    } else if (encoded === expectedB) {
      sawB += 1;
    } else {
      assert.fail(
        `result mixed table revisions or was partially updated:\n${encoded}`,
      );
    }
  }
  assert.ok(sawA > 0, "expected requests using table A");
  assert.ok(sawB > 0, "expected requests using table B");
});

test("mutating the source table after publication does not change the snapshot", () => {
  const mutable = structuredClone(TABLE_A) as unknown as {
    versions: Array<{
      fields: string[];
      toHub?: Array<{ from: string; to: string }>;
      defaults?: Array<{ path: string; value: unknown }>;
    }>;
  };
  const converter = new ResourceConverter(mutable as unknown as ConversionTable);
  const expectedA = expected(TABLE_A);

  mutable.versions[1]!.fields[2] = "spec.changed";
  mutable.versions[1]!.defaults![0]!.value = 999;
  mutable.versions[2]!.fields[2] = "spec.changedD";
  mutable.versions[2]!.toHub![0]!.to = "spec.c";

  assert.equal(
    canonicalStringify(converter.convert(INPUT, SMALL_BETA)),
    expectedA,
  );
});

test("a failed hot replacement leaves the previous table active", () => {
  const converter = new ResourceConverter(TABLE_A);
  const expectedA = expected(TABLE_A);
  const before = converter.snapshotId;

  assert.throws(
    () =>
      converter.replaceTable({
        hubVersion: SMALL_HUB,
        versions: [
          {
            version: SMALL_HUB,
            fields: ["spec.a"],
          },
          {
            version: SMALL_ALPHA,
            fields: ["spec.foo"],
            toHub: [{ from: "spec.foo", to: "spec.missing" }],
          },
        ],
      }),
    (error: unknown) =>
      error instanceof ConversionError && error.code === "invalid_mapping",
  );

  assert.equal(converter.snapshotId, before);
  assert.equal(
    canonicalStringify(converter.convert(INPUT, SMALL_BETA)),
    expectedA,
  );
});

test("hot replacement does not mutate or freeze caller-owned tables", () => {
  const table = structuredClone(TABLE_A) as ConversionTable;
  const converter = new ResourceConverter(table);
  converter.replaceTable(structuredClone(TABLE_B) as ConversionTable);

  const versions = table.versions as unknown as Array<{
    fields: string[];
    defaults?: Array<{ value: unknown }>;
  }>;
  versions[1]!.fields.push("spec.extra");
  versions[1]!.defaults![0]!.value = 123;
  assert.doesNotThrow(() => cloneJson(table));
});
