'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { InputError, validateInput } = require('../lib/model');
const { solve, enumerateValidPlans, planValid, computeFreezes, availableLimits } = require('../lib/solver');
const { main } = require('../lib/cli');

const planEquals = (a, b) => {
  const lookupA = a instanceof Map ? (id) => a.get(id) : (id) => a[id];
  const lookupB = b instanceof Map ? (id) => b.get(id) : (id) => b[id];
  const ids = new Set([...Object.keys(a instanceof Map ? Object.fromEntries(a) : a), ...Object.keys(b instanceof Map ? Object.fromEntries(b) : b)]);
  for (const id of ids) {
    if (lookupA(id) !== lookupB(id)) return false;
  }
  return true;
};

test('acceptance 1: three-account feasible netting', () => {
  const input = {
    accounts: [
      { id: 'A', limit: 100 },
      { id: 'B', limit: 100 },
      { id: 'C', limit: 40 },
    ],
    instructions: [
      { id: 'p1', from: 'A', to: 'B', amount: 100 },
      { id: 'p2', from: 'B', to: 'A', amount: 60 },
      { id: 'p3', from: 'B', to: 'C', amount: 50 },
      { id: 'p4', from: 'C', to: 'B', amount: 40 },
      { id: 'p5', from: 'A', to: 'C', amount: 30 },
    ],
    budget: 10000,
  };
  const valid = validateInput(input);
  const result = solve(valid);
  assert.equal(result.status, 'SAT');

  // Plan must be one of the exhaustively enumerated valid plans.
  const validPlans = enumerateValidPlans(valid);
  assert.ok(validPlans.length > 0);
  assert.ok(validPlans.some((candidate) => planEquals(candidate, result.plan)));

  // Netting actually used between bidirectional instructions.
  assert.ok(Object.values(result.plan).includes('NET'));

  // Freezes respect account limits.
  const limits = { A: 100, B: 100, C: 40 };
  for (const [id, total] of Object.entries(result.freezeTotals)) {
    assert.ok(total <= limits[id], `freeze ${total} exceeds limit for ${id}`);
  }

  // Certificate fields present.
  assert.ok(Array.isArray(result.certificate.decisions));
  assert.ok(result.certificate.domains.p1.length >= 1);
  assert.equal(typeof result.certificate.backtracks, 'number');
  assert.deepEqual(result.certificate.revocationOrder, []);
});

test('acceptance 2: revocation incrementally corrects the previous plan', () => {
  const base = {
    accounts: [
      { id: 'A', limit: 100 },
      { id: 'B', limit: 100 },
    ],
    instructions: [
      { id: 'p1', from: 'A', to: 'B', amount: 80 },
      { id: 'p2', from: 'B', to: 'A', amount: 50 },
    ],
    budget: 10000,
  };
  const before = solve(validateInput(base));
  assert.equal(before.status, 'SAT');
  assert.notEqual(before.plan.p1, 'SUSPEND');

  // Prior freezes recorded, then both instructions revoked at different times.
  const corrected = solve(
    validateInput({
      accounts: base.accounts,
      instructions: [
        { id: 'p1', from: 'A', to: 'B', amount: 80, frozen: 80 },
        { id: 'p2', from: 'B', to: 'A', amount: 50, frozen: 50 },
      ],
      revocations: [
        { id: 'r1', instruction: 'p1', time: '2026-01-01T00:00:00Z' },
        { id: 'r2', instruction: 'p2', time: '2026-01-02T00:00:00Z' },
      ],
      budget: 10000,
    }),
  );
  assert.equal(corrected.status, 'SAT');
  assert.equal(corrected.plan.p1, 'SUSPEND');
  assert.equal(corrected.plan.p2, 'SUSPEND');
  assert.deepEqual(corrected.freezeTotals, { A: 0, B: 0 });

  // Revoked instructions must not produce new freezes and must state reasons.
  const suspended = new Map(corrected.suspended.map((entry) => [entry.id, entry.reasons]));
  assert.ok(suspended.get('p1').includes('revoked'));
  assert.ok(suspended.get('p2').includes('revoked'));

  // Revocations release original freezes in reverse chronological order.
  assert.deepEqual(
    corrected.certificate.revocationOrder.map((entry) => [entry.seq, entry.id]),
    [
      [1, 'r2'],
      [2, 'r1'],
    ],
  );

  // Without revocations the recorded prior freezes constrain the new plan.
  const constrained = solve(
    validateInput({
      accounts: base.accounts,
      instructions: [
        { id: 'p1', from: 'A', to: 'B', amount: 80, frozen: 80 },
        { id: 'p2', from: 'B', to: 'A', amount: 50, frozen: 50 },
      ],
      budget: 10000,
    }),
  );
  assert.equal(constrained.status, 'SAT');
  assert.equal(constrained.plan.p1, 'SUSPEND');
  assert.ok(constrained.suspended.find((entry) => entry.id === 'p1').reasons.includes('insufficient_limit'));
  assert.equal(constrained.freezeTotals.B, 50);
});

test('acceptance 3: small budget yields PENDING with conflict, never UNSAT', () => {
  const make = (budget) => ({
    accounts: [
      { id: 'A', limit: 5 },
      { id: 'B', limit: 200 },
    ],
    instructions: [
      { id: 'i1', from: 'A', to: 'B', amount: 100 },
      { id: 'i2', from: 'B', to: 'A', amount: 100 },
      { id: 'i3', from: 'A', to: 'B', amount: 10 },
    ],
    budget,
  });

  const pending = solve(validateInput(make(0)));
  assert.equal(pending.status, 'PENDING');
  assert.notEqual(pending.status, 'UNSAT');
  assert.equal(pending.plan, null);
  assert.ok(pending.certificate.backtracks >= 1);
  assert.ok(pending.certificate.minConflictSet.length >= 1);

  const solved = solve(validateInput(make(50)));
  assert.equal(solved.status, 'SAT');
  assert.ok(solved.certificate.backtracks >= 1);
  assert.ok(planValid(validateInput(make(50)), solved.plan));
});

test('acceptance 4: illegal revocation fails validation', () => {
  const base = {
    accounts: [
      { id: 'A', limit: 10 },
      { id: 'B', limit: 10 },
    ],
    instructions: [{ id: 'p1', from: 'A', to: 'B', amount: 5 }],
  };
  assert.throws(
    () => validateInput({ ...base, revocations: [{ instruction: 'nope', time: '2026-01-01T00:00:00Z' }] }),
    InputError,
  );
  assert.throws(
    () =>
      validateInput({
        ...base,
        revocations: [
          { instruction: 'p1', time: '2026-01-01T00:00:00Z' },
          { instruction: 'p1', time: '2026-01-02T00:00:00Z' },
        ],
      }),
    InputError,
  );
  assert.throws(
    () => validateInput({ ...base, revocations: [{ instruction: 'p1', time: 'not-a-time' }] }),
    InputError,
  );
});

test('exhaustive cross-check: solver matches enumeration for <=3 accounts', () => {
  const accountSets = [
    [
      { id: 'A', limit: 50 },
      { id: 'B', limit: 50 },
    ],
    [
      { id: 'A', limit: 100 },
      { id: 'B', limit: 60 },
      { id: 'C', limit: 40 },
    ],
    [
      { id: 'A', limit: 0 },
      { id: 'B', limit: 30 },
      { id: 'C', limit: 80 },
    ],
  ];
  const instructionSets = [
    [
      { id: 'p1', from: 'A', to: 'B', amount: 40 },
      { id: 'p2', from: 'B', to: 'A', amount: 30 },
    ],
    [
      { id: 'p1', from: 'A', to: 'B', amount: 70 },
      { id: 'p2', from: 'B', to: 'A', amount: 20 },
      { id: 'p3', from: 'A', to: 'B', amount: 15 },
    ],
    [
      { id: 'p1', from: 'A', to: 'B', amount: 50 },
      { id: 'p2', from: 'B', to: 'C', amount: 50 },
      { id: 'p3', from: 'C', to: 'A', amount: 50 },
    ],
    [
      { id: 'p1', from: 'A', to: 'B', amount: 25 },
      { id: 'p2', from: 'B', to: 'A', amount: 25 },
      { id: 'p3', from: 'B', to: 'C', amount: 30 },
      { id: 'p4', from: 'C', to: 'B', amount: 10 },
    ],
    [
      { id: 'p1', from: 'A', to: 'B', amount: 45, frozen: 20 },
      { id: 'p2', from: 'B', to: 'A', amount: 35 },
      { id: 'p3', from: 'A', to: 'C', amount: 25 },
    ],
  ];
  const revocationSets = [
    [],
    [{ id: 'r1', instruction: 'p1', time: '2026-03-01T00:00:00Z' }],
  ];

  let checked = 0;
  for (const accounts of accountSets) {
    const ids = new Set(accounts.map((account) => account.id));
    for (const instructions of instructionSets) {
      if (!instructions.every((p) => ids.has(p.from) && ids.has(p.to))) continue;
      for (const revocations of revocationSets) {
        const valid = validateInput({ accounts, instructions, revocations, budget: 100000 });
        const result = solve(valid);
        const validPlans = enumerateValidPlans(valid);
        assert.notEqual(result.status, 'PENDING');
        assert.equal(result.status === 'SAT', validPlans.length > 0, `SAT mismatch for ${JSON.stringify({ accounts, instructions, revocations })}`);
        if (result.status === 'SAT') {
          assert.ok(validPlans.some((candidate) => planEquals(candidate, result.plan)));
          const available = availableLimits(valid);
          const totals = computeFreezes(valid, result.plan);
          for (const [id, total] of totals) {
            assert.ok(total <= available.get(id) + 1e-9);
          }
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 20, `expected broad coverage, got ${checked} cases`);
});

test('CLI: exit codes and output file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'output.json');
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  const run = () => main(['settle', inputPath, outputPath]);
  const finish = () => {
    console.error = originalError;
  };

  // SAT case: exit 0, output written.
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      accounts: [
        { id: 'A', limit: 100 },
        { id: 'B', limit: 100 },
      ],
      instructions: [
        { id: 'p1', from: 'A', to: 'B', amount: 80 },
        { id: 'p2', from: 'B', to: 'A', amount: 30 },
      ],
    }),
  );
  let code = run();
  assert.equal(code, 0);
  let output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.status, 'SAT');
  assert.ok(output.certificate);

  // UNSAT case (unreleased prior freeze exceeds limit): exit 0, marked UNSAT.
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      accounts: [
        { id: 'A', limit: 50 },
        { id: 'B', limit: 50 },
      ],
      instructions: [{ id: 'p1', from: 'A', to: 'B', amount: 10, frozen: 80 }],
    }),
  );
  code = run();
  assert.equal(code, 0);
  output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.status, 'UNSAT');

  // PENDING case (budget 0 on an instance that requires backtracking): exit 0.
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      accounts: [
        { id: 'A', limit: 5 },
        { id: 'B', limit: 200 },
      ],
      instructions: [
        { id: 'i1', from: 'A', to: 'B', amount: 100 },
        { id: 'i2', from: 'B', to: 'A', amount: 100 },
        { id: 'i3', from: 'A', to: 'B', amount: 10 },
      ],
      budget: 0,
    }),
  );
  code = run();
  assert.equal(code, 0);
  output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.status, 'PENDING');
  assert.ok(output.certificate.minConflictSet.length >= 1);

  // Illegal revocation: exit 1.
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      accounts: [
        { id: 'A', limit: 10 },
        { id: 'B', limit: 10 },
      ],
      instructions: [{ id: 'p1', from: 'A', to: 'B', amount: 5 }],
      revocations: [{ instruction: 'ghost', time: '2026-01-01T00:00:00Z' }],
    }),
  );
  code = run();
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /unknown instruction/);

  // Malformed JSON: exit 1.
  fs.writeFileSync(inputPath, '{ not json');
  code = run();
  assert.equal(code, 1);

  // Unknown account reference: exit 1.
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      accounts: [{ id: 'A', limit: 10 }],
      instructions: [{ id: 'p1', from: 'A', to: 'Z', amount: 5 }],
    }),
  );
  code = run();
  assert.equal(code, 1);

  // Bad usage: exit 1.
  assert.equal(main(['settle']), 1);
  assert.equal(main(['bogus', inputPath, outputPath]), 1);
  finish();
});
