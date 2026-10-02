import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRun, initialAccounts } from '../src/fuzz.js';
import { enumerateInterleavings } from '../src/enumerator.js';
import { stateHash } from '../src/stable-json.js';

// For plans of <= 4 steps, cross-check the Ledger against an independent
// reference model driven over every interleaving of the plan's ops.
for (const seed of [0, 1, 2, 3, 42, 1337]) {
  for (let steps = 1; steps <= 4; steps++) {
    test(`seed=${seed} steps=${steps}: engine matches reference enumerator`, () => {
      const run = generateRun({ seed, steps, accounts: 2 });
      const plan = run.ops.map((o) => o.op);
      const { canonicalHash, reachable } = enumerateInterleavings(
        { accounts: initialAccounts(2) },
        plan,
      );
      // Canonical order (the order the engine executed) must match exactly.
      assert.equal(canonicalHash, run.stateHash);
      // And the engine's final state must be a reachable interleaving outcome.
      assert.ok(reachable.has(run.stateHash));
      assert.ok(reachable.size >= 1);
    });
  }
}

test('enumerator explores distinct interleavings', () => {
  const plan = [
    { type: 'reserve', account: 'A0', amount: 10 },
    { type: 'reserve', account: 'A0', amount: 20 },
    { type: 'settle', holdId: 'H0' },
    { type: 'cancel', holdId: 'H1' },
  ];
  const { reachable } = enumerateInterleavings({ accounts: initialAccounts(1) }, plan);
  // settle/cancel target fixed hold ids, so reordering changes which hold
  // exists when they run: more than one reachable final state.
  assert.ok(reachable.size > 1);
});

test('enumerator rejects plans longer than 4 steps', () => {
  assert.throws(
    () => enumerateInterleavings({ accounts: initialAccounts(1) }, Array(5).fill({ type: 'reserve', account: 'A0', amount: 1 })),
    /at most 4/,
  );
});

test('stateHash is key-order independent', () => {
  const a = stateHash({ x: 1, y: [2, 3] });
  const b = stateHash({ y: [2, 3], x: 1 });
  assert.equal(a, b);
});
