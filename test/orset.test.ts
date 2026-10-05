import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ORSet } from '../src/orset.js';
import type { Op, VersionVector } from '../src/orset.js';

/** Deterministic PRNG so the convergence fuzz is reproducible. */
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

function sortedValues(set: ORSet<string>): string[] {
  return [...set.values()].sort();
}

function broadcast(ops: Op<string>[], ...replicas: ORSet<string>[]): void {
  for (const op of ops) for (const r of replicas) r.apply(op);
}

function collectAcks(replicas: ORSet<string>[]): Record<string, VersionVector> {
  const acks: Record<string, VersionVector> = {};
  for (const r of replicas) acks[r.replicaId] = r.versionVector();
  return acks;
}

describe('basic add/remove semantics', () => {
  it('adds and removes values', () => {
    const s = new ORSet<string>('A');
    s.add('x');
    s.add('y');
    assert.ok(s.has('x'));
    assert.deepEqual(sortedValues(s), ['x', 'y']);
    s.remove('x');
    assert.ok(!s.has('x'));
    assert.deepEqual(sortedValues(s), ['y']);
  });

  it('stamps every add with a unique tag, so re-add survives an older remove', () => {
    const a = new ORSet<string>('A');
    const add1 = a.add('x');
    const rm = a.remove('x'); // tombstones tag of add1 only
    const add2 = a.add('x'); // fresh unique tag
    assert.notEqual(`${add1.tag.replica}#${add1.tag.seq}`, `${add2.tag.replica}#${add2.tag.seq}`);
    assert.ok(a.has('x'));
    assert.deepEqual(rm.tags, [add1.tag]);

    // A peer that saw add1 and the remove, but not add2, must converge to "x present".
    const b = new ORSet<string>('B');
    b.apply(add1);
    b.apply(rm);
    assert.ok(!b.has('x'));
    b.apply(add2);
    assert.ok(b.has('x'));
  });

  it('remove of a value never observed is a no-op that still advances the clock', () => {
    const a = new ORSet<string>('A');
    const op = a.remove('ghost');
    assert.deepEqual(op.tags, []);
    assert.equal(a.versionVector()['A'], 1);
  });
});

describe('old removes do not swallow unseen adds', () => {
  it('concurrent remove (observing nothing) does not kill a remote add', () => {
    const a = new ORSet<string>('A');
    const b = new ORSet<string>('B');
    const add = a.add('x'); // B never sees it before removing
    const rm = b.remove('x'); // observes no tags -> removes nothing
    a.apply(rm);
    b.apply(add);
    assert.ok(a.has('x'));
    assert.ok(b.has('x'));
  });

  it('stale remove only kills the tags it observed, not later re-adds elsewhere', () => {
    const a = new ORSet<string>('A');
    const b = new ORSet<string>('B');
    const add1 = a.add('x');
    b.apply(add1);
    const rm = b.remove('x'); // tombstones add1's tag
    const add2 = a.add('x'); // A re-adds before seeing the remove
    a.apply(rm);
    b.apply(add2);
    assert.ok(a.has('x'), 'unseen re-add must survive the old remove');
    assert.ok(b.has('x'));
    assert.deepEqual(sortedValues(a), sortedValues(b));
  });
});

describe('op delivery: reordering and duplication', () => {
  it('buffers out-of-order ops and flushes them when the gap fills', () => {
    const a = new ORSet<string>('A');
    const op1 = a.add('first');
    const op2 = a.add('second');
    const b = new ORSet<string>('B');
    assert.equal(b.apply(op2), false, 'gap: seq 2 before seq 1 is buffered');
    assert.ok(!b.has('second'));
    assert.equal(b.apply(op1), true);
    assert.ok(b.has('first'));
    assert.ok(b.has('second'), 'buffered op flushed after gap filled');
    assert.equal(b.versionVector()['A'], 2);
  });

  it('ignores duplicate ops', () => {
    const a = new ORSet<string>('A');
    const op = a.add('x');
    const b = new ORSet<string>('B');
    assert.equal(b.apply(op), true);
    assert.equal(b.apply(op), false);
    assert.equal(b.apply(op), false);
    assert.deepEqual(sortedValues(b), ['x']);
    assert.equal(b.versionVector()['A'], 1);
  });

  it('converges across replicas under shuffled, duplicated delivery (seeded fuzz)', () => {
    const rng = mulberry32(20261005);
    const ids = ['A', 'B', 'C', 'D'];
    const replicas = ids.map((id) => new ORSet<string>(id));
    const ops: Op<string>[] = [];
    for (let round = 0; round < 300; round++) {
      const r = replicas[Math.floor(rng() * replicas.length)]!;
      const value = `v${Math.floor(rng() * 12)}`;
      ops.push(rng() < 0.6 ? r.add(value) : r.remove(value));
    }
    for (const dest of replicas) {
      const shuffled = [...ops];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const withDuplicates = shuffled.flatMap((op) => (rng() < 0.3 ? [op, op] : [op]));
      for (const op of withDuplicates) dest.apply(op);
    }
    const reference = sortedValues(replicas[0]!);
    for (const r of replicas) {
      assert.deepEqual(sortedValues(r), reference, `replica ${r.replicaId} diverged`);
      assert.deepEqual(r.versionVector(), replicas[0]!.versionVector());
      assert.equal(r.tombstoneCount, replicas[0]!.tombstoneCount);
    }
  });
});

describe('union merge', () => {
  it('merges diverged replicas by union of adds and observed removes', () => {
    const a = new ORSet<string>('A');
    const b = new ORSet<string>('B');
    const addX = a.add('x');
    const addY = b.add('y');
    b.apply(addX);
    const rmX = b.remove('x'); // observed addX
    a.apply(addY);
    a.apply(rmX);
    a.merge(b);
    b.merge(a);
    assert.deepEqual(sortedValues(a), ['y']);
    assert.deepEqual(sortedValues(b), ['y']);
  });

  it('is commutative and idempotent on snapshots', () => {
    const rng = mulberry32(7);
    const a = new ORSet<string>('A');
    const b = new ORSet<string>('B');
    const pending: Op<string>[] = [];
    for (let i = 0; i < 60; i++) {
      const r = rng() < 0.5 ? a : b;
      const value = `k${Math.floor(rng() * 8)}`;
      pending.push(rng() < 0.6 ? r.add(value) : r.remove(value));
    }
    // Deliver only a random subset to each side so states genuinely diverge.
    for (const op of pending) {
      if (rng() < 0.5) a.apply(op);
      if (rng() < 0.5) b.apply(op);
    }
    const ab = ORSet.fromState(a.toState());
    ab.merge(b.toState());
    const ba = ORSet.fromState(b.toState());
    ba.merge(a.toState());
    assert.deepEqual(sortedValues(ab), sortedValues(ba), 'merge must be commutative');

    const abab = ORSet.fromState(ab.toState());
    abab.merge(b.toState());
    abab.merge(a.toState());
    assert.deepEqual(sortedValues(abab), sortedValues(ab), 'merge must be idempotent');
    assert.equal(abab.tombstoneCount, ab.tombstoneCount);
  });
});

describe('compaction gated by unanimous confirmation vectors', () => {
  function syncedTrio(): { replicas: ORSet<string>[]; ops: Op<string>[] } {
    const [a, b, c] = ['A', 'B', 'C'].map((id) => new ORSet<string>(id));
    const replicas = [a!, b!, c!];
    const ops: Op<string>[] = [];
    ops.push(a!.add('x'));
    ops.push(a!.add('y'));
    broadcast(ops, ...replicas);
    const rm = b!.remove('x');
    // C announces itself with an empty remove (heartbeat) so every peer
    // learns of its existence and will demand its confirmation vector.
    const ping = c!.remove('__heartbeat__');
    broadcast([rm, ping], ...replicas);
    return { replicas, ops };
  }

  it('drops tombstones once every replica confirms the remove', () => {
    const { replicas } = syncedTrio();
    const [a] = replicas;
    assert.equal(a!.tombstoneCount, 1);
    const dropped = a!.compact(collectAcks(replicas));
    assert.equal(dropped, 1);
    assert.equal(a!.tombstoneCount, 0);
    assert.deepEqual(sortedValues(a!), ['y'], 'compaction must not change membership');
  });

  it('refuses to compact without every known replica\'s confirmation vector', () => {
    const { replicas } = syncedTrio();
    const [a, b] = replicas;
    const partial: Record<string, VersionVector> = { B: b!.versionVector() }; // C missing
    assert.throws(() => a!.compact(partial), /missing confirmation vector.*C/);
    assert.equal(a!.tombstoneCount, 1, 'refused compaction keeps tombstones');
  });

  it('keeps tombstones a lagging replica has not confirmed', () => {
    const { replicas } = syncedTrio();
    const [a, b, c] = replicas;
    // C lags: rebuild its ack as if it never saw B's remove.
    const laggingC: VersionVector = { ...c!.versionVector(), B: 0 };
    const dropped = a!.compact({ B: b!.versionVector(), C: laggingC });
    assert.equal(dropped, 0);
    assert.equal(a!.tombstoneCount, 1);
  });

  it('is safe against resurrection: all replicas confirmed, so none can reintroduce the tag', () => {
    const { replicas } = syncedTrio();
    const acks = collectAcks(replicas);
    for (const r of replicas) r.compact(acks);
    for (const r of replicas) assert.equal(r.tombstoneCount, 0);
    // Gossip states again after compaction: membership stays put, nothing resurrects.
    for (const r of replicas) for (const s of replicas) r.merge(s.toState());
    for (const r of replicas) assert.deepEqual(sortedValues(r), ['y']);
  });
});

describe('serialization', () => {
  it('round-trips through a JSON state snapshot', () => {
    const a = new ORSet<string>('A');
    const ops = [a.add('x'), a.add('y'), a.remove('x')];
    const revived = ORSet.fromState<string>(JSON.parse(JSON.stringify(a.toState())));
    assert.deepEqual(sortedValues(revived), ['y']);
    assert.deepEqual(revived.versionVector(), a.versionVector());
    assert.equal(revived.tombstoneCount, a.tombstoneCount);
    // The revived replica keeps issuing correctly sequenced ops.
    const op = revived.add('z');
    assert.equal(op.seq, 4);
    const b = new ORSet<string>('B');
    broadcast(ops, b);
    b.apply(op);
    assert.deepEqual(sortedValues(b), ['y', 'z']);
  });
});
