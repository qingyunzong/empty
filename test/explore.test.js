'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { validatePlan, PlanError } = require('../src/plan');
const { explore } = require('../src/explore');
const { applyStep } = require('../src/transitions');
const { initialState } = require('../src/explore');
const { coreOf } = require('../src/state');
const { enumerate } = require('../test-utils/crosscheck');
const { runCli } = require('../test-utils/run-cli');

function planFile(plan) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-'));
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  return file;
}

const SAFE_PLAN = {
  accounts: { A: 100, B: 0, C: 0 },
  actors: {
    p1: [
      { type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 30 },
      { type: 'commit', id: 't1' },
    ],
    p2: [
      { type: 'reserve', id: 't2', from: 'A', to: 'C', amount: 20 },
      { type: 'commit', id: 't2' },
    ],
  },
};

const UNSAFE_PLAN = {
  accounts: { A: 100, B: 0, C: 0 },
  actors: {
    a: [
      { type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 80 },
      { type: 'cancel', id: 't1' },
    ],
    b: [{ type: 'reserve', id: 't2', from: 'A', to: 'C', amount: 60 }],
    c: [{ type: 'freeze', account: 'A' }],
  },
};

test('acceptance 1: three accounts, two legal transfers, all interleavings safe', () => {
  const result = explore(validatePlan(SAFE_PLAN));
  assert.equal(result.violating, 0);
  assert.equal(result.counterexample, null);
  assert.ok(result.certificate);
  assert.equal(typeof result.certificate.finalStatesHash, 'string');
  assert.equal(result.certificate.finalStatesHash.length, 64);
  assert.equal(result.certificate.initialTotal, 100);
  assert.ok(result.reachable > 1);

  const cli = runCli(['explore', planFile(SAFE_PLAN)]);
  assert.equal(cli.status, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  console.log('CLI output (safe plan):\n' + cli.stdout);
  assert.equal(output.violating, 0);
  assert.equal(output.reachable, result.reachable);
  assert.ok(output.certificate.finalStatesHash);
});

test('acceptance 2: freeze/cancel race plan exposes over-freeze with minimal counterexample', () => {
  const result = explore(validatePlan(UNSAFE_PLAN));
  assert.ok(result.violating > 0);
  assert.equal(result.certificate, null);
  assert.deepEqual(result.counterexample.sequence, ['a#0', 'b#0']);
  assert.ok(
    result.counterexample.violations.some((v) => v.type === 'HOLD_EXCEEDS_BALANCE' && v.account === 'A'),
  );
  assert.equal(result.counterexample.state.frozen.A, 140);
  assert.equal(result.counterexample.state.balances.A, 100);

  const cli = runCli(['explore', planFile(UNSAFE_PLAN)]);
  assert.equal(cli.status, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  console.log('CLI output (unsafe plan):\n' + cli.stdout);
  assert.deepEqual(output.counterexample.sequence, ['a#0', 'b#0']);
  assert.ok(output.violating > 0);
});

test('acceptance 3: invalid plans are rejected with exit 1 and INVALID_PLAN', () => {
  const invalidPlans = {
    'duplicate cancel': {
      accounts: { A: 100, B: 0 },
      actors: {
        a: [
          { type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 10 },
          { type: 'cancel', id: 't1' },
          { type: 'cancel', id: 't1' },
        ],
      },
    },
    'unknown step id': {
      accounts: { A: 100, B: 0 },
      actors: { a: [{ type: 'commit', id: 'nope' }] },
    },
    'duplicate transfer id': {
      accounts: { A: 100, B: 0 },
      actors: {
        a: [{ type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 10 }],
        b: [{ type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 5 }],
      },
    },
    'negative amount': {
      accounts: { A: 100, B: 0 },
      actors: { a: [{ type: 'reserve', id: 't1', from: 'A', to: 'B', amount: -5 }] },
    },
    'cancel before commit in program order': {
      accounts: { A: 100, B: 0 },
      actors: {
        a: [
          { type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 10 },
          { type: 'cancel', id: 't1' },
          { type: 'commit', id: 't1' },
        ],
      },
    },
    'unknown account': {
      accounts: { A: 100 },
      actors: { a: [{ type: 'reserve', id: 't1', from: 'A', to: 'ZZZ', amount: 1 }] },
    },
  };
  for (const [name, plan] of Object.entries(invalidPlans)) {
    const cli = runCli(['explore', planFile(plan)]);
    assert.equal(cli.status, 1, `${name}: expected exit 1, got ${cli.status}`);
    assert.equal(cli.stdout.trim(), JSON.stringify({ error: 'INVALID_PLAN' }), name);
    console.log(`CLI output (invalid: ${name}): ${cli.stdout.trim()} (exit ${cli.status})`);
  }
});

test('invalid plan leaves state untouched: validation throws before any exploration', () => {
  const bad = {
    accounts: { A: 100, B: 0 },
    actors: { a: [{ type: 'cancel', id: 'ghost' }] },
  };
  assert.throws(() => validatePlan(bad), PlanError);
  const norm = validatePlan(SAFE_PLAN);
  const before = JSON.stringify(coreOf(initialState(norm)));
  assert.throws(() => validatePlan(bad), PlanError);
  assert.equal(JSON.stringify(coreOf(initialState(norm))), before);
});

test('business-rejected steps only append a rejected record and never mutate accounts', () => {
  const norm = validatePlan({
    accounts: { A: 100, B: 0 },
    actors: {
      a: [
        { type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 40 },
        { type: 'commit', id: 't1' },
        { type: 'cancel', id: 't1' },
      ],
    },
  });
  let state = initialState(norm);
  state = applyStep(state, norm.actors[0].steps[0], 'a#0').state;
  state = applyStep(state, norm.actors[0].steps[1], 'a#1').state;
  const beforeReject = coreOf(state);
  const { state: after, rejected } = applyStep(state, norm.actors[0].steps[2], 'a#2');
  assert.equal(rejected, 'NOT_PENDING');
  assert.deepEqual(coreOf(after), beforeReject);
  assert.equal(after.rejected.length, 1);
  assert.equal(after.rejected[0].reason, 'NOT_PENDING');

  const frozen = applyStep(state, { type: 'freeze', account: 'A' }, 'x#0').state;
  const reserveAttempt = applyStep(
    frozen,
    { type: 'reserve', id: 't9', from: 'A', to: 'B', amount: 1 },
    'x#1',
  );
  assert.equal(reserveAttempt.rejected, 'ACCOUNT_FROZEN');
  assert.deepEqual(coreOf(reserveAttempt.state), coreOf(frozen));
});

test('cross-check: explorer matches independent enumerator for all <=4-step plans', () => {
  const plans = [
    SAFE_PLAN,
    UNSAFE_PLAN,
    {
      accounts: { A: 50, B: 10 },
      actors: {
        a: [{ type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 40 }],
        b: [{ type: 'freeze', account: 'A' }],
        c: [{ type: 'reserve', id: 't2', from: 'A', to: 'B', amount: 30 }],
      },
    },
    {
      accounts: { A: 10, B: 0 },
      actors: {
        a: [
          { type: 'reserve', id: 't1', from: 'A', to: 'B', amount: 6 },
          { type: 'commit', id: 't1' },
        ],
        b: [
          { type: 'reserve', id: 't2', from: 'A', to: 'B', amount: 6 },
          { type: 'cancel', id: 't2' },
        ],
      },
    },
    {
      accounts: { A: 5, B: 5 },
      freeze: ['B'],
      actors: {
        a: [{ type: 'reserve', id: 't1', from: 'B', to: 'A', amount: 1 }],
        b: [{ type: 'reserve', id: 't2', from: 'A', to: 'B', amount: 9 }],
      },
    },
  ];
  // Deterministic pseudo-random small plans (<= 4 steps each).
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 40; i++) {
    const actorCount = 1 + Math.floor(rand() * 3);
    const actors = {};
    let stepsLeft = 2 + Math.floor(rand() * 3);
    let tid = 0;
    for (let a = 0; a < actorCount; a++) {
      const steps = [];
      const n = Math.min(stepsLeft, 1 + Math.floor(rand() * 2));
      for (let s = 0; s < n; s++) {
        const r = rand();
        if (r < 0.5) {
          steps.push({
            type: 'reserve',
            id: `r${tid++}`,
            from: rand() < 0.5 ? 'A' : 'B',
            to: 'C',
            amount: Math.floor(rand() * 30),
          });
        } else if (r < 0.75) {
          steps.push({ type: 'freeze', account: rand() < 0.5 ? 'A' : 'B' });
        } else if (stepsLeft - steps.length >= 2) {
          steps.push({ type: 'reserve', id: `r${tid}`, from: 'A', to: 'C', amount: Math.floor(rand() * 20) });
          steps.push({ type: rand() < 0.5 ? 'commit' : 'cancel', id: `r${tid}` });
          tid++;
          s++;
        } else {
          steps.push({ type: 'freeze', account: 'A' });
        }
      }
      actors[`actor${a}`] = steps;
      stepsLeft -= steps.length;
      if (stepsLeft <= 0) break;
    }
    plans.push({ accounts: { A: 25, B: 15, C: 0 }, actors });
  }

  for (const plan of plans) {
    const totalSteps = plan.actors
      ? Object.values(plan.actors).reduce((n, steps) => n + steps.length, 0)
      : 0;
    assert.ok(totalSteps <= 4, `cross-check plan has ${totalSteps} steps`);
    let norm;
    try {
      norm = validatePlan(plan);
    } catch {
      continue; // randomly generated invalid plans are out of scope here
    }
    const expected = enumerate(norm);
    const actual = explore(norm);
    assert.equal(actual.reachable, expected.reachable, 'reachable mismatch');
    assert.equal(actual.violating > 0, expected.sawViolation, 'violation mismatch');
    assert.deepEqual(actual.terminals, expected.terminals, 'terminal states mismatch');
    if (expected.sawViolation) {
      assert.deepEqual(actual.counterexample.sequence, expected.minViolatingPrefix);
    } else {
      assert.equal(actual.counterexample, null);
      assert.ok(actual.certificate.finalStatesHash);
    }
  }
});

test('cli: usage errors exit with code 2', () => {
  const noArgs = runCli([]);
  assert.equal(noArgs.status, 2);
  const missing = runCli(['explore', '/nonexistent/plan.json']);
  assert.equal(missing.status, 2);
});

test('cli: malformed JSON is an invalid plan', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-'));
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, '{ not json');
  const cli = runCli(['explore', file]);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout.trim(), JSON.stringify({ error: 'INVALID_PLAN' }));
});

test('example plans on disk match library results', () => {
  for (const name of ['safe.json', 'unsafe.json']) {
    const plan = JSON.parse(readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8'));
    const cli = runCli(['explore', path.join(__dirname, '..', 'examples', name)]);
    assert.equal(cli.status, 0, `${name}: ${cli.stderr}`);
    const output = JSON.parse(cli.stdout);
    const expected = explore(validatePlan(plan));
    assert.equal(output.reachable, expected.reachable);
    assert.equal(output.violating, expected.violating);
  }
  const invalid = runCli(['explore', path.join(__dirname, '..', 'examples', 'invalid-duplicate-cancel.json')]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout.trim(), JSON.stringify({ error: 'INVALID_PLAN' }));
});
