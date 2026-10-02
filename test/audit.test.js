'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { runCommands, InvalidCommandError, canonical } = require('../src/ledger.js');
const { audit, minimize } = require('../src/shrink.js');
const { run: cliRun } = require('../cli.js');

// Drive the CLI in-process (the sandbox forbids spawning child processes);
// the shell entrypoint is the same `run` function.
function runCli(plan) {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-'));
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  let out = '';
  let err = '';
  const code = cliRun(['shrink', file], { stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, stdout: out ? JSON.parse(out) : null, stderr: err };
}

// Independent brute-force minimality oracle: enumerate every subset,
// keep the shortest failing ones, return the lexicographically smallest.
function independentMinimal(commands, limits) {
  const n = commands.length;
  let bestLen = Infinity;
  let best = null;
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const sub = [];
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) sub.push(commands[i]);
    if (sub.length > bestLen) continue;
    let run;
    try {
      run = runCommands(sub, limits);
    } catch (err) {
      if (err instanceof InvalidCommandError) continue;
      throw err;
    }
    if (!run.ok) {
      const key = sub.map(canonical).join('');
      if (sub.length < bestLen || (best !== null && key < best.key)) {
        bestLen = sub.length;
        best = { key, commands: sub };
      }
    }
  }
  return best;
}

test('acceptance 1: one over-limit freeze in a long sequence shrinks to the minimal relevant commands', () => {
  const limits = { cash: 100, ops: 50 };
  const commands = [
    { op: 'post', id: 'p1', account: 'cash', amount: 10 },
    { op: 'post', id: 'p2', account: 'cash', amount: 15 },
    { op: 'freeze', account: 'ops', amount: 20 },
    { op: 'cancel', postId: 'p2' },
    { op: 'post', id: 'p3', account: 'ops', amount: 25 },
    { op: 'freeze', account: 'cash', amount: 5 },
    { op: 'post', id: 'p4', account: 'cash', amount: 8 },
    { op: 'cancel', postId: 'p1' },
    { op: 'freeze', account: 'cash', amount: 97 },
    { op: 'post', id: 'p5', account: 'ops', amount: 3 },
    { op: 'freeze', account: 'ops', amount: 1 },
    { op: 'post', id: 'p6', account: 'cash', amount: 2 },
  ];
  const report = audit({ limits, commands });
  assert.equal(report.status, 'UNSAFE');
  const cx = report.counterexample;
  // freeze 97 alone stays under 100; the shortest failing combination is
  // the lexicographically smallest pair that tips the account over.
  assert.equal(cx.length, 2);
  assert.deepEqual(cx.commands, [
    { op: 'post', id: 'p1', account: 'cash', amount: 10 },
    { op: 'freeze', account: 'cash', amount: 97 },
  ]);
  assert.equal(cx.removed.length, commands.length - 2);
  assert.deepEqual(cx.removedIndices, [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]);
  assert.equal(cx.finalState.cash.available, -7);
  assert.match(cx.replayHash, /^[0-9a-f]{64}$/);
  assert.equal(report.minimality.method, 'exhaustive-subset-enumeration');
  // Cross-check against the independent oracle.
  const oracle = independentMinimal(commands, limits);
  assert.deepEqual(cx.commands, oracle.commands);
});

test('acceptance 1b: a freeze that alone exceeds the limit shrinks to a single command', () => {
  const limits = { cash: 50 };
  const commands = [
    { op: 'post', id: 'p1', account: 'cash', amount: 10 },
    { op: 'freeze', account: 'cash', amount: 60 },
    { op: 'cancel', postId: 'p1' },
  ];
  const report = audit({ limits, commands });
  assert.equal(report.status, 'UNSAFE');
  assert.equal(report.counterexample.length, 1);
  assert.deepEqual(report.counterexample.commands, [{ op: 'freeze', account: 'cash', amount: 60 }]);
  assert.equal(report.counterexample.removed.length, 2);
});

test('acceptance 2: fully legal plan yields a certificate and no single deletion changes the conclusion', () => {
  const plan = {
    limits: { cash: 100 },
    commands: [
      { op: 'post', id: 'p1', account: 'cash', amount: 40 },
      { op: 'freeze', account: 'cash', amount: 30 },
      { op: 'post', id: 'p2', account: 'cash', amount: 20 },
      { op: 'freeze', account: 'cash', amount: 10 },
    ],
  };
  const res = runCli(plan);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.status, 'SAFE');
  const cert = res.stdout.certificate;
  assert.equal(cert.replayDeterministic, true);
  assert.match(cert.replayHash, /^[0-9a-f]{64}$/);
  assert.equal(cert.singleDeletionChecks.tested, plan.commands.length);
  assert.equal(cert.singleDeletionChecks.allSafe, true);
  for (const d of cert.singleDeletionChecks.deletions) assert.equal(d.safe, true);
  // Independently re-verify every single deletion stays safe.
  for (let i = 0; i < plan.commands.length; i += 1) {
    const rest = plan.commands.filter((_, j) => j !== i);
    assert.equal(runCommands(rest, plan.limits).ok, true, `deletion of #${i} must stay safe`);
  }
});

test('acceptance 3: cancel restores available limit and the audit trail keeps both entries', () => {
  const limits = { cash: 100 };
  const commands = [
    { op: 'post', id: 'p1', account: 'cash', amount: 100 },
    { op: 'cancel', postId: 'p1' },
    { op: 'post', id: 'p2', account: 'cash', amount: 100 },
  ];
  const result = runCommands(commands, limits);
  assert.equal(result.ok, true, 'limit restored after cancel, so p2 fits');
  assert.equal(result.finalState.cash.posted, 100);
  assert.equal(result.finalState.cash.available, 0);
  // Audit trail retains the original post and the reversal correction.
  assert.equal(result.ledger.length, 3);
  assert.deepEqual(result.ledger[0], { seq: 0, type: 'post', id: 'p1', account: 'cash', amount: 100 });
  assert.equal(result.ledger[1].type, 'correction');
  assert.equal(result.ledger[1].amount, -100, 'correction has opposite sign to the original post');
  assert.equal(result.ledger[1].postId, 'p1');
  // Replay from the ledger reproduces the same totals (replayable invariant).
  const replayed = result.ledger
    .filter((e) => e.account === 'cash')
    .reduce((sum, e) => (e.type === 'freeze' ? sum : sum + e.amount), 0);
  assert.equal(replayed, result.finalState.cash.posted);
});

test('invalid commands are rejected with exit code 1 and INVALID_COMMAND', () => {
  const cases = {
    'unknown cancel id': {
      limits: {},
      commands: [{ op: 'cancel', postId: 'nope' }],
    },
    'cyclic correction (double cancel)': {
      limits: {},
      commands: [
        { op: 'post', id: 'p1', account: 'a', amount: 5 },
        { op: 'cancel', postId: 'p1' },
        { op: 'cancel', postId: 'p1' },
      ],
    },
    'negative post amount': {
      limits: {},
      commands: [{ op: 'post', id: 'p1', account: 'a', amount: -5 }],
    },
    'negative freeze amount': {
      limits: {},
      commands: [{ op: 'freeze', account: 'a', amount: -1 }],
    },
    'duplicate post id': {
      limits: {},
      commands: [
        { op: 'post', id: 'p1', account: 'a', amount: 1 },
        { op: 'post', id: 'p1', account: 'a', amount: 2 },
      ],
    },
  };
  for (const [name, plan] of Object.entries(cases)) {
    const res = runCli(plan);
    assert.equal(res.code, 1, name);
    const err = JSON.parse(res.stderr);
    assert.equal(err.status, 'INVALID_COMMAND', name);
  }
});

test('library throws InvalidCommandError with code INVALID_COMMAND', () => {
  assert.throws(
    () => runCommands([{ op: 'post', id: 'x', account: 'a', amount: -3 }], {}),
    (err) => err instanceof InvalidCommandError && err.code === 'INVALID_COMMAND'
  );
});

test('exhaustive small-space check: for every plan of <=6 commands, shrink matches the independent oracle', () => {
  // Build the plan space from a small command alphabet over one account.
  const alphabet = [
    { op: 'post', id: 'p1', account: 'a', amount: 40 },
    { op: 'post', id: 'p2', account: 'a', amount: 70 },
    { op: 'cancel', postId: 'p1' },
    { op: 'cancel', postId: 'p2' },
    { op: 'freeze', account: 'a', amount: 30 },
    { op: 'freeze', account: 'a', amount: 80 },
  ];
  const limits = { a: 100 };
  let checked = 0;
  let unsafe = 0;

  const visit = (prefix) => {
    if (prefix.length > 0) {
      let full;
      try {
        full = runCommands(prefix, limits);
      } catch (err) {
        if (err instanceof InvalidCommandError) return; // not a valid plan
        throw err;
      }
      checked += 1;
      if (!full.ok) {
        unsafe += 1;
        const minimal = minimize(prefix, limits);
        const oracle = independentMinimal(prefix, limits);
        assert.ok(oracle, 'oracle must find a failing subset');
        assert.equal(minimal.commands.length, oracle.commands.length, 'shortest length must match');
        assert.deepEqual(
          minimal.commands,
          oracle.commands,
          `lexicographically smallest minimal counterexample must match for ${canonical(prefix)}`
        );
        // The counterexample itself must still fail and be valid.
        assert.equal(runCommands(minimal.commands, limits).ok, false);
      }
    }
    if (prefix.length === 6) return;
    for (const cmd of alphabet) visit([...prefix, cmd]);
  };
  visit([]);

  assert.ok(checked > 1000, `expected a meaningful sample, got ${checked}`);
  assert.ok(unsafe > 100, `expected many unsafe plans, got ${unsafe}`);
});

test('correction sign invariant: every correction amount is the negation of its original post', () => {
  const result = runCommands(
    [
      { op: 'post', id: 'p1', account: 'a', amount: 25 },
      { op: 'post', id: 'p2', account: 'a', amount: 40 },
      { op: 'cancel', postId: 'p1' },
      { op: 'cancel', postId: 'p2' },
    ],
    {}
  );
  const posts = new Map(result.ledger.filter((e) => e.type === 'post').map((e) => [e.id, e.amount]));
  for (const entry of result.ledger.filter((e) => e.type === 'correction')) {
    assert.equal(Math.sign(entry.amount), -Math.sign(posts.get(entry.postId)));
    assert.equal(entry.amount, -posts.get(entry.postId));
  }
});

test('CLI usage error exits 2 and unparseable plan exits 1 with INVALID_COMMAND', () => {
  let err = '';
  const usageCode = cliRun([], { stdout: () => {}, stderr: (s) => (err += s) });
  assert.equal(usageCode, 2);
  assert.match(err, /usage/);

  const dir = mkdtempSync(path.join(tmpdir(), 'plan-'));
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  err = '';
  const code = cliRun(['shrink', bad], { stdout: () => {}, stderr: (s) => (err += s) });
  assert.equal(code, 1);
  assert.equal(JSON.parse(err).status, 'INVALID_COMMAND');
});
