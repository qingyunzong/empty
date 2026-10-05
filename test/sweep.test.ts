import test from "node:test";
import assert from "node:assert/strict";
import { Monitor } from "../src/monitor.ts";

function build(entries: Array<[string, number, number]>): Monitor {
  const monitor = new Monitor();
  for (const [service, start, end] of entries) {
    monitor.addInterval(service, start, end);
  }
  return monitor;
}

test("half-open endpoints: touching intervals of different services do not overlap", () => {
  const monitor = build([
    ["A", 0, 3],
    ["B", 3, 6],
  ]);
  assert.deepEqual(monitor.getSegments(1), [
    { start: 0, end: 3, services: ["A"] },
    { start: 3, end: 6, services: ["B"] },
  ]);
  assert.deepEqual(monitor.getSegments(2), []);
});

test("same point: remove and add are applied together before judging", () => {
  const monitor = build([
    ["A", 0, 2],
    ["B", 2, 4],
    ["C", 1, 3],
  ]);
  assert.deepEqual(monitor.getSegments(2), [
    { start: 1, end: 2, services: ["A", "C"] },
    { start: 2, end: 3, services: ["B", "C"] },
  ]);
});

test("same point: same service ending and restarting merges into one maximal segment", () => {
  const monitor = build([
    ["A", 0, 2],
    ["A", 2, 5],
    ["B", 1, 4],
  ]);
  assert.deepEqual(monitor.getSegments(1), [
    { start: 0, end: 1, services: ["A"] },
    { start: 1, end: 4, services: ["A", "B"] },
    { start: 4, end: 5, services: ["A"] },
  ]);
  assert.deepEqual(monitor.getSegments(2), [{ start: 1, end: 4, services: ["A", "B"] }]);
});

test("overlapping intervals of one service are reference counted", () => {
  const monitor = build([
    ["A", 0, 10],
    ["A", 5, 15],
    ["B", 7, 9],
  ]);
  assert.deepEqual(monitor.getSegments(1), [
    { start: 0, end: 7, services: ["A"] },
    { start: 7, end: 9, services: ["A", "B"] },
    { start: 9, end: 15, services: ["A"] },
  ]);
  assert.deepEqual(monitor.getSegments(2), [{ start: 7, end: 9, services: ["A", "B"] }]);
});

test("supporting service set is reported per segment and sorted", () => {
  const monitor = build([
    ["svc-b", 0, 4],
    ["svc-a", 1, 3],
    ["svc-c", 2, 5],
  ]);
  assert.deepEqual(monitor.getSegments(3), [
    { start: 2, end: 3, services: ["svc-a", "svc-b", "svc-c"] },
  ]);
  assert.deepEqual(monitor.getSegments(2), [
    { start: 1, end: 2, services: ["svc-a", "svc-b"] },
    { start: 2, end: 3, services: ["svc-a", "svc-b", "svc-c"] },
    { start: 3, end: 4, services: ["svc-b", "svc-c"] },
  ]);
});

test("invalid k and invalid interval are rejected", () => {
  const monitor = new Monitor();
  assert.throws(() => monitor.getSegments(0), RangeError);
  assert.throws(() => monitor.addInterval("A", 5, 5), RangeError);
  assert.throws(() => monitor.addInterval("A", 6, 5), RangeError);
});

test("removing an interval splits segments exactly", () => {
  const monitor = build([
    ["A", 0, 10],
    ["B", 2, 8],
  ]);
  const id = monitor.addInterval("B", 8, 12);
  assert.deepEqual(monitor.getSegments(2), [{ start: 2, end: 10, services: ["A", "B"] }]);
  assert.deepEqual(monitor.getSegments(1), [
    { start: 0, end: 2, services: ["A"] },
    { start: 2, end: 10, services: ["A", "B"] },
    { start: 10, end: 12, services: ["B"] },
  ]);
  assert.ok(monitor.removeInterval(id));
  assert.deepEqual(monitor.getSegments(1), [
    { start: 0, end: 2, services: ["A"] },
    { start: 2, end: 8, services: ["A", "B"] },
    { start: 8, end: 10, services: ["A"] },
  ]);
  assert.ok(!monitor.removeInterval(id));
});
