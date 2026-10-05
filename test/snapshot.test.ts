import { test } from "node:test";
import * as assert from "node:assert";
import {
  computeOrder,
  fromSnapshot,
  initialState,
  publish,
  revise,
  toSnapshot,
} from "../src/state.js";
import { LogEvent } from "../src/types.js";

const ev = (id: string, ts: number, deps: string[] = [], source = "s", seq = 0): LogEvent => ({
  id,
  source,
  seq,
  ts,
  deps,
});

test("snapshot stores candidates and the missing-dependency index", () => {
  let state = initialState([
    ev("a", 1, ["m1"]), // withheld: missing dependency
    ev("b", 2),
    ev("c", 3, ["b"]),
  ]);
  state = publish(state, 1); // publishes b
  const snap = toSnapshot(state);
  assert.strictEqual(snap.version, 1);
  assert.deepStrictEqual(snap.published, ["b"]);
  assert.deepStrictEqual(snap.candidates, ["c"]);
  assert.deepStrictEqual(snap.missingIndex, { m1: ["a"] });
  assert.deepStrictEqual(
    snap.events.map((e) => e.id),
    ["a", "b", "c"]
  );
});

test("snapshot round-trip restores an equivalent state", () => {
  let state = initialState([
    ev("a", 1, ["m1"]),
    ev("b", 2),
    ev("c", 3, ["b"]),
    ev("d", 4, ["c", "a"]),
  ]);
  state = publish(state, 2);
  const restored = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state))));
  assert.deepStrictEqual(computeOrder(restored), computeOrder(state));
});

test("revision continues identically from a restored snapshot", () => {
  let state = initialState([ev("a", 1), ev("b", 2), ev("c", 3, ["a"])]);
  state = publish(state, 1);
  const restored = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state))));
  const batch = { events: [ev("z", 0, ["b"], "s", 9)], addDeps: [{ id: "c", dep: "b" }] };
  const r1 = revise(state, batch);
  const r2 = revise(restored, batch);
  assert.ok(r1.ok);
  assert.ok(r2.ok);
  assert.deepStrictEqual(r2.order, r1.order);
  assert.deepStrictEqual(toSnapshot(r2.state), toSnapshot(r1.state));
});

test("tampered snapshots are rejected on load", () => {
  let state = initialState([ev("a", 1, ["m1"]), ev("b", 2), ev("c", 3, ["b"])]);
  state = publish(state, 1);
  const snap = JSON.parse(JSON.stringify(toSnapshot(state))) as Record<string, unknown>;

  const badCandidates = { ...snap, candidates: [] };
  assert.throws(() => fromSnapshot(badCandidates), /candidates/);

  const badMissing = { ...snap, missingIndex: {} };
  assert.throws(() => fromSnapshot(badMissing), /missing-dependency index/);

  const badVersion = { ...snap, version: 2 };
  assert.throws(() => fromSnapshot(badVersion), /version/);

  const badPublished = { ...snap, published: ["nope"] };
  assert.throws(() => fromSnapshot(badPublished), /not in snapshot/);
});

test("snapshot with inconsistent published prefix is rejected on load", () => {
  const state = initialState([ev("a", 1), ev("b", 2, ["a"])]);
  const snap = JSON.parse(JSON.stringify(toSnapshot(state))) as {
    published: string[];
    candidates: string[];
  };
  // Forge an invalid prefix: b before its dependency a.
  snap.published = ["b", "a"];
  assert.throws(() => fromSnapshot(snap), /published prefix/);
});
