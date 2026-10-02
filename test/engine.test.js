import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MarginCallEngine, SimulatedCrash } from '../src/engine.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-engine-'));
}

function runToCompletion(logDir, event) {
  const engine = new MarginCallEngine(logDir);
  for (;;) {
    try {
      return engine.run(event);
    } catch (err) {
      if (!(err instanceof SimulatedCrash)) throw err;
    }
  }
}

function journal(logDir, callId) {
  const file = path.join(logDir, `${callId}.jsonl`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function assertNoOrphanFreezes(logDir, callId) {
  const records = journal(logDir, callId);
  const completed = records.find((r) => r.type === 'completed');
  assert.ok(completed, 'journal must contain a completed record');
  const frozenBy = new Map();
  for (const r of records.filter((r) => r.type === 'attempt' && r.amount > 0)) {
    frozenBy.set(r.accountId, (frozenBy.get(r.accountId) ?? 0) + r.amount);
  }
  const rolledBy = new Map();
  for (const r of records.filter((r) => r.type === 'rollback')) {
    rolledBy.set(r.accountId, (rolledBy.get(r.accountId) ?? 0) + r.amount);
  }
  if (completed.status === 'CONFIRMED') {
    assert.equal(rolledBy.size, 0, 'confirmed call must not roll back');
  } else {
    assert.deepEqual(
      Object.fromEntries(rolledBy),
      Object.fromEntries(frozenBy),
      'every frozen amount must be rolled back (no orphans)',
    );
  }
}

test('sufficient funds: freezes by priority and certificate is correct', () => {
  const dir = tmpdir();
  const event = {
    callId: 'call-ok',
    targetAmount: 60,
    accounts: [
      { id: 'c', priority: 3, available: 100 },
      { id: 'a', priority: 1, available: 50 },
      { id: 'b', priority: 2, available: 30 },
    ],
  };
  const result = runToCompletion(dir, event);
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.totalFrozen, 60);
  assert.deepEqual(result.freezes, [
    { accountId: 'a', amount: 50 },
    { accountId: 'b', amount: 10 },
  ]);
  assert.deepEqual(result.rollbacks, []);

  const canonical = JSON.stringify({
    callId: 'call-ok',
    targetAmount: 60,
    status: 'CONFIRMED',
    freezes: [
      { accountId: 'a', amount: 50 },
      { accountId: 'b', amount: 10 },
    ],
  });
  const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
  assert.equal(result.certificate, expected);

  const records = journal(dir, 'call-ok');
  const seqs = records.filter((r) => r.type === 'attempt').map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2]);
  assert.equal(records.filter((r) => r.type === 'rollback').length, 0);
  assertNoOrphanFreezes(dir, 'call-ok');
});

test('insufficient funds: every frozen amount is rolled back in reverse order', () => {
  const dir = tmpdir();
  const event = {
    callId: 'call-short',
    targetAmount: 100,
    accounts: [
      { id: 'a', priority: 1, available: 10 },
      { id: 'b', priority: 2, available: 20 },
      { id: 'c', priority: 3, available: 5 },
    ],
  };
  const result = runToCompletion(dir, event);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.totalFrozen, 0);
  assert.equal(result.certificate, null);
  assert.deepEqual(result.freezes, [
    { accountId: 'a', amount: 10 },
    { accountId: 'b', amount: 20 },
    { accountId: 'c', amount: 5 },
  ]);
  assert.deepEqual(result.rollbacks, [
    { accountId: 'c', amount: 5 },
    { accountId: 'b', amount: 20 },
    { accountId: 'a', amount: 10 },
  ]);

  const records = journal(dir, 'call-short');
  const rollbackOrder = records
    .filter((r) => r.type === 'rollback')
    .map((r) => r.accountId);
  assert.deepEqual(rollbackOrder, ['c', 'b', 'a']);
  assertNoOrphanFreezes(dir, 'call-short');
});

test('partial success and failed account freeze are recorded immediately', () => {
  const dir = tmpdir();
  const event = {
    callId: 'call-partial',
    targetAmount: 50,
    accounts: [
      { id: 'a', priority: 1, available: 20 },
      { id: 'b', priority: 2, available: 100, failFreeze: true },
      { id: 'c', priority: 3, available: 40 },
    ],
  };
  const result = runToCompletion(dir, event);
  assert.equal(result.status, 'CONFIRMED');
  assert.deepEqual(result.freezes, [
    { accountId: 'a', amount: 20 },
    { accountId: 'c', amount: 30 },
  ]);
  const attempts = journal(dir, 'call-partial').filter((r) => r.type === 'attempt');
  assert.deepEqual(
    attempts.map((a) => [a.accountId, a.amount, a.success]),
    [
      ['a', 20, true],
      ['b', 0, false],
      ['c', 30, true],
    ],
  );
});

test('crash after any account: recovery result equals crash-free result', () => {
  const accounts = [
    { id: 'a', priority: 1, available: 25 },
    { id: 'b', priority: 2, available: 0 },
    { id: 'c', priority: 3, available: 40 },
    { id: 'd', priority: 4, available: 10 },
  ];
  const base = runToCompletion(tmpdir(), {
    callId: 'call-crash',
    targetAmount: 70,
    accounts,
  });
  assert.equal(base.status, 'CONFIRMED');

  for (let crashAt = 1; crashAt <= accounts.length; crashAt += 1) {
    const dir = tmpdir();
    const recovered = runToCompletion(dir, {
      callId: 'call-crash',
      targetAmount: 70,
      accounts,
      crashAfterAccount: crashAt,
    });
    assert.deepEqual(recovered, base, `crash after account #${crashAt}`);
    const seqs = journal(dir, 'call-crash')
      .filter((r) => r.type === 'attempt')
      .map((r) => r.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    assert.equal(new Set(seqs).size, seqs.length, 'no account frozen twice');
    assertNoOrphanFreezes(dir, 'call-crash');
  }
});

test('cancel during call stops freezing and rolls back frozen part', () => {
  const dir = tmpdir();
  const result = runToCompletion(dir, {
    callId: 'call-cancel',
    targetAmount: 100,
    cancelAfterAccount: 1,
    accounts: [
      { id: 'a', priority: 1, available: 30 },
      { id: 'b', priority: 2, available: 50 },
      { id: 'c', priority: 3, available: 50 },
    ],
  });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.totalFrozen, 0);
  assert.deepEqual(result.freezes, [{ accountId: 'a', amount: 30 }]);
  assert.deepEqual(result.rollbacks, [{ accountId: 'a', amount: 30 }]);
  assertNoOrphanFreezes(dir, 'call-cancel');
});

test('crash and cancel combined leave no orphan freezes', () => {
  const dir = tmpdir();
  const result = runToCompletion(dir, {
    callId: 'call-crash-cancel',
    targetAmount: 100,
    crashAfterAccount: 2,
    cancelAfterAccount: 2,
    accounts: [
      { id: 'a', priority: 1, available: 30 },
      { id: 'b', priority: 2, available: 30 },
      { id: 'c', priority: 3, available: 50 },
    ],
  });
  assert.equal(result.status, 'CANCELLED');
  assert.deepEqual(result.rollbacks, [
    { accountId: 'b', amount: 30 },
    { accountId: 'a', amount: 30 },
  ]);
  assertNoOrphanFreezes(dir, 'call-crash-cancel');
});

test('same callId is idempotent across engines and restarts', () => {
  const dir = tmpdir();
  const event = {
    callId: 'call-idem',
    targetAmount: 40,
    crashAfterAccount: 1,
    accounts: [
      { id: 'a', priority: 1, available: 25 },
      { id: 'b', priority: 2, available: 25 },
    ],
  };
  const first = runToCompletion(dir, event);
  const linesAfterFirst = journal(dir, 'call-idem').length;
  const second = new MarginCallEngine(dir).run({
    callId: 'call-idem',
    targetAmount: 40,
    accounts: event.accounts,
  });
  assert.deepEqual(second, first);
  assert.equal(journal(dir, 'call-idem').length, linesAfterFirst);
  assert.equal(first.status, 'CONFIRMED');
});

test('conflicting event for an existing callId is rejected', () => {
  const dir = tmpdir();
  runToCompletion(dir, {
    callId: 'call-conflict',
    targetAmount: 10,
    accounts: [{ id: 'a', priority: 1, available: 10 }],
  });
  assert.throws(
    () =>
      new MarginCallEngine(dir).run({
        callId: 'call-conflict',
        targetAmount: 99,
        accounts: [{ id: 'a', priority: 1, available: 10 }],
      }),
    /already exists with different parameters/,
  );
});

test('invalid events are rejected', () => {
  const dir = tmpdir();
  const engine = new MarginCallEngine(dir);
  assert.throws(() => engine.run(null), /JSON object/);
  assert.throws(
    () => engine.run({ callId: 'x', targetAmount: -1, accounts: [{ id: 'a', priority: 1, available: 1 }] }),
    /targetAmount/,
  );
  assert.throws(
    () =>
      engine.run({
        callId: 'x',
        targetAmount: 1,
        accounts: [
          { id: 'a', priority: 1, available: 1 },
          { id: 'a', priority: 2, available: 1 },
        ],
      }),
    /duplicate account id/,
  );
});
