import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Editor, vec } from "../src/index";

const squareA = [vec(0, 0), vec(10, 0), vec(10, 10), vec(0, 10)];

test("snaps to the nearest wire within threshold and records one undo step", () => {
  const ed = new Editor(3);
  ed.addShape({ id: "A", vertices: [vec(2, -5), vec(8, -5), vec(5, -1)] });
  ed.addShape({ id: "B", vertices: [vec(0, 0), vec(10, 0), vec(10, 6), vec(0, 6)] });

  const result = ed.dragVertex("A", 2, vec(5, -2));
  assert.ok(result.applied);
  assert.equal(result.wireId, "B:e0");
  assert.deepEqual(result.snappedTo, vec(5, 0));
  assert.deepEqual(ed.getVertices("A"), [vec(2, -5), vec(8, -5), vec(5, 0)]);
  assert.equal(result.attempts.length, 1);
  assert.ok(result.attempts[0].accepted);

  assert.ok(ed.canUndo());
  ed.undo();
  assert.deepEqual(ed.getVertices("A"), [vec(2, -5), vec(8, -5), vec(5, -1)]);
  assert.ok(!ed.canUndo());
});

test("equal distances tie-break by ascending wire id", () => {
  const ed = new Editor(4);
  ed.addShape({ id: "A", vertices: [vec(2, -5), vec(8, -5), vec(5, -1)] });
  ed.addShape({ id: "B", vertices: [vec(0, 0), vec(10, 0), vec(10, 6), vec(0, 6)] });

  // target (5,3): B:e0 (y=0) and B:e2 (y=6) are both at squared distance 9
  const result = ed.dragVertex("A", 2, vec(5, 3));
  assert.ok(result.applied);
  assert.equal(result.attempts[0].distanceSquared, 9);
  assert.equal(result.wireId, "B:e0");
  assert.deepEqual(result.snappedTo, vec(5, 0));
});

test("rejects when no wire is within threshold, leaving state untouched", () => {
  const ed = new Editor(2);
  ed.addShape({ id: "A", vertices: [vec(2, -5), vec(8, -5), vec(5, -1)] });
  ed.addShape({ id: "B", vertices: [vec(0, 0), vec(10, 0), vec(10, 6), vec(0, 6)] });

  const result = ed.dragVertex("A", 2, vec(5, -3));
  assert.ok(!result.applied);
  assert.equal(result.attempts.length, 0);
  assert.ok(result.reasons.some((r) => r.includes("no candidate wire within threshold")));
  assert.deepEqual(ed.getVertices("A"), [vec(2, -5), vec(8, -5), vec(5, -1)]);
  assert.ok(!ed.canUndo());
});

test("rejects non-integer targets and unknown shapes with reasons", () => {
  const ed = new Editor(5);
  ed.addShape({ id: "A", vertices: squareA });

  const bad = ed.dragVertex("A", 0, vec(1.5, 2));
  assert.ok(!bad.applied);
  assert.ok(bad.reasons.some((r) => r.includes("integer coordinates")));

  const missing = ed.dragVertex("ZZ", 0, vec(1, 2));
  assert.ok(!missing.applied);
  assert.ok(missing.reasons.some((r) => r.includes("shape not found")));

  const oob = ed.dragVertex("A", 9, vec(1, 2));
  assert.ok(!oob.applied);
  assert.ok(oob.reasons.some((r) => r.includes("out of range")));
});

test("self-intersecting snap is skipped in favor of the next legal candidate", () => {
  const ed = new Editor(7);
  ed.addShape({ id: "A", vertices: squareA });
  // B:e0 at y=12 (d^2=1), B:e1 x=10 (d^2=25), B:e3 x=0 (d^2=25), B:e2 y=5 (d^2=36)
  ed.addShape({ id: "B", vertices: [vec(0, 12), vec(10, 12), vec(10, 5), vec(0, 5)] });

  const result = ed.dragVertex("A", 1, vec(5, 11));
  assert.ok(result.applied);
  assert.equal(result.wireId, "B:e2");
  assert.deepEqual(result.snappedTo, vec(5, 5));

  // finite candidates were verified one by one, in sorted order
  assert.deepEqual(
    result.attempts.map((a) => a.wireId),
    ["B:e0", "B:e1", "B:e3", "B:e2"],
  );
  assert.deepEqual(
    result.attempts.map((a) => a.distanceSquared),
    [1, 25, 25, 36],
  );
  assert.deepEqual(result.attempts[0].snap, vec(5, 12));
  assert.ok(!result.attempts[0].accepted);
  assert.ok(result.attempts[0].reason!.includes("self-intersection"));
  assert.ok(!result.attempts[1].accepted);
  assert.ok(!result.attempts[2].accepted);
  assert.ok(result.attempts[3].accepted);
  assert.equal(result.reasons.length, 3);
});

test("drag is rejected when every candidate self-intersects", () => {
  const ed = new Editor(2);
  ed.addShape({ id: "A", vertices: squareA });
  ed.addShape({ id: "B", vertices: [vec(0, 12), vec(10, 12), vec(10, 14), vec(0, 14)] });

  // snapping v1 to (5,12) turns the square into a bowtie
  const result = ed.dragVertex("A", 1, vec(5, 11));
  assert.ok(!result.applied);
  assert.equal(result.attempts.length, 1);
  assert.ok(result.attempts[0].reason!.includes("self-intersection"));
  assert.ok(result.reasons.some((r) => r.includes("all 1 candidate(s) rejected")));
  assert.deepEqual(ed.getVertices("A"), squareA);
  assert.ok(!ed.canUndo());
});

test("degenerate zero-length snap is rejected with its own reason", () => {
  const ed = new Editor(2);
  ed.addShape({ id: "A", vertices: squareA });
  // B:e0 lies on y=0 and passes through A's vertex 0
  ed.addShape({ id: "B", vertices: [vec(-5, 0), vec(15, 0), vec(15, 2), vec(-5, 2)] });

  const result = ed.dragVertex("A", 1, vec(0, 1));
  assert.equal(result.attempts[0].wireId, "B:e0");
  assert.deepEqual(result.attempts[0].snap, vec(0, 0));
  assert.ok(!result.attempts[0].accepted);
  assert.ok(result.attempts[0].reason!.includes("zero-length edge"));
});

test("undo restores drags in LIFO order", () => {
  const ed = new Editor(3);
  ed.addShape({ id: "A", vertices: [vec(2, -5), vec(8, -5), vec(5, -1)] });
  ed.addShape({ id: "B", vertices: [vec(0, 0), vec(10, 0), vec(10, 6), vec(0, 6)] });

  ed.dragVertex("A", 2, vec(5, -2)); // -> (5,0)
  ed.dragVertex("A", 0, vec(2, -2)); // -> (2,0)
  assert.deepEqual(ed.getVertices("A"), [vec(2, 0), vec(8, -5), vec(5, 0)]);

  ed.undo();
  assert.deepEqual(ed.getVertices("A"), [vec(2, -5), vec(8, -5), vec(5, 0)]);
  ed.undo();
  assert.deepEqual(ed.getVertices("A"), [vec(2, -5), vec(8, -5), vec(5, -1)]);
  assert.equal(ed.undo(), undefined);
});

test("addShape validates its input", () => {
  const ed = new Editor(1);
  assert.throws(() => ed.addShape({ id: "A", vertices: [vec(0, 0), vec(1, 1)] }));
  assert.throws(() =>
    ed.addShape({ id: "A", vertices: [vec(0, 0), vec(1.5, 1), vec(0, 1)] }),
  );
  assert.throws(() =>
    ed.addShape({ id: "A", vertices: [vec(0, 0), vec(10, 10), vec(10, 0), vec(0, 10)] }),
  );
  ed.addShape({ id: "A", vertices: squareA });
  assert.throws(() => ed.addShape({ id: "A", vertices: squareA }));
});
