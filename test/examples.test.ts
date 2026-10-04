import { test } from "node:test";
import * as assert from "node:assert/strict";
import { runEventLoop } from "../src/simulator.ts";
import { allExamples } from "../src/examples.ts";

for (const example of allExamples) {
  test(`手写小例: ${example.name}`, () => {
    const result = runEventLoop(example.setup, { stepBudget: example.stepBudget });
    assert.equal(result.status, example.expectedStatus, "status");
    assert.deepEqual(result.trace, example.expectedTrace, "trace");
    if (example.expectedPending !== undefined) {
      assert.equal(result.status, "exhausted");
      if (result.status === "exhausted") {
        assert.deepEqual(result.pending, example.expectedPending, "pending");
      }
    }
  });
}
