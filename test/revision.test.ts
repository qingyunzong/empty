import test from "node:test";
import assert from "node:assert/strict";
import { LogEvent } from "../src/model.js";
import { LogStore } from "../src/store.js";

const ev = (id: string, ts: number, deps: string[] = []): LogEvent =>
  ({ id, source: "S", seq: Number(id.replace(/\D/g, "")) || 0, ts, deps });

function baseStore(): LogStore {
  // e1 < e2 (chain), e3 independent
  return new LogStore([ev("e1", 1), ev("e2", 2, ["e1"]), ev("e3", 3)]);
}

test("published prefix stays fixed; compatible revision reorders only unpublished region", () => {
  const s = baseStore();
  s.publish(2); // publish e1, e2
  const r = s.revise({ events: [ev("e0", 0)] }); // ts 0: would sort first, but prefix is fixed
  assert.equal(r.accepted, true);
  assert.deepEqual(s.publishedPrefix, ["e1", "e2"]);
  assert.deepEqual(s.order, ["e1", "e2", "e0", "e3"]); // e0 first among unpublished
});

test("new dep requiring prefix inversion is rejected with shortest conflict chain", () => {
  const s = baseStore();
  s.publish(2); // e1, e2 published
  const before = s.order;
  const r = s.revise({ deps: [{ id: "e1", dep: "e2" }] }); // e2 must precede e1: inversion
  assert.equal(r.accepted, false);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0]!.chain, ["e2", "e1"]);
  assert.match(r.conflicts[0]!.reason, /published at position 1/);
  assert.deepEqual(s.order, before); // atomic: state unchanged
});

test("conflict chain extends through intermediate unpublished events", () => {
  const s = new LogStore([ev("a", 1), ev("b", 2), ev("c", 3)]);
  s.publish(1); // publish a
  // new: b depends on c (unpublished, fine), a depends on b -> b must precede published a
  const r = s.revise({ deps: [{ id: "b", dep: "c" }, { id: "a", dep: "b" }] });
  assert.equal(r.accepted, false);
  assert.deepEqual(r.conflicts[0]!.chain, ["b", "a"]);
  // now with c published too, chain should reach the deepest offender
  const s2 = new LogStore([ev("a", 1), ev("b", 2), ev("c", 3)]);
  s2.publish(3); // a, b, c published
  const r2 = s2.revise({ deps: [{ id: "a", dep: "b" }, { id: "b", dep: "c" }] });
  assert.equal(r2.accepted, false);
  // shortest chain: b->a (len 2) preferred over c->b->a (len 3)
  assert.deepEqual(r2.conflicts[0]!.chain, ["b", "a"]);
});

test("new dep on unknown id required by published event is rejected", () => {
  const s = baseStore();
  s.publish(1);
  const r = s.revise({ deps: [{ id: "e1", dep: "ghost" }] });
  assert.equal(r.accepted, false);
  assert.deepEqual(r.conflicts[0]!.chain, ["ghost", "e1"]);
});

test("revision introducing a cycle in unpublished region is rejected with evidence", () => {
  const s = new LogStore([ev("a", 1), ev("b", 2, ["a"]), ev("c", 3, ["b"])]);
  const r = s.revise({ deps: [{ id: "a", dep: "c" }] });
  assert.equal(r.accepted, false);
  assert.equal(r.cycles.length, 1);
  assert.equal(s.unpublished.length, 3); // unchanged
});

test("deps on unpublished events are accepted and respected", () => {
  const s = baseStore();
  s.publish(1); // e1 published
  const r = s.revise({ deps: [{ id: "e2", dep: "e3" }] }); // e3 before e2 in unpublished region
  assert.equal(r.accepted, true);
  assert.deepEqual(s.order, ["e1", "e3", "e2"]);
});

test("batch publish commits prefix atomically with revision", () => {
  const s = baseStore();
  const r = s.revise({ events: [ev("e4", 4, ["e3"])], publish: 2 });
  assert.equal(r.accepted, true);
  assert.deepEqual(s.publishedPrefix, ["e1", "e2"]);
  assert.deepEqual(s.order, ["e1", "e2", "e3", "e4"]);
});
