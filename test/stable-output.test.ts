import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ControllableExecutor,
  formatResults,
  type TestCaseDef,
} from "../src/index.js";

const defs: TestCaseDef[] = [
  { id: "case-10" },
  { id: "case-2", dependsOn: ["case-10"] },
  { id: "case-1" },
  { id: "case-20", dependsOn: ["case-1"] },
];

test("results are sorted by case id regardless of execution order", async () => {
  const executor = new ControllableExecutor(defs);
  await executor.runAll();
  const ids = executor.results().map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(ids, ["case-1", "case-10", "case-2", "case-20"]);
});

test("output is stable across runs and definition order permutations", async () => {
  const run = async (input: TestCaseDef[]): Promise<string> => {
    const executor = new ControllableExecutor(input);
    await executor.runAll();
    return formatResults(executor.results());
  };
  const baseline = await run(defs);
  const reversed = await run([...defs].reverse());
  const shuffled = await run([defs[2]!, defs[0]!, defs[3]!, defs[1]!]);
  assert.equal(baseline, reversed);
  assert.equal(baseline, shuffled);
  assert.equal(
    baseline,
    [
      "case-1\tpassed",
      "case-10\tpassed",
      "case-2\tpassed",
      "case-20\tpassed",
    ].join("\n"),
  );
});
