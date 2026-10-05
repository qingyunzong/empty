import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ControllableExecutor,
  crossCheckStartSet,
  formatResults,
  planFullGraph,
  type TestCaseDef,
} from "../src/index.js";

// Representative scenario: a healthy pipeline, a failing stage whose
// downstream is cancelled (siblings survive), and a cycle whose SCC and
// downstream report are isolated.
const defs: TestCaseDef[] = [
  { id: "boot" },
  { id: "config" },
  { id: "lint" },
  { id: "db", dependsOn: ["boot"] },
  { id: "api", dependsOn: ["db", "config"] },
  { id: "ui", dependsOn: ["api"] },
  { id: "cycle-a", dependsOn: ["cycle-b"] },
  { id: "cycle-b", dependsOn: ["cycle-a"] },
  { id: "report", dependsOn: ["cycle-a"] },
];

const EXPECTED = [
  { id: "api", status: "cancelled" },
  { id: "boot", status: "passed" },
  { id: "config", status: "passed" },
  { id: "cycle-a", status: "isolated" },
  { id: "cycle-b", status: "isolated" },
  { id: "db", status: "failed", error: "db connection refused" },
  { id: "lint", status: "passed" },
  { id: "report", status: "isolated" },
  { id: "ui", status: "cancelled" },
];

test("representative run is recorded to results/actual-results.json", async () => {
  const agreement = crossCheckStartSet(defs);
  assert.deepEqual(agreement.executorStartSet, ["boot", "config", "lint"]);

  const executor = new ControllableExecutor(defs, {
    run: (id) => {
      if (id === "db") throw new Error("db connection refused");
    },
  });
  await executor.runAll();

  const results = executor.results();
  assert.deepEqual(results, EXPECTED);

  const record = {
    generatedAt: "deterministic-fixture",
    startSet: agreement.executorStartSet,
    isolated: planFullGraph(defs).isolated,
    cyclicSccs: planFullGraph(defs).cyclicSccs,
    results,
    stableText: formatResults(results),
  };

  // dist/test/ -> project root is two levels up.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const outDir = join(root, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "actual-results.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
});
