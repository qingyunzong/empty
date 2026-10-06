import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DifferenceConstraints,
  type ConstraintEdge,
} from '../src/diff-constraints.js';

function knownDiff(dc: DifferenceConstraints, x: string, y: string): bigint {
  const r = dc.query(x, y);
  assert.equal(r.kind, 'known', `expected ${x} - ${y} to be known`);
  return (r as { kind: 'known'; diff: bigint }).diff;
}

function assertEvidenceCycle(
  evidence: ConstraintEdge[],
  x: string,
  y: string,
  rejected: bigint,
  implied: bigint,
): void {
  assert.ok(evidence.length >= 1, 'evidence must contain at least the closing edge');
  // Edges form a single cycle starting and ending at x.
  assert.equal(evidence[0]!.from, x);
  assert.equal(evidence[evidence.length - 1]!.to, x);
  assert.equal(evidence[evidence.length - 1]!.from, y);
  for (let i = 1; i < evidence.length; i++) {
    assert.equal(evidence[i]!.from, evidence[i - 1]!.to, 'edges must chain');
  }
  // Closing edge is the rejected constraint traversed backwards.
  assert.equal(evidence[evidence.length - 1]!.diff, -rejected);
  // Telescoping sum around the cycle is the witnessed non-zero slack.
  const sum = evidence.reduce((acc, e) => acc + e.diff, 0n);
  assert.equal(sum, implied - rejected);
  assert.notEqual(sum, 0n);
}

describe('basic constraints and queries', () => {
  test('chains telescope: a-b=3, b-c=4 implies a-c=7', () => {
    const dc = new DifferenceConstraints();
    assert.deepEqual(dc.add('a', 'b', 3n), { ok: true });
    assert.deepEqual(dc.add('b', 'c', 4n), { ok: true });
    assert.equal(knownDiff(dc, 'a', 'c'), 7n);
    assert.equal(knownDiff(dc, 'c', 'a'), -7n);
    assert.equal(knownDiff(dc, 'a', 'a'), 0n);
  });

  test('disconnected variables query as unknown', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 1n);
    dc.add('c', 'd', 2n);
    assert.deepEqual(dc.query('a', 'c'), { kind: 'unknown' });
    assert.deepEqual(dc.query('a', 'never-seen'), { kind: 'unknown' });
    assert.deepEqual(dc.query('never-seen', 'also-never-seen'), { kind: 'unknown' });
  });

  test('redundant consistent constraint is accepted', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 3n);
    dc.add('b', 'c', 4n);
    assert.deepEqual(dc.add('a', 'c', 7n), { ok: true });
    assert.deepEqual(dc.add('x', 'x', 0n), { ok: true });
  });

  test('bigint values beyond the safe-integer range', () => {
    const dc = new DifferenceConstraints();
    const big = 2n ** 62n + 12345n;
    dc.add('a', 'b', big);
    dc.add('b', 'c', big);
    assert.equal(knownDiff(dc, 'a', 'c'), 2n * big);
    assert.equal(knownDiff(dc, 'c', 'a'), -2n * big);
  });
});

describe('contradictions', () => {
  test('rejected with evidence path, state preserved', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 3n);
    dc.add('b', 'c', 4n);
    const res = dc.add('a', 'c', 100n);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'contradiction');
    assert.equal(res.implied, 7n);
    assertEvidenceCycle(res.evidence, 'a', 'c', 100n, 7n);
    // Rejection must not mutate the store.
    assert.equal(knownDiff(dc, 'a', 'c'), 7n);
    assert.equal(knownDiff(dc, 'c', 'a'), -7n);
  });

  test('trivial self-contradiction x - x = 1', () => {
    const dc = new DifferenceConstraints();
    const res = dc.add('x', 'x', 1n);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.implied, 0n);
    assertEvidenceCycle(res.evidence, 'x', 'x', 1n, 0n);
  });

  test('direct conflict on an existing edge', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 5n);
    const res = dc.add('b', 'a', -6n);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.implied, -5n);
    assertEvidenceCycle(res.evidence, 'b', 'a', -6n, -5n);
    assert.equal(knownDiff(dc, 'a', 'b'), 5n);
  });
});

describe('snapshot and rollback', () => {
  test('rollback restores prior differences and connectivity', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 3n);
    const snap = dc.snapshot();
    dc.add('b', 'c', 4n);
    dc.add('c', 'd', 5n);
    assert.equal(knownDiff(dc, 'a', 'd'), 12n);
    dc.rollback(snap);
    assert.equal(knownDiff(dc, 'a', 'b'), 3n);
    assert.deepEqual(dc.query('a', 'c'), { kind: 'unknown' });
    assert.deepEqual(dc.query('c', 'd'), { kind: 'unknown' });
  });

  test('nested snapshots roll back independently', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 1n);
    const s1 = dc.snapshot();
    dc.add('b', 'c', 2n);
    const s2 = dc.snapshot();
    dc.add('c', 'd', 3n);
    dc.rollback(s2);
    assert.deepEqual(dc.query('c', 'd'), { kind: 'unknown' });
    assert.equal(knownDiff(dc, 'a', 'c'), 3n);
    dc.rollback(s1);
    assert.deepEqual(dc.query('a', 'c'), { kind: 'unknown' });
    assert.equal(knownDiff(dc, 'a', 'b'), 1n);
  });

  test('rollback to zero disconnects everything', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 1n);
    dc.add('b', 'c', 2n);
    dc.rollback(0);
    assert.deepEqual(dc.query('a', 'b'), { kind: 'unknown' });
    assert.deepEqual(dc.query('b', 'c'), { kind: 'unknown' });
  });

  test('invalid snapshot handles are rejected', () => {
    const dc = new DifferenceConstraints();
    dc.add('a', 'b', 1n);
    assert.throws(() => dc.rollback(-1), RangeError);
    assert.throws(() => dc.rollback(2), RangeError);
    assert.throws(() => dc.rollback(0.5), RangeError);
  });
});

// ---------------------------------------------------------------------------
// Randomized differential test: the library is checked against an independent
// potential model (BFS over the accepted-constraint graph) after every op,
// including rollbacks.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent reference model: replay accepted constraints via BFS potentials. */
class PotentialModel {
  private constraints: { x: string; y: string; d: bigint }[] = [];

  add(x: string, y: string, d: bigint): void {
    this.constraints.push({ x, y, d });
  }

  snapshot(): number {
    return this.constraints.length;
  }

  rollback(snap: number): void {
    this.constraints.length = snap;
  }

  /** x - y via BFS-assigned potentials, or 'unknown' when disconnected. */
  query(x: string, y: string): bigint | 'unknown' {
    if (x === y) return 0n; // reflexivity is axiomatic
    const adj = new Map<string, { to: string; w: bigint }[]>();
    const push = (a: string, to: string, w: bigint) => {
      let list = adj.get(a);
      if (!list) adj.set(a, (list = []));
      list.push({ to, w });
    };
    for (const c of this.constraints) {
      push(c.x, c.y, c.d); // x - y = d
      push(c.y, c.x, -c.d);
    }
    if (!adj.has(x) || !adj.has(y)) return 'unknown';
    // pot[v] = v - x along the traversal tree.
    const pot = new Map<string, bigint>([[x, 0n]]);
    const queue = [x];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of adj.get(cur)!) {
        if (!pot.has(e.to)) {
          pot.set(e.to, pot.get(cur)! + e.w);
          queue.push(e.to);
        }
      }
    }
    const py = pot.get(y);
    return py === undefined ? 'unknown' : py;
  }
}

for (const seed of [0x5eed, 1, 42, 0xc0ffee, 987654321]) {
test(`random small graphs match the potential model (seed ${seed})`, () => {
  const rand = mulberry32(seed);
  const VAR_COUNT = 8;
  const OPS = 2000;
  const vars = Array.from({ length: VAR_COUNT }, (_, i) => `v${i}`);
  const pickVar = () => vars[Math.floor(rand() * vars.length)]!;
  const pickDiff = () => BigInt(Math.floor(rand() * 21) - 10);

  const dc = new DifferenceConstraints();
  const model = new PotentialModel();
  const snaps: { dc: number; model: number }[] = [];

  const verifyAllPairs = (opLabel: string) => {
    for (const a of vars) {
      for (const b of vars) {
        const got = dc.query(a, b);
        const want = model.query(a, b);
        if (want === 'unknown') {
          assert.deepEqual(got, { kind: 'unknown' }, `${opLabel}: ${a}-${b}`);
        } else {
          assert.deepEqual(got, { kind: 'known', diff: want }, `${opLabel}: ${a}-${b}`);
        }
      }
    }
  };

  for (let op = 0; op < OPS; op++) {
    const roll = rand();
    if (roll < 0.55) {
      // add
      const x = pickVar();
      const y = pickVar();
      const d = pickDiff();
      const res = dc.add(x, y, d);
      if (res.ok) {
        // Accepted only when consistent with the model.
        const want = model.query(x, y);
        assert.ok(want === 'unknown' || want === d, `accepted contradicting add ${x}-${y}=${d}`);
        model.add(x, y, d);
      } else {
        // Rejected: the model must already imply a different difference,
        // and the evidence cycle must check out.
        const want = model.query(x, y);
        assert.ok(want !== 'unknown' && want !== d, `wrongly rejected add ${x}-${y}=${d}`);
        assert.equal(res.implied, want);
        assertEvidenceCycle(res.evidence, x, y, d, res.implied);
      }
      verifyAllPairs(`op${op} add ${x}-${y}=${d}`);
    } else if (roll < 0.7) {
      // snapshot
      snaps.push({ dc: dc.snapshot(), model: model.snapshot() });
    } else if (roll < 0.9) {
      // rollback to a random live snapshot (or skip if none)
      if (snaps.length > 0) {
        const idx = Math.floor(rand() * snaps.length);
        // Handles are monotonic, so every snapshot after idx is newer and
        // becomes invalid the moment we roll back to this one.
        const snap = snaps[idx]!;
        snaps.length = idx;
        dc.rollback(snap.dc);
        model.rollback(snap.model);
        verifyAllPairs(`op${op} rollback`);
      }
    } else {
      verifyAllPairs(`op${op} query`);
    }
  }
});
}
