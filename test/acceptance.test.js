'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('../src/simulate');
const { referenceRun } = require('../src/reference');
const { Engine } = require('../src/engine');
const { Participant } = require('../src/participant');
const { runCliFile } = require('../cli');

const CLI = path.join(__dirname, '..', 'cli.js');

function scenarioPath(name) {
  return path.join(__dirname, '..', 'scenarios', name);
}

test('acceptance 1: prepare timeout aborts and unfroze debit side', () => {
  const { output, exitCode } = runScenario({
    accounts: {
      A: { balance: 100, creditLimit: 1000 },
      B: { balance: 0, creditLimit: 1000 },
    },
    txs: [{ tx: 't1', legs: [{ acct: 'A', amount: -40 }, { acct: 'B', amount: 40 }] }],
    prepareTimeout: 50,
    retryInterval: 10,
    maxTime: 300,
    network: {
      faults: [
        { from: 'P@B', phase: 'vote', action: 'drop' },
        { to: 'P@B', phase: 'abort', action: 'drop' },
      ],
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(output.results.t1.decision, 'abort');
  assert.equal(output.results.t1.reason, 'PREPARE_TIMEOUT');
  assert.deepEqual(
    { balance: output.balances.A.balance, frozen: output.balances.A.frozen },
    { balance: 100, frozen: 0 }
  );
  assert.deepEqual(output.pending, [{ participant: 'P@B', tx: 't1', acct: 'B', amount: 40 }]);
  assert.ok(output.certificate.valid);
  assert.equal(output.certificate.chain[0].decision, 'abort');
});

test('acceptance 2: prepare re-sent after commit returns original vote, no state change', () => {
  const { output, exitCode, engine } = runScenario({
    accounts: {
      A: { balance: 100, creditLimit: 1000 },
      B: { balance: 0, creditLimit: 1000 },
    },
    txs: [{ tx: 't1', legs: [{ acct: 'A', amount: -30 }, { acct: 'B', amount: 30 }] }],
    prepareTimeout: 60,
    retryInterval: 10,
    network: {
      faults: [{ phase: 'prepare', acct: 'A', action: 'dup:200', times: 1 }],
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(output.results.t1.decision, 'commit');
  assert.equal(output.balances.A.balance, 70);
  assert.equal(output.balances.B.balance, 30);
  assert.equal(output.balances.A.frozen, 0);
  assert.deepEqual(output.errors, []);
  const pA = engine.nodes.get('P@A');
  const rec = pA.txs.get('t1');
  assert.equal(rec.vote, 'yes');
  assert.equal(rec.state, 'applied');
  const voteMsgs = [];
  const origSend = engine.send.bind(engine);
  engine.send = (from, to, msg) => {
    if (msg.phase === 'vote') voteMsgs.push(msg);
    return origSend(from, to, msg);
  };
  pA.onPrepare({ tx: 't1', phase: 'prepare', acct: 'A', amount: -30, seq: 99, ack: '', reason: '' });
  assert.equal(voteMsgs.length, 1);
  assert.equal(voteMsgs[0].ack, 'yes');
  assert.equal(pA.accounts.get('A').balance, 70);
  assert.equal(pA.accounts.get('A').frozen, 0);
});

test('acceptance 3: credit limit violation votes no and aborts', () => {
  const { output, exitCode } = runScenario({
    accounts: {
      A: { balance: 100, creditLimit: 1000 },
      B: { balance: 0, creditLimit: 30 },
    },
    txs: [{ tx: 't1', legs: [{ acct: 'A', amount: -40 }, { acct: 'B', amount: 40 }] }],
  });
  assert.equal(exitCode, 0);
  assert.equal(output.results.t1.decision, 'abort');
  assert.equal(output.results.t1.reason, 'CREDIT_LIMIT');
  assert.equal(output.balances.A.balance, 100);
  assert.equal(output.balances.A.frozen, 0);
  assert.equal(output.balances.B.balance, 0);
  assert.equal(output.certificate.chain[0].votes.B, 'no:CREDIT_LIMIT');
});

test('acceptance 4: recovery from all three fault points plus coordinator restart', () => {
  const accounts = {
    A: { balance: 100, creditLimit: 1000 },
    B: { balance: 0, creditLimit: 1000 },
    C: { balance: 100, creditLimit: 1000 },
    D: { balance: 0, creditLimit: 1000 },
    E: { balance: 100, creditLimit: 1000 },
    F: { balance: 0, creditLimit: 1000 },
  };
  const txs = [
    { tx: 't1', legs: [{ acct: 'A', amount: -10 }, { acct: 'B', amount: 10 }] },
    { tx: 't2', legs: [{ acct: 'C', amount: -20 }, { acct: 'D', amount: 20 }] },
    { tx: 't3', legs: [{ acct: 'E', amount: -30 }, { acct: 'F', amount: 30 }] },
  ];
  const { output, exitCode } = runScenario({
    accounts,
    txs,
    prepareTimeout: 80,
    retryInterval: 10,
    faults: [
      { node: 'P@A', tx: 't1', point: 'after-prepare-log', restartDelay: 5 },
      { node: 'P@C', tx: 't2', point: 'after-commit-log', restartDelay: 5 },
      { node: 'P@E', tx: 't3', point: 'after-apply-before-ack', restartDelay: 5 },
      { node: 'COORD', tx: 't2', point: 'after-decision-log', restartDelay: 5 },
    ],
  });
  assert.equal(exitCode, 0);
  const ref = referenceRun(accounts, txs);
  for (const id of ['t1', 't2', 't3']) {
    assert.equal(output.results[id].decision, 'commit', `${id} should commit`);
    assert.deepEqual(output.results[id].acks, Object.fromEntries(txs.find((t) => t.tx === id).legs.map((l) => [l.acct, true])));
  }
  for (const [acct, expected] of Object.entries(ref.balances)) {
    assert.equal(output.balances[acct].balance, expected, `balance of ${acct}`);
    assert.equal(output.balances[acct].frozen, 0, `frozen of ${acct}`);
  }
  assert.deepEqual(output.pending, []);
  assert.ok(output.certificate.valid);
  assert.equal(output.certificate.chain.length, 3);
  assert.deepEqual(output.errors, []);
});

test('acceptance 4b: each fault point alone recovers deterministically', () => {
  const points = ['after-prepare-log', 'after-commit-log', 'after-apply-before-ack'];
  for (const point of points) {
    const accounts = {
      A: { balance: 50, creditLimit: 100 },
      B: { balance: 0, creditLimit: 100 },
    };
    const txs = [{ tx: 't1', legs: [{ acct: 'A', amount: -20 }, { acct: 'B', amount: 20 }] }];
    const { output, exitCode } = runScenario({
      accounts,
      txs,
      prepareTimeout: 80,
      retryInterval: 10,
      faults: [{ node: 'P@A', tx: 't1', point, restartDelay: 5 }],
    });
    assert.equal(exitCode, 0, point);
    assert.equal(output.results.t1.decision, 'commit', point);
    assert.equal(output.balances.A.balance, 30, point);
    assert.equal(output.balances.B.balance, 20, point);
    assert.equal(output.balances.A.frozen, 0, point);
    assert.deepEqual(output.errors, [], point);
  }
});

test('acceptance 5: enumeration of loss/dup/reorder over 8 messages matches reference 2PC', () => {
  const accounts = {
    A: { balance: 100, creditLimit: 1000 },
    B: { balance: 0, creditLimit: 1000 },
    C: { balance: 5, creditLimit: 1000 },
    D: { balance: 7, creditLimit: 1000 },
    E: { balance: 9, creditLimit: 1000 },
  };
  const txs = [{ tx: 't1', legs: [{ acct: 'A', amount: -30 }, { acct: 'B', amount: 30 }] }];
  const ref = referenceRun(accounts, txs);
  assert.equal(ref.decisions.t1.decision, 'commit');
  const N = 8; // prepare A, prepare B, vote A, vote B, commit A, commit B, ack A, ack B
  const total = 3 ** N;
  for (let combo = 0; combo < total; combo++) {
    const faults = [];
    let x = combo;
    for (let i = 0; i < N; i++) {
      const d = x % 3;
      x = (x - d) / 3;
      if (d === 1) faults.push({ msgIndex: i, action: 'drop', times: 1 });
      else if (d === 2) faults.push({ msgIndex: i, action: 'dup', times: 1 });
    }
    const reorder = combo % 2 === 1;
    const { output, exitCode } = runScenario({
      accounts,
      txs,
      prepareTimeout: 80,
      retryInterval: 10,
      maxTime: 4000,
      network: { reorder, seed: combo + 1, faults },
    });
    assert.equal(exitCode, 0, `combo ${combo}`);
    assert.equal(output.results.t1.decision, ref.decisions.t1.decision, `combo ${combo}`);
    for (const [acct, expected] of Object.entries(ref.balances)) {
      assert.equal(output.balances[acct].balance, expected, `combo ${combo} acct ${acct}`);
      assert.equal(output.balances[acct].frozen, 0, `combo ${combo} frozen ${acct}`);
    }
    assert.deepEqual(output.pending, [], `combo ${combo} pending`);
    assert.deepEqual(output.errors, [], `combo ${combo} errors`);
    assert.ok(output.certificate.valid, `combo ${combo} cert`);
  }
});

test('participant guards: unknown commit and abort-after-apply', () => {
  const engine = new Engine({});
  const disk = { genesis: { A: { balance: 50, creditLimit: 100 } }, wal: [] };
  const p = new Participant('P@A', disk, engine);
  p.onCommit({ tx: 'nope', phase: 'commit', acct: 'A', amount: -5, seq: 0, ack: '', reason: '' });
  assert.ok(engine.errors.some((e) => e.type === 'UNKNOWN_TX'));
  p.onPrepare({ tx: 't1', phase: 'prepare', acct: 'A', amount: -20, seq: 1, ack: '', reason: '' });
  p.onCommit({ tx: 't1', phase: 'commit', acct: 'A', amount: -20, seq: 2, ack: '', reason: '' });
  assert.equal(p.accounts.get('A').balance, 30);
  p.onAbort({ tx: 't1', phase: 'abort', acct: 'A', amount: -20, seq: 3, ack: '', reason: '' });
  assert.ok(engine.errors.some((e) => e.type === 'PROTOCOL' && /never debit-and-unfreeze/.test(e.detail)));
  assert.equal(p.accounts.get('A').balance, 30);
  assert.equal(p.accounts.get('A').frozen, 0);
});

test('cli exit codes: 0 commit, 2 protocol, 3 insufficient, 4 unknown tx', () => {
  const ok = runCliFile(scenarioPath('commit.json'));
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).results.t1.decision, 'commit');

  const bad = runCliFile(scenarioPath('protocol-error.json'));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /protocol error/);

  const ins = runCliFile(scenarioPath('insufficient.json'));
  assert.equal(ins.code, 3);
  const insOut = JSON.parse(ins.out);
  assert.equal(insOut.results.t1.decision, 'abort');
  assert.equal(insOut.results.t1.reason, 'INSUFFICIENT_FUNDS');

  const unk = runCliFile(scenarioPath('unknown-tx.json'));
  assert.equal(unk.code, 4);
  const unkOut = JSON.parse(unk.out);
  assert.equal(unkOut.ops[0].error, 'UNKNOWN_TX');

  const missing = runCliFile(path.join(__dirname, 'no-such-file.json'));
  assert.equal(missing.code, 2);
});
