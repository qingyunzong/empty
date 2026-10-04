import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionStore } from '../src/store.js';
import { modelEffective } from '../src/model.js';
import type { Operation } from '../src/ops.js';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
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

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

interface Scenario {
  ops: Operation[];
  perms: string[];
}

/**
 * Generate a random causal history: several actors issue grants/revokes;
 * with some probability an actor first "catches up" on a random subset
 * of already-issued ops (creating causal dependencies), otherwise it
 * acts concurrently. Wall-clock stamps are deliberately skewed.
 */
function generate(seed: number, actors: string[], opCount: number): Scenario {
  const rand = rng(seed);
  const stores = new Map(actors.map((a) => [a, new PermissionStore(a)]));
  const perms = ['p1', 'p2', 'p3'];
  const issued: Operation[] = [];
  for (let i = 0; i < opCount; i++) {
    const actor = actors[Math.floor(rand() * actors.length)]!;
    const store = stores.get(actor)!;
    // Random causal catch-up from other actors' already-issued ops.
    for (const op of shuffle(issued, rand)) {
      if (rand() < 0.35) store.apply(op);
    }
    const perm = perms[Math.floor(rand() * perms.length)]!;
    // Skewed wall clock: random, unrelated to causality.
    const wallClockMs = Math.floor(rand() * 1_000_000);
    const op = rand() < 0.5 ? store.grant(perm, wallClockMs) : store.revoke(perm, wallClockMs);
    issued.push(op);
  }
  return { ops: issued, perms };
}

function effectiveOf(store: PermissionStore): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [perm, eff] of store.effective()) {
    out.set(perm, eff.sources.map((s) => s.opId).sort());
  }
  return out;
}

test('random histories: out-of-order delivery matches the partial-order model', () => {
  const actors = ['A', 'B', 'C', 'D'];
  for (let seed = 1; seed <= 200; seed++) {
    const { ops } = generate(seed, actors, 30);
    const rand = rng(seed * 7919);

    // Deliver the same op set in several random orders, with duplicates.
    const receivers: PermissionStore[] = [];
    for (let r = 0; r < 4; r++) {
      const store = new PermissionStore(`R${r}`);
      const delivery = shuffle(ops, rand).flatMap((op) => (rand() < 0.2 ? [op, op] : [op]));
      for (const op of delivery) store.apply(op);
      receivers.push(store);
    }

    const expected = modelEffective(ops);
    for (const store of receivers) {
      assert.deepEqual(
        effectiveOf(store),
        expected,
        `seed=${seed}: store result must equal partial-order maximal model`,
      );
    }
    // All delivery orders converge.
    const descriptions = receivers.map((s) => s.describe());
    for (const d of descriptions) assert.equal(d, descriptions[0]);
  }
});

test('random histories: pairwise state merge converges to the model', () => {
  const actors = ['A', 'B', 'C'];
  for (let seed = 1000; seed <= 1050; seed++) {
    const { ops } = generate(seed, actors, 25);
    const rand = rng(seed * 31);

    // Partition ops arbitrarily across three replicas (as if each saw a
    // different subset), then merge until converged.
    const replicas = [new PermissionStore('X'), new PermissionStore('Y'), new PermissionStore('Z')];
    for (const op of shuffle(ops, rand)) {
      replicas[Math.floor(rand() * replicas.length)]!.apply(op);
    }
    for (let round = 0; round < 3; round++) {
      for (const a of replicas) for (const b of replicas) if (a !== b) a.mergeFrom(b);
    }
    const expected = modelEffective(ops);
    for (const replica of replicas) {
      assert.deepEqual(effectiveOf(replica), expected, `seed=${seed}: merge must converge to model`);
    }
  }
});

test('model sanity: hand-built remove-wins and restore cases', () => {
  const a = new PermissionStore('A');
  const b = new PermissionStore('B');
  const g1 = a.grant('p');
  const r1 = b.revoke('p'); // concurrent -> kills g1
  a.apply(r1);
  const g2 = a.grant('p'); // causally after r1 -> restores
  const ops = [g1, r1, g2];
  assert.deepEqual(modelEffective(ops), new Map([['p', [g2.id]]]));
});
