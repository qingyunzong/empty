import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, canonicalCommand } from '../src/ledger.js';
import { shrinkPlan, findMinimalCounterexample, compareCanonicalSequences } from '../src/shrink.js';

function bruteForceMinimal(commands, limits) {
  const n = commands.length;
  let best = null;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const sub = [];
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) sub.push(commands[i]);
    }
    let result;
    try {
      result = runBatch(sub, limits);
    } catch {
      continue;
    }
    if (result.ok) continue;
    const key = sub.map(canonicalCommand);
    if (
      best === null ||
      key.length < best.key.length ||
      (key.length === best.key.length && compareCanonicalSequences(key, best.key) < 0)
    ) {
      best = { key, sub };
    }
  }
  return best;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPlan(rand) {
  const accounts = ['A', 'B'];
  const limits = { A: 50 + Math.floor(rand() * 100), B: 50 + Math.floor(rand() * 100) };
  const length = 4 + Math.floor(rand() * 3);
  const commands = [];
  const openPosts = [];
  let nextId = 0;
  for (let i = 0; i < length; i += 1) {
    const roll = rand();
    const account = accounts[Math.floor(rand() * accounts.length)];
    if (roll < 0.45) {
      const id = `p${nextId}`;
      nextId += 1;
      commands.push({ op: 'post', id, account, amount: 1 + Math.floor(rand() * 120) });
      openPosts.push(id);
    } else if (roll < 0.7 && openPosts.length > 0) {
      const idx = Math.floor(rand() * openPosts.length);
      commands.push({ op: 'cancel', postId: openPosts.splice(idx, 1)[0] });
    } else {
      commands.push({ op: 'freeze', account, amount: 1 + Math.floor(rand() * 120) });
    }
  }
  return { limits, commands };
}

test('acceptance 1: one over-limit freeze in a long sequence shrinks to the minimal culprit', () => {
  const plan = {
    limits: { A: 100 },
    commands: [
      { op: 'post', id: 'p1', account: 'B', amount: 10 },
      { op: 'post', id: 'p2', account: 'B', amount: 25 },
      { op: 'freeze', account: 'B', amount: 5 },
      { op: 'cancel', postId: 'p1' },
      { op: 'post', id: 'p3', account: 'C', amount: 40 },
      { op: 'freeze', account: 'A', amount: 150 },
      { op: 'post', id: 'p4', account: 'B', amount: 8 },
      { op: 'cancel', postId: 'p2' },
      { op: 'freeze', account: 'C', amount: 12 },
    ],
  };
  const out = shrinkPlan(plan);
  assert.equal(out.status, 'UNSAFE');
  assert.deepEqual(out.counterexample, [{ op: 'freeze', account: 'A', amount: 150 }]);
  assert.equal(out.removed.length, plan.commands.length - 1);
  assert.equal(out.violations[0].invariant, 'NET_PLUS_FROZEN_WITHIN_LIMIT');
  assert.equal(out.finalState.accounts.A.frozen, 150);
  assert.match(out.replayHash, /^[0-9a-f]{64}$/);
});

test('acceptance 2: fully legal batch yields a certificate and single deletions stay safe', () => {
  const plan = {
    limits: { A: 1000, B: 500 },
    commands: [
      { op: 'post', id: 'p1', account: 'A', amount: 100 },
      { op: 'freeze', account: 'A', amount: 50 },
      { op: 'post', id: 'p2', account: 'B', amount: 80 },
      { op: 'cancel', postId: 'p1' },
      { op: 'post', id: 'p3', account: 'A', amount: 120 },
      { op: 'freeze', account: 'B', amount: 30 },
    ],
  };
  const out = shrinkPlan(plan);
  assert.equal(out.status, 'SAFE');
  assert.deepEqual(out.certificate.invariants, [
    'NET_PLUS_FROZEN_WITHIN_LIMIT',
    'CORRECTION_OPPOSITE_SIGN',
    'VOLUME_REPLAYABLE',
  ]);
  assert.equal(out.certificate.commandsChecked, plan.commands.length);
  assert.equal(out.certificate.replayHash, out.replayHash);
  for (let i = 0; i < plan.commands.length; i += 1) {
    const reduced = plan.commands.filter((_, j) => j !== i);
    let result;
    try {
      result = runBatch(reduced, plan.limits);
    } catch {
      continue;
    }
    assert.equal(result.ok, true, `removing command #${i} must not change the SAFE conclusion`);
  }
});

test('equal-length counterexamples are tie-broken by lexicographic order', () => {
  const plan = {
    limits: { A: 10 },
    commands: [
      { op: 'freeze', account: 'A', amount: 30 },
      { op: 'freeze', account: 'A', amount: 20 },
    ],
  };
  const out = shrinkPlan(plan);
  assert.equal(out.status, 'UNSAFE');
  assert.deepEqual(out.counterexampleCanonical, ['freeze(account=A,amount=20)']);
});

test('cancel-dependent counterexample keeps the post it corrects', () => {
  const plan = {
    limits: { A: 100 },
    commands: [
      { op: 'post', id: 'p1', account: 'A', amount: 60 },
      { op: 'freeze', account: 'A', amount: 30 },
      { op: 'cancel', postId: 'p1' },
      { op: 'post', id: 'p2', account: 'A', amount: 60 },
      { op: 'freeze', account: 'A', amount: 50 },
    ],
  };
  const out = shrinkPlan(plan);
  assert.equal(out.status, 'UNSAFE');
  const brute = bruteForceMinimal(plan.commands, plan.limits);
  assert.deepEqual(out.counterexampleCanonical, brute.key);
});

test('acceptance 4: minimality verified by independent subset enumeration for <=6 commands', () => {
  const handcrafted = [
    {
      limits: { A: 10 },
      commands: [
        { op: 'post', id: 'p1', account: 'A', amount: 5 },
        { op: 'freeze', account: 'A', amount: 6 },
        { op: 'cancel', postId: 'p1' },
        { op: 'freeze', account: 'A', amount: 20 },
      ],
    },
    {
      limits: { A: 15, B: 15 },
      commands: [
        { op: 'post', id: 'p1', account: 'A', amount: 10 },
        { op: 'post', id: 'p2', account: 'B', amount: 10 },
        { op: 'freeze', account: 'A', amount: 10 },
        { op: 'cancel', postId: 'p1' },
        { op: 'freeze', account: 'B', amount: 10 },
        { op: 'post', id: 'p3', account: 'A', amount: 4 },
      ],
    },
    {
      limits: { A: 100 },
      commands: [
        { op: 'post', id: 'p1', account: 'A', amount: 40 },
        { op: 'cancel', postId: 'p1' },
        { op: 'freeze', account: 'A', amount: 10 },
      ],
    },
  ];
  const rand = mulberry32(20261003);
  const plans = [...handcrafted];
  while (plans.length < 30) {
    const plan = randomPlan(rand);
    if (plan.commands.length > 6) continue;
    try {
      runBatch(plan.commands, plan.limits);
    } catch {
      continue;
    }
    plans.push(plan);
  }
  for (const plan of plans) {
    assert.ok(plan.commands.length <= 6);
    const brute = bruteForceMinimal(plan.commands, plan.limits);
    const out = shrinkPlan(plan);
    if (brute === null) {
      assert.equal(out.status, 'SAFE');
    } else {
      assert.equal(out.status, 'UNSAFE');
      assert.deepEqual(
        out.counterexampleCanonical,
        brute.key,
        `mismatch for ${JSON.stringify(plan)}`,
      );
    }
  }
});

test('findMinimalCounterexample returns the shortest failing subsequence', () => {
  const commands = [
    { op: 'post', id: 'p1', account: 'A', amount: 10 },
    { op: 'post', id: 'p2', account: 'A', amount: 10 },
    { op: 'freeze', account: 'A', amount: 5 },
  ];
  const best = findMinimalCounterexample(commands, { A: 14 });
  assert.equal(best.sub.length, 2);
  assert.deepEqual(best.key, ['post(id=p1,account=A,amount=10)', 'freeze(account=A,amount=5)']);
});
