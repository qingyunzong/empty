'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../src/engine');
const { execute } = require('../cli');
const { verifyCertificate } = require('../src/certificate');
const { referenceOutcome } = require('./reference');

function runEngine(scenario) {
  const walDir = fs.mkdtempSync(path.join(os.tmpdir(), '2pc-test-'));
  const engine = new Engine({ ...scenario, walDir });
  const report = engine.run();
  return { engine, report };
}

function baseScenario(overrides = {}) {
  return {
    retransmitInterval: 10,
    prepareTimeout: 50,
    maxTime: 400,
    accounts: [
      { id: 'A', balance: 100, creditLimit: 1000 },
      { id: 'B', balance: 50, creditLimit: 1000 },
    ],
    txs: [{ id: 't1', from: 'A', to: 'B', amount: 30 }],
    ...overrides,
  };
}

function acct(report, id) {
  return report.accounts.find((a) => a.id === id);
}

test('clean run commits and transfers exactly once', () => {
  const { report } = runEngine(baseScenario());
  assert.equal(report.txs[0].decision, 'commit');
  assert.equal(report.txs[0].done, true);
  assert.equal(acct(report, 'A').balance, 70);
  assert.equal(acct(report, 'B').balance, 80);
  assert.equal(acct(report, 'A').frozen, 0);
  assert.equal(report.pending.length, 0);
  assert.equal(report.violations.length, 0);
  for (const cert of report.certificates) assert.ok(verifyCertificate(cert));
});

test('1. prepare timeout aborts and releases the freeze', () => {
  const { report } = runEngine(
    baseScenario({
      faults: [{ type: 'drop', match: { phase: 'prepare', acct: 'B', from: 'c' }, occurrence: 'all' }],
    })
  );
  assert.equal(report.txs[0].decision, 'abort');
  assert.equal(report.txs[0].reason, 'PREPARE_TIMEOUT');
  assert.equal(acct(report, 'A').balance, 100);
  assert.equal(acct(report, 'A').frozen, 0);
  assert.equal(acct(report, 'B').balance, 50);
  assert.equal(report.pending.length, 0);
  assert.ok(report.events.some((e) => e.event.includes('prepare timeout')));
});

test('2. prepare resent after commit returns the original vote, no re-freeze', () => {
  const { report } = runEngine(
    baseScenario({
      actions: [
        { at: 120, op: 'send', from: 'c', to: 'p:A', msg: { tx: 't1', phase: 'prepare', acct: 'A', amount: -30 } },
        { at: 120, op: 'send', from: 'c', to: 'p:B', msg: { tx: 't1', phase: 'prepare', acct: 'B', amount: 30 } },
      ],
    })
  );
  assert.equal(report.txs[0].decision, 'commit');
  assert.equal(acct(report, 'A').balance, 70);
  assert.equal(acct(report, 'B').balance, 80);
  assert.equal(acct(report, 'A').frozen, 0);
  assert.equal(acct(report, 'B').incoming, 0);
  const pa = report.participantStates.find((p) => p.node === 'p:A');
  assert.equal(pa.txs[0].state, 'committed');
  assert.ok(report.events.some((e) => e.event.includes('duplicate prepare p:A tx=t1 -> original vote yes (committed)')));
});

test('3. credit limit rejects the transfer', () => {
  const { report } = runEngine(
    baseScenario({
      accounts: [
        { id: 'A', balance: 100, creditLimit: 1000 },
        { id: 'B', balance: 50, creditLimit: 60 },
      ],
    })
  );
  assert.equal(report.txs[0].decision, 'abort');
  assert.equal(report.txs[0].reason, 'CREDIT_LIMIT');
  assert.equal(acct(report, 'A').balance, 100);
  assert.equal(acct(report, 'B').balance, 50);
  assert.equal(report.pending.length, 0);
});

test('4a. crash after prepare log (before vote reply) recovers from WAL', () => {
  const scenario = baseScenario({
    crashes: [{ node: 'p:A', tx: 't1', when: 'afterPrepareLog', restartAfter: 30 }],
  });
  const first = runEngine(scenario);
  const second = runEngine(scenario);
  for (const report of [first.report, second.report]) {
    assert.equal(report.txs[0].decision, 'commit');
    assert.equal(acct(report, 'A').balance, 70);
    assert.equal(acct(report, 'B').balance, 80);
    assert.equal(report.pending.length, 0);
    assert.ok(report.events.some((e) => e.event.includes('crash p:A afterPrepareLog')));
  }
  // Recovery is deterministic.
  assert.deepEqual(
    first.report.accounts,
    second.report.accounts
  );
});

test('4b. crash after commit log (before apply) applies on recovery', () => {
  const { report } = runEngine(
    baseScenario({
      crashes: [{ node: 'p:B', tx: 't1', when: 'afterCommitLog', restartAfter: 30 }],
    })
  );
  assert.equal(report.txs[0].decision, 'commit');
  assert.equal(acct(report, 'B').balance, 80);
  assert.equal(acct(report, 'B').incoming, 0);
  assert.equal(report.txs[0].done, true);
  assert.ok(report.events.some((e) => e.event.includes('recovery applied logged commit p:B tx=t1')));
});

test('4c. crash after apply (before ack) does not double-apply', () => {
  const { report } = runEngine(
    baseScenario({
      crashes: [{ node: 'p:A', tx: 't1', when: 'afterApply', restartAfter: 30 }],
    })
  );
  assert.equal(report.txs[0].decision, 'commit');
  assert.equal(report.txs[0].done, true);
  assert.equal(acct(report, 'A').balance, 70); // debited exactly once
  assert.equal(acct(report, 'A').frozen, 0); // and never both debited and unfrozen
  assert.equal(acct(report, 'B').balance, 80);
});

test('4d. coordinator crash after decision log resumes from WAL', () => {
  const { report } = runEngine(
    baseScenario({
      crashes: [{ node: 'c', tx: 't1', when: 'afterCommitLog', restartAfter: 30 }],
    })
  );
  assert.equal(report.txs[0].decision, 'commit');
  assert.equal(report.txs[0].done, true);
  assert.equal(acct(report, 'A').balance, 70);
  assert.equal(acct(report, 'B').balance, 80);
});

test('4e. coordinator crash after begin log aborts undecided tx', () => {
  const { report } = runEngine(
    baseScenario({
      crashes: [{ node: 'c', tx: 't1', when: 'afterPrepareLog', restartAfter: 30 }],
    })
  );
  assert.equal(report.txs[0].decision, 'abort');
  assert.equal(report.txs[0].reason, 'RECOVERY');
  assert.equal(acct(report, 'A').balance, 100);
  assert.equal(acct(report, 'B').balance, 50);
  assert.equal(report.pending.length, 0);
});

test('participant in-doubt tx is queryable while decision is lost', () => {
  const { report } = runEngine(
    baseScenario({
      faults: [{ type: 'drop', match: { phase: 'commit', acct: 'B', from: 'c' }, occurrence: 'all' }],
      queries: [{ op: 'txStatus', tx: 't1' }],
    })
  );
  assert.equal(report.txs[0].decision, 'commit');
  assert.deepEqual(report.pending, [{ node: 'p:B', tx: 't1', acct: 'B', amount: 30, state: 'prepared' }]);
  assert.equal(acct(report, 'B').incoming, 30);
  const q = report.queryResults[0];
  assert.equal(q.found, true);
  assert.equal(q.decision, 'commit');
});

test('fragmented and reordered frames still commit', () => {
  const { report } = runEngine(
    baseScenario({
      faults: [{ type: 'fragment', match: {}, occurrence: 'all', chunks: 3, reverse: true }],
    })
  );
  assert.equal(report.txs[0].decision, 'commit');
  assert.equal(acct(report, 'A').balance, 70);
  assert.equal(acct(report, 'B').balance, 80);
});

// --- Acceptance 5: enumeration of loss/duplication/reorder over the 8
// messages of one tx (5 accounts present), checked against the independent
// reference model.
const MESSAGE_KINDS = [
  { phase: 'prepare', acct: 'A', from: 'c', to: 'p:A' }, // 0 prepare -> A
  { phase: 'prepare', acct: 'B', from: 'c', to: 'p:B' }, // 1 prepare -> B
  { phase: 'prepare', acct: 'A', from: 'p:A', to: 'c' }, // 2 vote A
  { phase: 'prepare', acct: 'B', from: 'p:B', to: 'c' }, // 3 vote B
  { phase: 'commit', acct: 'A', from: 'c', to: 'p:A' }, //  4 commit -> A
  { phase: 'commit', acct: 'B', from: 'c', to: 'p:B' }, //  5 commit -> B
  { phase: 'commit', acct: 'A', from: 'p:A', to: 'c' }, //  6 ack A
  { phase: 'commit', acct: 'B', from: 'p:B', to: 'c' }, //  7 ack B
];

function enumScenario(faults) {
  return {
    retransmitInterval: 10,
    prepareTimeout: 80,
    maxTime: 500,
    accounts: [
      { id: 'A', balance: 100, creditLimit: 1000 },
      { id: 'B', balance: 50, creditLimit: 1000 },
      { id: 'C', balance: 200, creditLimit: 1000 },
      { id: 'D', balance: 300, creditLimit: 1000 },
      { id: 'E', balance: 400, creditLimit: 1000 },
    ],
    txs: [{ id: 't1', from: 'A', to: 'B', amount: 30 }],
    faults,
  };
}

function* enumerateFaultSets() {
  yield []; // no faults
  for (const m of MESSAGE_KINDS) {
    const match = { phase: m.phase, acct: m.acct, from: m.from };
    yield [{ type: 'drop', match, occurrence: 0 }];
    yield [{ type: 'drop', match, occurrence: 'all' }];
    yield [{ type: 'duplicate', match, occurrence: 0, times: 2 }];
    yield [{ type: 'delay', match, occurrence: 0, delay: 15 }];
    yield [{ type: 'delay', match, occurrence: 0, delay: 35 }];
  }
  for (let i = 0; i < MESSAGE_KINDS.length; i++) {
    for (let j = i + 1; j < MESSAGE_KINDS.length; j++) {
      yield [
        { type: 'drop', match: { phase: MESSAGE_KINDS[i].phase, acct: MESSAGE_KINDS[i].acct, from: MESSAGE_KINDS[i].from }, occurrence: 0 },
        { type: 'drop', match: { phase: MESSAGE_KINDS[j].phase, acct: MESSAGE_KINDS[j].acct, from: MESSAGE_KINDS[j].from }, occurrence: 0 },
      ];
    }
  }
}

test('5. fault enumeration (5 accounts x 8 messages) matches independent 2PC reference', () => {
  let cases = 0;
  for (const faults of enumerateFaultSets()) {
    cases++;
    const scenario = enumScenario(faults);
    const { report } = runEngine(scenario);
    const ref = referenceOutcome(scenario);
    const label = JSON.stringify(faults);
    assert.equal(report.txs[0].decision, ref.decision, `decision ${label}`);
    assert.equal(report.txs[0].reason, ref.reason, `reason ${label}`);
    assert.equal(report.txs[0].done, ref.done, `done ${label}`);
    for (const a of report.accounts) {
      assert.deepEqual(
        { balance: a.balance, frozen: a.frozen, incoming: a.incoming, available: a.available },
        ref.accounts[a.id],
        `account ${a.id} ${label}`
      );
    }
    assert.deepEqual(report.pending, ref.pending, `pending ${label}`);
    // Safety invariants on every run.
    const sum = report.accounts.reduce((s, a) => s + a.balance + a.incoming - a.frozen, 0);
    assert.equal(sum, 1050, `conservation ${label}`);
    for (const a of report.accounts) assert.ok(a.frozen >= 0 && a.incoming >= 0);
    for (const cert of report.certificates) assert.ok(verifyCertificate(cert));
    assert.equal(report.violations.length, 0, `violations ${label}`);
  }
  assert.ok(cases > 60, `expected many cases, got ${cases}`);
});

test('engine is deterministic across runs', () => {
  const scenario = enumScenario([{ type: 'drop', match: { phase: 'commit', acct: 'B', from: 'c' }, occurrence: 'all' }]);
  const a = runEngine(scenario).report;
  const b = runEngine(scenario).report;
  const strip = (r) => ({ ...r, walDir: undefined, events: r.events });
  assert.deepEqual(strip(a), strip(b));
});

// --- CLI exit codes (exercised through the same code path as `node cli.js`)
test('CLI exit 3 on insufficient funds', () => {
  const { report, code } = execute(baseScenario({ accounts: [{ id: 'A', balance: 10 }, { id: 'B', balance: 0 }] }));
  assert.equal(code, 3);
  assert.equal(report.txs[0].decision, 'abort');
  assert.equal(report.txs[0].reason, 'INSUFFICIENT_FUNDS');
});

test('CLI exit 4 on unknown tx query', () => {
  const { report, code } = execute(baseScenario({ queries: [{ op: 'txStatus', tx: 'nope' }] }));
  assert.equal(code, 4);
  assert.equal(report.queryResults[0].found, false);
});

test('CLI exit 2 on protocol error (bad scenario)', () => {
  const { report, code, error } = execute({ accounts: [{ id: 'A', balance: -5 }] });
  assert.equal(code, 2);
  assert.equal(report, null);
  assert.ok(error.includes('protocol error'));
});

test('CLI exit 0 on clean commit', () => {
  const { report, code } = execute(baseScenario());
  assert.equal(code, 0);
  assert.equal(report.txs[0].decision, 'commit');
});
