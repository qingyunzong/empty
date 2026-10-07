import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { Editor, Wire } from "../src/editor";
import { Point } from "../src/geometry";

const square: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

function makeEditor(wires: Wire[], threshold: number, vertices: Point[] = square): Editor {
  return new Editor(vertices, wires, threshold);
}

test("snaps to the candidate with the smallest squared distance", () => {
  const editor = makeEditor(
    [
      { id: 1, points: [{ x: 0, y: -4 }, { x: 10, y: -4 }] },
      { id: 2, points: [{ x: 0, y: -6 }, { x: 10, y: -6 }] },
    ],
    5,
  );
  const result = editor.dragVertex(0, { x: 2, y: -3 });
  ok(result.ok);
  equal(result.accepted.wireId, 1);
  deepEqual(result.to, { x: 2, y: -4 });
  deepEqual(result.from, { x: 0, y: 0 });
  deepEqual(result.rejected, []);
  deepEqual(editor.getVertex(0), { x: 2, y: -4 });
});

test("breaks squared-distance ties by ascending wire id", () => {
  const editor = makeEditor(
    [
      { id: 7, points: [{ x: 0, y: 2 }, { x: 10, y: 2 }] },
      { id: 2, points: [{ x: 0, y: 8 }, { x: 10, y: 8 }] },
    ],
    5,
  );
  const result = editor.dragVertex(0, { x: 2, y: 5 });
  ok(result.ok);
  equal(result.accepted.wireId, 2);
  deepEqual(result.to, { x: 2, y: 8 });
});

test("rejects the drag when no wire is within the threshold", () => {
  const editor = makeEditor([{ id: 1, points: [{ x: 0, y: -20 }, { x: 10, y: -20 }] }], 5);
  const result = editor.dragVertex(0, { x: 2, y: -3 });
  ok(!result.ok);
  ok(result.reason.includes("no candidate wire within threshold"));
  deepEqual(result.rejected, []);
  deepEqual(editor.getVertex(0), { x: 0, y: 0 });
  equal(editor.canUndo(), false);
});

test("skips a self-intersecting candidate and takes the next legal one", () => {
  const editor = makeEditor(
    [
      // Nearest: snapping vertex 1 to (11, 12) makes edge 0 cross edge 2.
      { id: 1, points: [{ x: 10, y: 12 }, { x: 20, y: 12 }] },
      // Farther but legal: vertex 1 lands at (11, -5).
      { id: 2, points: [{ x: 0, y: -5 }, { x: 20, y: -5 }] },
    ],
    20,
  );
  const result = editor.dragVertex(1, { x: 11, y: 11 });
  ok(result.ok);
  equal(result.accepted.wireId, 2);
  deepEqual(result.to, { x: 11, y: -5 });
  equal(result.rejected.length, 1);
  equal(result.rejected[0]!.candidate.wireId, 1);
  equal(result.rejected[0]!.code, "SELF_INTERSECTION");
  ok(result.rejected[0]!.reason.includes("edge 0 cross edge 2"));
  deepEqual(editor.getVertex(1), { x: 11, y: -5 });
});

test("fails with per-candidate reasons when every candidate self-intersects", () => {
  const editor = makeEditor(
    [{ id: 9, points: [{ x: 10, y: 12 }, { x: 20, y: 12 }] }],
    5,
  );
  const result = editor.dragVertex(1, { x: 11, y: 11 });
  ok(!result.ok);
  ok(result.reason.includes("all 1 candidate(s) rejected"));
  equal(result.rejected.length, 1);
  equal(result.rejected[0]!.candidate.wireId, 9);
  equal(result.rejected[0]!.code, "SELF_INTERSECTION");
  // State untouched, nothing to undo.
  deepEqual(editor.getVertex(1), { x: 10, y: 0 });
  equal(editor.canUndo(), false);
});

test("snapped positions are rounded to integer coordinates", () => {
  const editor = makeEditor(
    [{ id: 1, points: [{ x: 0, y: 0 }, { x: 4, y: 2 }] }],
    2,
  );
  // Closest point on the wire is (1.6, 0.8); the vertex must land on (2, 1).
  const result = editor.dragVertex(0, { x: 1, y: 2 });
  ok(result.ok);
  deepEqual(result.to, { x: 2, y: 1 });
  deepEqual(editor.getVertex(0), { x: 2, y: 1 });
});

test("undo reverts a whole drag, LIFO across drags", () => {
  const editor = makeEditor(
    [{ id: 1, points: [{ x: 0, y: -4 }, { x: 20, y: -4 }] }],
    5,
  );
  ok(editor.dragVertex(0, { x: 2, y: -3 }).ok);
  ok(editor.dragVertex(1, { x: 12, y: -3 }).ok);
  deepEqual(editor.getVertex(0), { x: 2, y: -4 });
  deepEqual(editor.getVertex(1), { x: 12, y: -4 });

  ok(editor.undo());
  deepEqual(editor.getVertex(1), { x: 10, y: 0 });
  deepEqual(editor.getVertex(0), { x: 2, y: -4 });

  ok(editor.undo());
  deepEqual(editor.getVertex(0), { x: 0, y: 0 });
  equal(editor.undo(), false);
});

test("a failed drag in between does not corrupt the undo stack", () => {
  const editor = makeEditor(
    [
      { id: 1, points: [{ x: 0, y: -4 }, { x: 20, y: -4 }] },
      { id: 2, points: [{ x: 10, y: 12 }, { x: 20, y: 12 }] },
    ],
    5,
  );
  ok(editor.dragVertex(0, { x: 2, y: -3 }).ok);
  // This drag fails (only candidate self-intersects), must not push history.
  ok(!editor.dragVertex(1, { x: 11, y: 11 }).ok);
  ok(editor.undo());
  deepEqual(editor.getVertex(0), { x: 0, y: 0 });
  equal(editor.canUndo(), false);
});

test("candidates() lists every in-threshold wire in ranked order", () => {
  const editor = makeEditor(
    [
      { id: 5, points: [{ x: 0, y: -3 }, { x: 10, y: -3 }] },   // dist2 = 4
      { id: 3, points: [{ x: 0, y: -2 }, { x: 10, y: -2 }] },   // dist2 = 1
      { id: 4, points: [{ x: 0, y: -2 }, { x: 10, y: -2 }] },   // dist2 = 1, id tiebreak
      { id: 6, points: [{ x: 0, y: -30 }, { x: 10, y: -30 }] }, // out of range
    ],
    5,
  );
  const ranked = editor.candidates({ x: 4, y: -1 });
  deepEqual(ranked.map((c) => c.wireId), [3, 4, 5]);
  ok(ranked.every((c) => Number.isInteger(c.point.x) && Number.isInteger(c.point.y)));
});

test("constructor and drag validate their inputs", () => {
  throws(() => new Editor([{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [], 1));
  throws(() => new Editor([{ x: 0, y: 0 }, { x: 1, y: 0 }], [], 1));
  throws(() => new Editor(square, [{ id: 1, points: [{ x: 0, y: 0 }] }], 1));
  const editor = makeEditor([], 1);
  throws(() => editor.dragVertex(7, { x: 0, y: 0 }), RangeError);
});
