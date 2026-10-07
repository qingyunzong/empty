import test from "node:test";
import assert from "node:assert/strict";
import { findPath } from "../src/graph";
import type { Migration } from "../src/types";

function step(id: string, from: string, to: string): Migration {
  return { id, from, to, up: (c) => c, down: (c) => c };
}

test("prefers the path with fewer steps over a longer one", () => {
  const migrations = [
    step("001-a-to-b", "A", "B"),
    step("002-b-to-c", "B", "C"),
    step("003-a-to-c-direct", "A", "C"),
  ];
  const path = findPath(migrations, "A", "C");
  assert.deepEqual(path.map((m) => m.id), ["003-a-to-c-direct"]);
});

test("breaks step-count ties by migration id sequence", () => {
  const migrations = [
    step("900-first", "A", "B"),
    step("001-second", "B", "C"),
    step("100-first", "A", "D"),
    step("999-second", "D", "C"),
  ];
  // Both paths have 2 steps; ["100-first","999-second"] wins because
  // "100-first" < "900-first" at the first sequence position.
  const path = findPath(migrations, "A", "C");
  assert.deepEqual(path.map((m) => m.id), ["100-first", "999-second"]);
});

test("compares id sequences element by element, not by joined string", () => {
  const migrations = [
    step("010-a", "A", "B"),
    step("999-b", "B", "C"),
    step("020-a", "A", "D"),
    step("001-b", "D", "C"),
  ];
  // "010-a" < "020-a", so the first path wins even though "001-b" < "999-b".
  const path = findPath(migrations, "A", "C");
  assert.deepEqual(path.map((m) => m.id), ["010-a", "999-b"]);
});

test("result is independent of registration order", () => {
  const migrations = [
    step("002-b-to-c", "B", "C"),
    step("003-a-to-c-direct", "A", "C"),
    step("001-a-to-b", "A", "B"),
  ];
  const path = findPath(migrations, "A", "C");
  assert.deepEqual(path.map((m) => m.id), ["003-a-to-c-direct"]);
});

test("returns an empty path when already at the target", () => {
  assert.deepEqual(findPath([], "A", "A"), []);
});

test("throws when no path exists", () => {
  const migrations = [step("001-a-to-b", "A", "B")];
  assert.throws(() => findPath(migrations, "B", "C"), /no migration path/);
});
