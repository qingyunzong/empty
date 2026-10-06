import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { PermissionStore } from '../src/permissionStore.js';
import type { PermissionOp } from '../src/op.js';
import { modelEffective } from './model.js';
import { mulberry32, normalized, shuffled } from './util.js';

const PERMS = ['repo:push', 'repo:pull', 'admin', 'docs:read', 'billing:edit'];
const REPLICAS = ['alice', 'bob', 'carol', 'dave'];

/**
 * Generate a random distributed scenario: replicas issue grants/revokes and
 * gossip operations to each other in arbitrary order, creating a mix of
 * causal chains and genuinely concurrent conflicts.
 */
function randomScenario(rng: () => number, steps: number): PermissionOp[] {
  const stores = new Map(REPLICAS.map((id) => [id, new PermissionStore(id)]));
  const allOps: PermissionOp[] = [];

  for (let i = 0; i < steps; i++) {
    // Gossip: deliver a few random already-issued ops to random replicas
    // (duplicates and reordering included — receive() must tolerate both).
    const deliveries = Math.floor(rng() * 4);
    for (let d = 0; d < deliveries && allOps.length > 0; d++) {
      const op = allOps[Math.floor(rng() * allOps.length)]!;
      const target = REPLICAS[Math.floor(rng() * REPLICAS.length)]!;
      stores.get(target)!.receive(op);
    }
    // A random replica issues a new operation on a random permission.
    const actor = REPLICAS[Math.floor(rng() * REPLICAS.length)]!;
    const perm = PERMS[Math.floor(rng() * PERMS.length)]!;
    const store = stores.get(actor)!;
    const op = rng() < 0.55 ? store.grant(perm) : store.revoke(perm);
    allOps.push(op);
  }
  return allOps;
}

test('randomized scenarios: store matches the partial-order maximal-op model under shuffled, out-of-order delivery', () => {
  const rng = mulberry32(20261006);
  const scenarios = 40;
  const shufflesPerScenario = 15;

  for (let scenario = 0; scenario < scenarios; scenario++) {
    const ops = randomScenario(rng, 30);
    const model = modelEffective(ops);

    for (let trial = 0; trial < shufflesPerScenario; trial++) {
      const replica = new PermissionStore(`check-${scenario}-${trial}`);
      for (const op of shuffled(ops, rng)) replica.receive(op); // arbitrary order, duplicates below
      if (trial % 3 === 0) {
        for (const op of shuffled(ops, rng)) replica.receive(op); // replay everything again
      }
      const actual = normalized(replica.effective());

      const expected: Record<string, unknown> = {};
      for (const [perm, entry] of model) expected[perm] = entry;
      deepEqual(actual, expected, `scenario ${scenario} trial ${trial}`);
    }
  }
});

test('convergence: replicas that gossip pairwise all reach the model state', () => {
  const rng = mulberry32(7);
  const ops = randomScenario(rng, 60);
  const model = modelEffective(ops);
  const expected: Record<string, unknown> = {};
  for (const [perm, entry] of model) expected[perm] = entry;

  // Full anti-entropy: every replica eventually receives every op, in a
  // different random order per replica.
  for (const id of REPLICAS) {
    const replica = new PermissionStore(id);
    replica.merge(shuffled(ops, rng));
    deepEqual(normalized(replica.effective()), expected, `replica ${id}`);
  }
});

test('causal versions are preserved: every op carries a vector clock and the store version is the join', () => {
  const alice = new PermissionStore('alice');
  const bob = new PermissionStore('bob');
  const g = alice.grant('p');
  bob.receive(g);
  const r = bob.revoke('p');
  alice.receive(r);

  // bob's revoke causally includes alice's grant — no wall clock involved.
  deepEqual(r.clock, { alice: 1, bob: 1 });
  deepEqual(alice.version(), { alice: 1, bob: 1 });
  equal(alice.effectiveFor('p')?.granted, false);
});
