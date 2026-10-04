import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness, displaySignature } from "../src/executor.js";

test("受控执行器交错删除最早事件、窗移动和快照，核对连续版本及来源", () => {
  for (const seed of [1, 7, 42, 2024]) {
    const harness = new Harness(seed);
    harness.run(400); // all invariants are asserted inside the harness
    assert.ok(harness.opCounts.upsert > 0, `seed ${seed}: upserts happened`);
    assert.ok(harness.opCounts.removeEarliest > 0, `seed ${seed}: earliest deletions happened`);
    assert.ok(harness.opCounts.moveWindow > 0, `seed ${seed}: window moves happened`);
    assert.ok(harness.opCounts.subscribe > 0, `seed ${seed}: snapshots happened`);
    assert.equal(
      harness.store.currentVersion,
      harness.opCounts.upsert + harness.opCounts.removeEarliest + harness.opCounts.moveWindow,
      "every mutating op commits exactly one version",
    );
  }
});

test("相同种子的执行完全确定", () => {
  const a = new Harness(99);
  const b = new Harness(99);
  a.run(300);
  b.run(300);
  assert.equal(a.store.currentVersion, b.store.currentVersion);
  assert.deepEqual(a.opCounts, b.opCounts);
  assert.deepEqual(
    displaySignature(a.store.displayedMap()),
    displaySignature(b.store.displayedMap()),
  );
});
