import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DiffConstraints,
  type ConstraintEdge,
  type VarId,
} from "../src/diff-constraints.js";

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

test("records and queries direct and transitive differences", () => {
  const dc = new DiffConstraints();
  assert.deepEqual(dc.add("x", "y", 5n), { ok: true, redundant: false });
  assert.deepEqual(dc.add("y", "z", 3n), { ok: true, redundant: false });

  assert.deepEqual(dc.query("x", "y"), { known: true, diff: 5n });
  assert.deepEqual(dc.query("y", "x"), { known: true, diff: -5n });
  assert.deepEqual(dc.query("x", "z"), { known: true, diff: 8n });
  assert.deepEqual(dc.query("x", "x"), { known: true, diff: 0n });
});

test("redundant constraints are accepted and flagged", () => {
  const dc = new DiffConstraints();
  dc.add("a", "b", 7n);
  dc.add("b", "c", 1n);
  assert.deepEqual(dc.add("a", "c", 8n), { ok: true, redundant: true });
});

test("disconnected or unseen variables query as unknown", () => {
  const dc = new DiffConstraints();
  dc.add("a", "b", 1n);
  dc.add("c", "d", 2n);
  assert.deepEqual(dc.query("a", "c"), { known: false });
  assert.deepEqual(dc.query("a", "ghost"), { known: false });
  assert.deepEqual(dc.query("ghost", "a"), { known: false });
});

test("contradiction is rejected, state untouched, evidence proves conflict", () => {
  const dc = new DiffConstraints();
  dc.add("x", "y", 5n);
  dc.add("y", "z", 2n);
  // x - z is already implied to be 7.
  const res = dc.add("x", "z", 100n);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.existing, 7n);
  assert.equal(res.requested, 100n);

  // Evidence is a chain x ~> z whose edges sum to the existing difference.
  assertEvidenceChain(res.evidence, "x", "z", 7n);

  // Store unchanged: old facts still hold, rejected one does not.
  assert.deepEqual(dc.query("x", "z"), { known: true, diff: 7n });
  assert.deepEqual(dc.query("x", "y"), { known: true, diff: 5n });
});

test("snapshot/rollback undoes unions and variable creation", () => {
  const dc = new DiffConstraints();
  dc.add("a", "b", 4n);
  const snap = dc.snapshot();

  dc.add("b", "c", 6n);
  dc.add("fresh1", "fresh2", 1n);
  assert.deepEqual(dc.query("a", "c"), { known: true, diff: 10n });

  dc.rollback(snap);
  assert.deepEqual(dc.query("a", "c"), { known: false });
  assert.deepEqual(dc.query("a", "b"), { known: true, diff: 4n });
  assert.equal(dc.has("fresh1"), false);
  assert.equal(dc.has("c"), false);

  // After rollback the store keeps working, even with different values.
  dc.add("b", "c", -2n);
  assert.deepEqual(dc.query("a", "c"), { known: true, diff: 2n });
});

test("nested snapshots roll back in any order", () => {
  const dc = new DiffConstraints();
  dc.add("a", "b", 1n);
  const s1 = dc.snapshot();
  dc.add("b", "c", 2n);
  const s2 = dc.snapshot();
  dc.add("c", "d", 3n);

  dc.rollback(s2);
  assert.deepEqual(dc.query("a", "d"), { known: false });
  assert.deepEqual(dc.query("a", "c"), { known: true, diff: 3n });

  dc.rollback(s1);
  assert.deepEqual(dc.query("a", "c"), { known: false });
  assert.deepEqual(dc.query("b", "a"), { known: true, diff: -1n });
});

test("contradiction introduced then rolled back leaves no trace", () => {
  const dc = new DiffConstraints();
  dc.add("a", "b", 1n);
  const snap = dc.snapshot();
  dc.add("b", "c", 2n);
  const rejected = dc.add("a", "c", 99n);
  assert.equal(rejected.ok, false);
  dc.rollback(snap);
  // c was introduced after the snapshot; it must be gone entirely.
  assert.equal(dc.has("c"), false);
  dc.add("a", "c", 5n); // now perfectly consistent
  assert.deepEqual(dc.query("a", "c"), { known: true, diff: 5n });
});

test("bigint precision: differences beyond 2^53", () => {
  const dc = new DiffConstraints();
  const big = (1n << 80n) + 12345678901234567890n;
  dc.add("p", "q", big);
  dc.add("q", "r", -big);
  assert.deepEqual(dc.query("p", "r"), { known: true, diff: 0n });
  assert.deepEqual(dc.query("q", "p"), { known: true, diff: -big });
  const res = dc.add("r", "p", 1n);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.existing, 0n);
});

test("rollback rejects invalid snapshots", () => {
  const dc = new DiffConstraints();
  dc.add("a", "b", 1n);
  assert.throws(() => dc.rollback(-1), RangeError);
  assert.throws(() => dc.rollback(dc.snapshot() + 1), RangeError);
});

// ---------------------------------------------------------------------------
// Randomized model-based test: weighted-union-find vs. BFS potential model
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reference model: the plain list of accepted constraints. Differences are
 * recomputed from scratch by BFS potential assignment per component.
 * Snapshots are just lengths of the constraint list.
 */
class PotentialModel {
  private edges: ConstraintEdge[] = [];

  snapshot(): number {
    return this.edges.length;
  }

  rollback(snap: number): void {
    this.edges.length = snap;
  }

  /** BFS potentials: pot[v] = v - (component reference). */
  private potentials(): Map<VarId, { comp: number; pot: bigint }> {
    const adj = new Map<VarId, { to: VarId; w: bigint }[]>();
    for (const { a, b, d } of this.edges) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push({ to: b, w: d }); // b = a - d
      adj.get(b)!.push({ to: a, w: -d }); // a = b + d
    }
    const pot = new Map<VarId, { comp: number; pot: bigint }>();
    let comp = 0;
    for (const start of adj.keys()) {
      if (pot.has(start)) continue;
      pot.set(start, { comp, pot: 0n });
      const queue = [start];
      while (queue.length) {
        const u = queue.pop()!;
        for (const { to, w } of adj.get(u)!) {
          if (pot.has(to)) continue;
          pot.set(to, { comp, pot: pot.get(u)!.pot - w });
          queue.push(to);
        }
      }
      comp++;
    }
    return pot;
  }

  diff(x: VarId, y: VarId): { known: boolean; diff: bigint } {
    const pot = this.potentials();
    const px = pot.get(x);
    const py = pot.get(y);
    if (!px || !py || px.comp !== py.comp) return { known: false, diff: 0n };
    return { known: true, diff: px.pot - py.pot };
  }

  /** Try adding x - y = d; returns false (and changes nothing) on conflict. */
  add(x: VarId, y: VarId, d: bigint): boolean {
    if (x === y) {
      if (d !== 0n) return false;
      this.edges.push({ a: x, b: y, d }); // keeps the variable known
      return true;
    }
    const cur = this.diff(x, y);
    if (cur.known && cur.diff !== d) return false;
    this.edges.push({ a: x, b: y, d });
    return true;
  }
}

function assertEvidenceChain(
  evidence: ConstraintEdge[],
  from: VarId,
  to: VarId,
  expectedSum: bigint,
): void {
  if (evidence.length === 0) {
    // Only possible for a self-contradiction x - x = d with d !== 0:
    // the trivially empty path already sums to 0.
    assert.equal(from, to, "empty evidence only valid for self-contradiction");
    assert.equal(expectedSum, 0n);
    return;
  }
  assert.equal(evidence[0].a, from, "evidence starts at the queried source");
  assert.equal(evidence[evidence.length - 1].b, to, "evidence ends at target");
  let sum = 0n;
  for (let i = 0; i < evidence.length; i++) {
    if (i > 0) assert.equal(evidence[i].a, evidence[i - 1].b, "chain links");
    sum += evidence[i].d;
  }
  assert.equal(sum, expectedSum, "evidence sums to the existing difference");
}

test("random small graphs: store matches BFS potential model across rollbacks", () => {
  const NUM_VARS = 7;
  const OPS = 4000;

  for (const seed of [1, 42, 1337, 20261007]) {
    const rand = rng(seed);
    const dc = new DiffConstraints();
    const model = new PotentialModel();
    const snaps: { dc: number; model: number }[] = [];
    const vars = (): VarId => Math.floor(rand() * NUM_VARS);
    const bigval = (): bigint => {
      const base = BigInt(Math.floor(rand() * 41) - 20);
      // Occasionally exercise values far beyond 2^53.
      return rand() < 0.1 ? base * (1n << 70n) : base;
    };

    for (let op = 0; op < OPS; op++) {
      const roll = rand();
      if (roll < 0.45) {
        // add
        const [x, y, d] = [vars(), vars(), bigval()];
        const got = dc.add(x, y, d);
        const modelOk = model.add(x, y, d);
        assert.equal(got.ok, modelOk, `seed ${seed} op ${op}: add(${x},${y},${d})`);
        if (!got.ok) {
          const expected = x === y ? { known: true as const, diff: 0n } : model.diff(x, y);
          assert.ok(expected.known);
          assert.equal(got.existing, expected.diff);
          assert.equal(got.requested, d);
          assertEvidenceChain(got.evidence, x, y, expected.diff);
          for (const e of got.evidence) {
            // Every evidence edge must be implied by the accepted constraints.
            const implied = model.diff(e.a, e.b);
            assert.ok(implied.known, "evidence edge endpoints are connected");
            assert.equal(implied.diff, e.d, "evidence edge holds in the model");
          }
        }
      } else if (roll < 0.6) {
        // snapshot
        snaps.push({ dc: dc.snapshot(), model: model.snapshot() });
      } else if (roll < 0.75 && snaps.length > 0) {
        // rollback to a random live snapshot
        const idx = Math.floor(rand() * snaps.length);
        const s = snaps[idx];
        dc.rollback(s.dc);
        model.rollback(s.model);
        snaps.length = idx; // snapshots taken after it are invalidated
      } else {
        // query
        const [x, y] = [vars(), vars()];
        const got = dc.query(x, y);
        const want = model.diff(x, y);
        assert.equal(got.known, want.known, `seed ${seed} op ${op}: query(${x},${y})`);
        if (got.known) assert.equal(got.diff, want.diff);
      }
    }

    // Final full sweep: every ordered pair must agree with the model.
    for (let x = 0; x < NUM_VARS; x++) {
      for (let y = 0; y < NUM_VARS; y++) {
        const got = dc.query(x, y);
        const want = model.diff(x, y);
        assert.equal(got.known, want.known, `seed ${seed} final query(${x},${y})`);
        if (got.known) assert.equal(got.diff, want.diff);
      }
    }
  }
});
