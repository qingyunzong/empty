import test from "node:test";
import assert from "node:assert";
import { PolygonEditor, PolygonValidationError } from "../src/editor";
import { Polygon } from "../src/polygon";
import { mulberry32, oracleVerdict } from "./oracle";

const BASE: Polygon = {
  outer: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  holes: [
    [
      { x: 2, y: 2 },
      { x: 4, y: 2 },
      { x: 4, y: 4 },
      { x: 2, y: 4 },
    ],
  ],
};

test("constructor rejects an invalid initial polygon with evidence", () => {
  const bowtie: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 2, y: 6 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
    holes: [],
  };
  assert.throws(() => new PolygonEditor(bowtie), (err: unknown) => {
    if (!(err instanceof PolygonValidationError)) return false;
    assert.equal(err.conflicts.length, 1);
    assert.equal(err.conflicts[0]!.kind, "self-intersection");
    return true;
  });
});

test("valid move publishes a new version; old versions stay readable", () => {
  const ed = new PolygonEditor(BASE);
  const r1 = ed.moveVertex({ ring: 0, index: 0 }, { x: -2, y: -2 });
  if (!r1.ok) assert.fail(`move 1 rejected: ${r1.conflicts[0]?.message}`);
  assert.equal(r1.version, 1);
  const r2 = ed.moveVertex({ ring: 1, index: 0 }, { x: 3, y: 3 });
  if (!r2.ok) assert.fail(`move 2 rejected: ${r2.conflicts[0]?.message}`);
  assert.equal(r2.version, 2);

  assert.equal(ed.versionCount, 3);
  // Version 0 is the untouched original.
  assert.deepEqual(ed.getVersion(0), BASE);
  // Version 1 has only the first move.
  assert.deepEqual(ed.getVersion(1).outer[0], { x: -2, y: -2 });
  assert.deepEqual(ed.getVersion(1).holes[0]![0], { x: 2, y: 2 });
  // Current has both.
  assert.deepEqual(ed.current.outer[0], { x: -2, y: -2 });
  assert.deepEqual(ed.current.holes[0]![0], { x: 3, y: 3 });
  assert.throws(() => ed.getVersion(3), RangeError);
});

test("published versions are immutable snapshots", () => {
  const ed = new PolygonEditor(BASE);
  ed.moveVertex({ ring: 0, index: 0 }, { x: -1, y: -1 });
  const v0 = ed.getVersion(0);
  assert.throws(() => {
    (v0.outer[0] as { x: number }).x = 999;
  }, TypeError);
  assert.deepEqual(ed.getVersion(0), BASE);
});

test("self-intersecting move is rejected with edge evidence; state unchanged", () => {
  const ed = new PolygonEditor(BASE);
  const res = ed.moveVertex({ ring: 0, index: 1 }, { x: 2, y: 16 });
  if (res.ok) assert.fail("self-intersecting move was accepted");
  assert.equal(res.conflicts.length, 1);
  const c = res.conflicts[0]!;
  assert.equal(c.kind, "self-intersection");
  if (c.kind === "self-intersection") {
    assert.deepEqual(c.a, { ring: 0, edge: 0 });
    assert.deepEqual(c.b, { ring: 0, edge: 2 });
    assert.equal(c.intersection.type, "cross");
    assert.match(c.message, /outer edge 0 .*crosses outer edge 2/);
  }
  assert.equal(ed.version, 0);
  assert.deepEqual(ed.current, BASE);
});

test("move that merely touches another edge is rejected (touch = conflict)", () => {
  const ed = new PolygonEditor(BASE);
  // Vertex 1 lands exactly on edge 2 ((10,10)-(0,10)).
  const res = ed.moveVertex({ ring: 0, index: 1 }, { x: 5, y: 10 });
  if (res.ok) assert.fail("touching move was accepted");
  const c = res.conflicts[0]!;
  assert.equal(c.kind, "self-intersection");
  if (c.kind === "self-intersection") {
    assert.equal(c.intersection.type, "touch");
    if (c.intersection.type === "touch") {
      assert.deepEqual(c.intersection.point, { x: 5, y: 10 });
    }
  }
  assert.equal(ed.version, 0);
});

test("move pushing the hole outside the outer ring is rejected", () => {
  const ed = new PolygonEditor(BASE);
  // Moving the whole hole out in one batch: no edge crossing, the hole is
  // simply outside the outer ring.
  const res = ed.moveVertices(
    [0, 1, 2, 3].map((i) => ({
      target: { ring: 1, index: i },
      to: { x: BASE.holes[0]![i]!.x + 20, y: BASE.holes[0]![i]!.y + 20 },
    })),
  );
  if (res.ok) assert.fail("escaping hole move was accepted");
  assert.deepEqual(
    res.conflicts.map((c) => c.kind),
    ["hole-outside-outer"],
  );
  assert.equal(ed.version, 0);
});

test("move making the hole touch the outer ring is rejected", () => {
  const ed = new PolygonEditor(BASE);
  const res = ed.moveVertex({ ring: 1, index: 0 }, { x: 0, y: 2 });
  if (res.ok) assert.fail("touching hole move was accepted");
  assert.ok(
    res.conflicts.some(
      (c) =>
        c.kind === "ring-intersection" && c.intersection.type === "touch",
    ),
  );
  assert.equal(ed.version, 0);
});

test("batch: vertex swap valid only as a batch is published atomically", () => {
  const ed = new PolygonEditor({
    outer: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
    holes: [],
  });
  // Each single move would duplicate a vertex (touch) and be rejected...
  const alone = ed.moveVertex({ ring: 0, index: 0 }, { x: 4, y: 4 });
  if (alone.ok) assert.fail("single duplicating move was accepted");
  // ...but swapping both corners in one batch yields the same square.
  const res = ed.moveVertices([
    { target: { ring: 0, index: 0 }, to: { x: 4, y: 4 } },
    { target: { ring: 0, index: 2 }, to: { x: 0, y: 0 } },
  ]);
  if (!res.ok) assert.fail(`swap rejected: ${res.conflicts[0]?.message}`);
  assert.equal(res.version, 1);
  assert.deepEqual(ed.current.outer, [
    { x: 4, y: 4 },
    { x: 4, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 4 },
  ]);
});

test("batch: one bad move rejects the whole batch, nothing is published", () => {
  const ed = new PolygonEditor(BASE);
  const res = ed.moveVertices([
    { target: { ring: 0, index: 0 }, to: { x: -5, y: -5 } }, // fine alone
    { target: { ring: 1, index: 0 }, to: { x: 50, y: 50 } }, // hole escapes
  ]);
  if (res.ok) assert.fail("batch with escaping hole was accepted");
  // Dragging one hole vertex out pulls its edges across the outer ring.
  assert.ok(
    res.conflicts.some(
      (c) => c.kind === "ring-intersection" || c.kind === "hole-outside-outer",
    ),
  );
  assert.equal(ed.version, 0);
  assert.deepEqual(ed.current, BASE);
});

test("batch: duplicate targets and bad references are programmer errors", () => {
  const ed = new PolygonEditor(BASE);
  assert.throws(
    () =>
      ed.moveVertices([
        { target: { ring: 0, index: 0 }, to: { x: 1, y: 1 } },
        { target: { ring: 0, index: 0 }, to: { x: 2, y: 2 } },
      ]),
    RangeError,
  );
  assert.throws(
    () => ed.moveVertex({ ring: 5, index: 0 }, { x: 0, y: 0 }),
    RangeError,
  );
  assert.throws(
    () => ed.moveVertex({ ring: 0, index: 99 }, { x: 0, y: 0 }),
    RangeError,
  );
  assert.throws(() => ed.moveVertices([]), RangeError);
});

test("non-integer move target is rejected with invalid-coordinate evidence", () => {
  const ed = new PolygonEditor(BASE);
  const res = ed.moveVertex({ ring: 0, index: 0 }, { x: 0.5, y: 0 });
  if (res.ok) assert.fail("non-integer move was accepted");
  assert.equal(res.conflicts[0]!.kind, "invalid-coordinate");
  assert.equal(ed.version, 0);
});

test("fuzz: random move batches stay consistent with the oracle", () => {
  const rand = mulberry32(0xf00d);
  const int = (lo: number, hi: number) =>
    lo + Math.floor(rand() * (hi - lo + 1));
  let accepted = 0;
  let rejected = 0;
  for (let iter = 0; iter < 300; iter++) {
    const ed = new PolygonEditor(BASE);
    const moves = Array.from({ length: int(1, 3) }, () => {
      const ring = rand() < 0.5 ? 0 : 1;
      return {
        target: { ring, index: int(0, 3) },
        to: { x: int(-12, 22), y: int(-12, 22) },
      };
    });
    // Skip batches with duplicate targets (a programmer error by design).
    const keys = new Set(moves.map((m) => `${m.target.ring}:${m.target.index}`));
    if (keys.size !== moves.length) continue;

    const res = ed.moveVertices(moves);
    const candidate = structuredClone(BASE) as Polygon;
    for (const m of moves) {
      (m.target.ring === 0 ? candidate.outer : candidate.holes[m.target.ring - 1]!)[
        m.target.index
      ] = m.to;
    }
    const oracle = oracleVerdict(candidate);
    if (res.ok) {
      accepted++;
      assert.ok(oracle.valid, `accepted invalid polygon: ${JSON.stringify(candidate)}`);
      assert.equal(ed.version, 1);
      assert.deepEqual(ed.current, candidate);
      assert.deepEqual(ed.getVersion(0), BASE);
    } else {
      rejected++;
      assert.ok(!oracle.valid, `rejected valid polygon: ${JSON.stringify(candidate)}`);
      assert.equal(ed.version, 0);
      assert.deepEqual(ed.current, BASE);
      // Every reported edge conflict is confirmed by the oracle.
      for (const c of res.conflicts) {
        if (c.kind === "self-intersection" || c.kind === "ring-intersection") {
          assert.ok(
            oracle.pairs.has(`${c.a.ring}.${c.a.edge}/${c.b.ring}.${c.b.edge}`),
            `unconfirmed conflict ${c.message}`,
          );
        }
      }
    }
  }
  assert.ok(accepted > 0, "fuzzer accepted nothing");
  assert.ok(rejected > 0, "fuzzer rejected nothing");
});
