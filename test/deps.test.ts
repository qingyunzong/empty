import test from "node:test";
import assert from "node:assert/strict";
import { Monitor } from "../src/monitor.ts";
import { tickScan, assertSweepMatchesTicks } from "./tick-model.ts";

const FROM = -2;
const TO = 14;

function crossCheck(monitor: Monitor, ks: number[]): void {
  const records = tickScan(
    monitor.snapshotIntervals(),
    monitor.snapshotDeps(),
    monitor.knownServices(),
    FROM,
    TO,
  );
  for (const k of ks) {
    assertSweepMatchesTicks(monitor.getSegments(k), records, k);
  }
}

test("dependency chain: unavailable dependency suppresses dependents", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  monitor.addInterval("B", 0, 10);
  monitor.addInterval("C", 4, 6);
  monitor.addDependency("A", "B");
  monitor.addDependency("B", "C");
  assert.deepEqual(monitor.getSegments(1), [
    { start: 4, end: 6, services: ["A", "B", "C"] },
  ]);
  crossCheck(monitor, [1, 2, 3]);
});

test("cyclic dependency: component counts only when every member is online", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  monitor.addInterval("B", 3, 7);
  monitor.addDependency("A", "B");
  monitor.addDependency("B", "A");
  assert.deepEqual(monitor.getSegments(1), [{ start: 3, end: 7, services: ["A", "B"] }]);
  assert.deepEqual(monitor.getSegments(2), [{ start: 3, end: 7, services: ["A", "B"] }]);
  crossCheck(monitor, [1, 2]);
});

test("three-node cycle collapses entirely when one member is offline", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  monitor.addInterval("B", 0, 10);
  monitor.addInterval("C", 0, 4);
  monitor.addDependency("A", "B");
  monitor.addDependency("B", "C");
  monitor.addDependency("C", "A");
  assert.deepEqual(monitor.getSegments(1), [
    { start: 0, end: 4, services: ["A", "B", "C"] },
  ]);
  crossCheck(monitor, [1, 2, 3]);
});

test("cycle with external dependency requires both all members and the dependency", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  monitor.addInterval("B", 0, 10);
  monitor.addInterval("C", 2, 8);
  monitor.addDependency("A", "B");
  monitor.addDependency("B", "A");
  monitor.addDependency("B", "C");
  assert.deepEqual(monitor.getSegments(1), [
    { start: 2, end: 8, services: ["A", "B", "C"] },
  ]);
  monitor.removeDependency("B", "C");
  assert.deepEqual(monitor.getSegments(1), [
    { start: 0, end: 2, services: ["A", "B"] },
    { start: 2, end: 8, services: ["A", "B", "C"] },
    { start: 8, end: 10, services: ["A", "B"] },
  ]);
  crossCheck(monitor, [1, 2]);
});

test("self dependency behaves like plain online status", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 1, 5);
  monitor.addDependency("A", "A");
  assert.deepEqual(monitor.getSegments(1), [{ start: 1, end: 5, services: ["A"] }]);
  crossCheck(monitor, [1]);
});

test("dependency on unknown service is never satisfiable", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  monitor.addDependency("A", "ghost");
  assert.deepEqual(monitor.getSegments(1), []);
  monitor.addInterval("ghost", 2, 4);
  assert.deepEqual(monitor.getSegments(1), [
    { start: 2, end: 4, services: ["A", "ghost"] },
  ]);
  crossCheck(monitor, [1, 2]);
});

test("adding and removing dependencies and intervals stays in sync with tick model", () => {
  const monitor = new Monitor();
  const ids: number[] = [];
  ids.push(monitor.addInterval("A", 0, 6));
  ids.push(monitor.addInterval("B", 2, 9));
  ids.push(monitor.addInterval("C", 4, 12));
  monitor.addDependency("A", "C");
  monitor.addDependency("B", "A");
  crossCheck(monitor, [1, 2, 3]);
  monitor.addDependency("C", "B");
  crossCheck(monitor, [1, 2, 3]);
  monitor.removeDependency("A", "C");
  crossCheck(monitor, [1, 2, 3]);
  monitor.removeInterval(ids[0]!);
  crossCheck(monitor, [1, 2, 3]);
  monitor.removeInterval(ids[2]!);
  crossCheck(monitor, [1, 2, 3]);
  monitor.addInterval("D", 1, 11);
  monitor.addDependency("D", "D");
  monitor.addDependency("C", "D");
  crossCheck(monitor, [1, 2, 3, 4]);
});
