import test from "node:test";
import assert from "node:assert/strict";
import { mergeManifests } from "../src/index.js";
import type { Artifact } from "../src/index.js";

const art = (id: string, path: string, digest: string): Artifact => ({ id, path, digest });

test("rule: deleted on both sides -> absent, remove op keeps previous entry", () => {
  const a = art("A", "/a", "d1");
  const { merged, conflicts, plan } = mergeManifests([a], [], []);
  assert.deepEqual(merged, []);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "remove", id: "A", previous: a }]);
});

test("rule: deleted on one side, untouched on the other -> deletion wins", () => {
  const a = art("A", "/a", "d1");
  const { merged, conflicts, plan } = mergeManifests([a], [a], []);
  assert.deepEqual(merged, []);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "remove", id: "A", previous: a }]);
});

test("rule: deleted on one side, modified on the other -> delete-modify conflict", () => {
  const a = art("A", "/a", "d1");
  const o = art("A", "/a", "d2");
  const { merged, conflicts, plan } = mergeManifests([a], [o], []);
  assert.deepEqual(merged, []);
  assert.deepEqual(plan, []);
  assert.deepEqual(conflicts, [
    { type: "delete-modify", id: "A", ancestor: a, changed: o, changedSide: "ours" },
  ]);
});

test("rule: added on ours only -> added", () => {
  const o = art("A", "/a", "d1");
  const { merged, conflicts, plan } = mergeManifests([], [o], []);
  assert.deepEqual(merged, [o]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "add", artifact: o }]);
});

test("rule: added on theirs only -> added", () => {
  const t = art("A", "/a", "d1");
  const { merged, conflicts, plan } = mergeManifests([], [], [t]);
  assert.deepEqual(merged, [t]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "add", artifact: t }]);
});

test("rule: identical add on both sides -> single add", () => {
  const a = art("A", "/a", "d1");
  const { merged, conflicts, plan } = mergeManifests([], [a], [a]);
  assert.deepEqual(merged, [a]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "add", artifact: a }]);
});

test("rule: divergent add of same id -> add-add conflict", () => {
  const o = art("A", "/a", "d1");
  const t = art("A", "/b", "d2");
  const { merged, conflicts, plan } = mergeManifests([], [o], [t]);
  assert.deepEqual(merged, []);
  assert.deepEqual(plan, []);
  assert.deepEqual(conflicts, [{ type: "add-add", id: "A", ours: o, theirs: t }]);
});

test("rule: untouched everywhere -> kept, empty plan", () => {
  const a = art("A", "/a", "d1");
  const { merged, conflicts, plan } = mergeManifests([a], [a], [a]);
  assert.deepEqual(merged, [a]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, []);
});

test("rule: path move recognized by object id (ours moved) -> move op", () => {
  const a = art("A", "/old", "d1");
  const o = art("A", "/new", "d1");
  const { merged, conflicts, plan } = mergeManifests([a], [o], [a]);
  assert.deepEqual(merged, [o]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "move", id: "A", from: "/old", to: "/new" }]);
});

test("rule: digest change on theirs only -> update op", () => {
  const a = art("A", "/a", "d1");
  const t = art("A", "/a", "d2");
  const { merged, conflicts, plan } = mergeManifests([a], [a], [t]);
  assert.deepEqual(merged, [t]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "update", id: "A", from: a, to: t }]);
});

test("rule: both sides changed to identical content -> merges, single op", () => {
  const a = art("A", "/old", "d1");
  const n = art("A", "/new", "d2");
  const { merged, conflicts, plan } = mergeManifests([a], [n], [n]);
  assert.deepEqual(merged, [n]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [{ op: "update", id: "A", from: a, to: n }]);
});

test("rule: both sides changed to different digests -> digest conflict", () => {
  const a = art("A", "/a", "d1");
  const o = art("A", "/a", "d2");
  const t = art("A", "/a", "d3");
  const { merged, conflicts, plan } = mergeManifests([a], [o], [t]);
  assert.deepEqual(merged, []);
  assert.deepEqual(plan, []);
  assert.deepEqual(conflicts, [{ type: "digest", id: "A", ancestor: a, ours: o, theirs: t }]);
});

test("rule: same digest both sides but moved to different paths -> move-move conflict", () => {
  const a = art("A", "/a", "d1");
  const o = art("A", "/x", "d1");
  const t = art("A", "/y", "d1");
  const { merged, conflicts, plan } = mergeManifests([a], [o], [t]);
  assert.deepEqual(merged, []);
  assert.deepEqual(plan, []);
  assert.deepEqual(conflicts, [{ type: "move-move", id: "A", ancestor: a, ours: o, theirs: t }]);
});

test("rule: two ids moved to the same path -> path-collision, no auto-overwrite", () => {
  const a1 = art("A", "/a", "d1");
  const a2 = art("B", "/b", "d2");
  const o1 = art("A", "/shared", "d1"); // ours moves A
  const t2 = art("B", "/shared", "d2"); // theirs moves B
  const { merged, conflicts, plan } = mergeManifests(
    [a1, a2],
    [o1, a2],
    [a1, t2],
  );
  assert.deepEqual(merged, []);
  assert.deepEqual(plan, []);
  assert.equal(conflicts.length, 1);
  const conflict = conflicts[0]!;
  if (conflict.type !== "path-collision") {
    assert.fail(`expected path-collision, got ${conflict.type}`);
  }
  assert.equal(conflict.path, "/shared");
  assert.deepEqual(conflict.ids, ["A", "B"]);
});

test("rule: added id colliding with kept id's path -> path-collision", () => {
  const a = art("A", "/x", "d1");
  const t = art("B", "/x", "d2"); // theirs adds B at A's path
  const { merged, conflicts, plan } = mergeManifests([a], [a], [a, t]);
  assert.deepEqual(merged, []);
  assert.deepEqual(plan, []);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.type, "path-collision");
});

test("rule: duplicate id within one manifest is rejected", () => {
  const a = art("A", "/a", "d1");
  assert.throws(() => mergeManifests([a, a], [], []), /duplicate artifact id/);
});

test("scenario: mixed independent ids merge in one pass", () => {
  const keep = art("K", "/keep", "dk");
  const gone = art("G", "/gone", "dg");
  const movedBase = art("M", "/old", "dm");
  const moved = art("M", "/new", "dm");
  const added = art("N", "/added", "dn");
  const { merged, conflicts, plan } = mergeManifests(
    [keep, gone, movedBase],
    [keep, moved],
    [keep, movedBase, added],
  );
  assert.deepEqual(merged, [keep, moved, added]);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(plan, [
    { op: "remove", id: "G", previous: gone },
    { op: "move", id: "M", from: "/old", to: "/new" },
    { op: "add", artifact: added },
  ]);
});
