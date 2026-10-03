import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan } from '../src/plan.js';
import { explore } from '../src/explore.js';
import { applyStep, hashState, initialState } from '../src/state.js';
import { allInterleavings, compareSequences, replay, stepById } from './helpers.mjs';

// Acceptance 1: three accounts, two legal two-phase transfers.
const safePlan = normalizePlan({
  accounts: [
    { id: 'A', balance: 1000 },
    { id: 'B', balance: 0 },
    { id: 'C', balance: 0 },
  ],
  actors: [
    {
      id: 'alice',
      steps: [
        { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 100 },
        { id: 'c1', type: 'commit', transfer: 't1' },
      ],
    },
    {
      id: 'bob',
      steps: [
        { id: 'r2', type: 'reserve', transfer: 't2', from: 'A', to: 'C', amount: 50 },
        { id: 'c2', type: 'commit', transfer: 't2' },
      ],
    },
  ],
});

// Acceptance 2: account freeze and a cancel/commit race around an over-freeze.
const racyPlan = normalizePlan({
  accounts: [
    { id: 'A', balance: 100 },
    { id: 'B', balance: 0 },
    { id: 'C', balance: 0 },
  ],
  actors: [
    {
      id: 'alice',
      steps: [
        { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 60 },
        { id: 'c1', type: 'commit', transfer: 't1' },
      ],
    },
    {
      id: 'carol',
      steps: [
        { id: 'r2', type: 'reserve', transfer: 't2', from: 'A', to: 'C', amount: 60 },
        { id: 'c2', type: 'commit', transfer: 't2' },
      ],
    },
    { id: 'dave', steps: [{ id: 'x1', type: 'cancel', transfer: 't1' }] },
  ],
  freeze: [{ id: 'f1', account: 'A' }],
});

test('acceptance 1: all interleavings of two legal transfers are safe', () => {
  const result = explore(safePlan);
  assert.equal(result.violating, 0);
  assert.equal(result.violatingStates, 0);
  assert.equal(result.counterexample, null);
  assert.equal(result.interleavings, 6);
  assert.ok(result.certificate);
  assert.equal(result.certificate.type, 'SAFE_CERTIFICATE');
  assert.equal(result.certificate.hashAlgorithm, 'sha256');
  assert.equal(result.certificate.terminalStates, 1);

  const terminal = initialState(safePlan);
  for (const id of ['r1', 'c1', 'r2', 'c2']) {
    applyStep(terminal, stepById(safePlan, id));
  }
  assert.deepEqual(terminal.balances, { A: 850, B: 100, C: 50 });
  assert.equal(result.certificate.finalStateHash, hashState(terminal));

  // The certificate is reproducible: exploring again yields the same hash.
  assert.deepEqual(explore(safePlan).certificate, result.certificate);
});

test('acceptance 2: freeze and cancel race exposes over-freezing with minimal counterexample', () => {
  const result = explore(racyPlan);
  assert.ok(result.violating > 0);
  assert.ok(result.violatingStates > 0);
  assert.equal(result.certificate, null);

  // Independent check: enumerate every interleaving by brute force, replay
  // each one, and derive the minimal violating prefix ourselves.
  const sequences = allInterleavings(racyPlan);
  assert.equal(result.interleavings, sequences.length);
  const violatingPrefixes = [];
  let violatingCount = 0;
  for (const sequence of sequences) {
    const { violated, firstViolationAt } = replay(racyPlan, sequence);
    if (violated) {
      violatingCount += 1;
      violatingPrefixes.push(sequence.slice(0, firstViolationAt + 1));
    }
  }
  violatingPrefixes.sort(compareSequences);
  assert.equal(result.violating, violatingCount);
  assert.deepEqual(result.counterexample.sequence, violatingPrefixes[0]);
  assert.deepEqual(result.counterexample.sequence, ['r1', 'r2']);

  const overHold = result.counterexample.violations.find((v) => v.type === 'HOLD_EXCEEDS_AVAILABLE');
  assert.ok(overHold);
  assert.equal(overHold.account, 'A');
  assert.equal(overHold.frozen, 120);
  assert.equal(overHold.balance, 100);
});

test('explorer matches the independent enumerator for plans with <= 4 steps', () => {
  const rawPlans = [
    {
      name: 'single transfer reserve+cancel',
      plan: {
        accounts: [
          { id: 'A', balance: 10 },
          { id: 'B', balance: 0 },
        ],
        actors: [
          {
            id: 'a',
            steps: [
              { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 4 },
              { id: 'x1', type: 'cancel', transfer: 't1' },
            ],
          },
        ],
      },
    },
    {
      name: 'cancel racing a commit across actors',
      plan: {
        accounts: [
          { id: 'A', balance: 10 },
          { id: 'B', balance: 0 },
        ],
        actors: [
          {
            id: 'a',
            steps: [
              { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 4 },
              { id: 'c1', type: 'commit', transfer: 't1' },
            ],
          },
          { id: 'b', steps: [{ id: 'x1', type: 'cancel', transfer: 't1' }] },
        ],
      },
    },
    {
      name: 'freeze racing a reserve',
      plan: {
        accounts: [
          { id: 'A', balance: 10 },
          { id: 'B', balance: 0 },
        ],
        actors: [
          { id: 'a', steps: [{ id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 4 }] },
        ],
        freeze: [{ id: 'f1', account: 'A' }],
      },
    },
    {
      name: 'two reserves that can over-freeze',
      plan: {
        accounts: [
          { id: 'A', balance: 100 },
          { id: 'B', balance: 0 },
          { id: 'C', balance: 0 },
        ],
        actors: [
          { id: 'a', steps: [{ id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 60 }] },
          { id: 'b', steps: [{ id: 'r2', type: 'reserve', transfer: 't2', from: 'A', to: 'C', amount: 60 }] },
        ],
      },
    },
    {
      name: 'insufficient funds rejection',
      plan: {
        accounts: [
          { id: 'A', balance: 5 },
          { id: 'B', balance: 0 },
        ],
        actors: [
          { id: 'a', steps: [{ id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 60 }] },
          { id: 'b', steps: [{ id: 'r2', type: 'reserve', transfer: 't2', from: 'A', to: 'B', amount: 3 }] },
        ],
      },
    },
  ];

  for (const { name, plan: raw } of rawPlans) {
    const plan = normalizePlan(raw);
    assert.ok(
      plan.actors.reduce((n, actor) => n + actor.steps.length, 0) <= 4,
      `${name}: fixture must have <= 4 steps`,
    );
    const result = explore(plan);
    const sequences = allInterleavings(plan);
    assert.equal(result.interleavings, sequences.length, `${name}: interleaving count`);

    let violating = 0;
    const terminalHashes = new Set();
    for (const sequence of sequences) {
      const { state, violated } = replay(plan, sequence);
      if (violated) violating += 1;
      terminalHashes.add(hashState(state));
    }
    assert.equal(result.violating, violating, `${name}: violating count`);
    if (violating === 0) {
      assert.deepEqual(result.certificate.finalStateHashes, [...terminalHashes].sort(), `${name}: terminal hashes`);
    } else {
      assert.equal(result.certificate, null, `${name}: no certificate when violating`);
    }
  }
});

test('safe certificate covers multi-terminal plans (freeze race)', () => {
  const plan = normalizePlan({
    accounts: [
      { id: 'A', balance: 10 },
      { id: 'B', balance: 0 },
    ],
    actors: [
      { id: 'a', steps: [{ id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 4 }] },
    ],
    freeze: [{ id: 'f1', account: 'A' }],
  });
  const result = explore(plan);
  assert.equal(result.violating, 0);
  // r1-before-f1 freezes quota; f1-before-r1 rejects the reserve.
  assert.equal(result.certificate.terminalStates, 2);
  assert.equal(result.certificate.finalStateHashes.length, 2);
  assert.match(result.certificate.finalStateHash, /^[0-9a-f]{64}$/);
});
