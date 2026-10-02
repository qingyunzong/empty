'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettlementSystem } = require('../src/system');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'accept-'));
}

// Acceptance 1: net, margin and frozen amounts equal a reference that
// enumerates all live trades and accumulates.
test('acceptance 1: netting matches live-trade enumeration reference', () => {
  const sys = new SettlementSystem(tmpdir());
  const trades = [
    { id: 'a1', buyer: 'alice', seller: 'bob', amount: 120, desc: 'alice buys apples from bob' },
    { id: 'a2', buyer: 'alice', seller: 'bob', amount: 80, desc: 'alice buys bread from bob' },
    { id: 'a3', buyer: 'bob', seller: 'alice', amount: 250, desc: 'bob buys cider from alice' },
    { id: 'a4', buyer: 'carol', seller: 'alice', amount: 60, desc: 'carol buys jam from alice' },
  ];
  for (const t of trades) sys.addTrade(t);
  sys.revokeTrade('a2');

  // reference: enumerate live trades for alice/bob
  const live = trades.filter((t) => t.id !== 'a2');
  let net = 0;
  for (const t of live) {
    if (![t.buyer, t.seller].includes('alice') || ![t.buyer, t.seller].includes('bob')) continue;
    net += t.buyer === 'alice' ? t.amount : -t.amount;
  }
  const got = sys.getNet('alice', 'bob');
  assert.equal(got.net, net);
  assert.equal(got.margin, Math.abs(net));
  assert.equal(got.direction, net < 0 ? 'bob->alice' : 'alice->bob');
  assert.equal(sys.ledger.frozenOf('bob'), Math.abs(net));
  assert.equal(sys.ledger.frozenOf('alice'), 0); // alice is net receiver on both pairs
  assert.equal(sys.ledger.frozenOf('carol'), 60);
});

// Acceptance 2: deletion shrinks phrase results; after compaction and a
// restart, results and hashes are unchanged.
test('acceptance 2: delete, compaction, restart stability', () => {
  const dir = tmpdir();
  const sys = new SettlementSystem(dir, { compactThreshold: 0.5 });
  sys.addTrade({ id: 't1', buyer: 'a', seller: 'b', amount: 10, desc: 'red apple delivery monday' });
  sys.addTrade({ id: 't2', buyer: 'a', seller: 'b', amount: 20, desc: 'red apple delivery tuesday' });
  sys.addTrade({ id: 't3', buyer: 'a', seller: 'b', amount: 30, desc: 'red apple delivery wednesday' });
  sys.addTrade({ id: 't4', buyer: 'a', seller: 'b', amount: 40, desc: 'green pear delivery monday' });

  const before = sys.phrase('red apple delivery');
  assert.equal(before.results.length, 3);

  sys.deleteTrade('t1');
  sys.deleteTrade('t2');
  const after = sys.phrase('red apple delivery');
  assert.ok(after.results.length < before.results.length, 'phrase results must shrink');
  assert.deepEqual(after.results, ['t3']);

  // 2/4 dead = 0.5 not over threshold; one more delete triggers compaction
  sys.deleteTrade('t4');
  const stats = sys.index.stats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].dead, 0, 'segment rewritten without dead positions');

  const phraseBeforeRestart = sys.phrase('red apple delivery');
  const nearBeforeRestart = sys.near('apple', 'wednesday', 3);
  const hashBeforeRestart = sys.hash();

  // restart: fresh instance over the same directory
  const sys2 = new SettlementSystem(dir, { compactThreshold: 0.5 });
  assert.deepEqual(sys2.phrase('red apple delivery'), phraseBeforeRestart);
  assert.deepEqual(sys2.near('apple', 'wednesday', 3), nearBeforeRestart);
  assert.deepEqual(sys2.hash(), hashBeforeRestart);
  assert.deepEqual(sys2.getNet('a', 'b'), sys.getNet('a', 'b'));
});

// Acceptance 3: reversal certificate direction; unknown trade, duplicate
// delete and negative amount raise errors with no state change.
test('acceptance 3: reversal certificate and error atomicity', () => {
  const sys = new SettlementSystem(tmpdir());
  sys.addTrade({ id: 'x1', buyer: 'alice', seller: 'bob', amount: 100, desc: 'first leg' });
  const cert = sys.addTrade({ id: 'x2', buyer: 'bob', seller: 'alice', amount: 300, desc: 'second leg' }).certificate;

  assert.equal(cert.reversed, true);
  assert.equal(cert.direction, 'bob->alice');
  assert.equal(cert.net, -200);
  assert.equal(cert.margin, 200);
  assert.deepEqual(cert.batch, [
    { type: 'release', party: 'alice', amount: 100 },
    { type: 'freeze', party: 'bob', amount: 200 },
  ]);
  assert.equal(sys.ledger.frozenOf('alice'), 0);
  assert.equal(sys.ledger.frozenOf('bob'), 200);

  assert.throws(() => sys.revokeTrade('ghost'), (e) => e.code === 'UNKNOWN_TRADE');
  assert.throws(() => sys.deleteTrade('ghost'), (e) => e.code === 'UNKNOWN_TRADE');
  sys.deleteTrade('x1');

  const stateHash = sys.hash();
  const journalLen = sys.ledger.journal.length;
  const segStats = JSON.stringify(sys.index.stats());

  assert.throws(() => sys.deleteTrade('x1'), (e) => e.code === 'DUPLICATE_DELETE');
  assert.throws(() => sys.addTrade({ id: 'x3', buyer: 'a', seller: 'b', amount: -5, desc: 'bad' }),
    (e) => e.code === 'INVALID_AMOUNT');

  // failed operations changed nothing
  assert.deepEqual(sys.hash(), stateHash);
  assert.equal(sys.ledger.journal.length, journalLen);
  assert.equal(JSON.stringify(sys.index.stats()), segStats);
});

test('cli: end-to-end commands and error exit code', () => {
  const dir = tmpdir();
  const { run: cliRun } = require('../src/cli');
  const run = (args) => {
    const r = cliRun(['--data', dir, ...args]);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  run(['add', '--id', 't1', '--buyer', 'A', '--seller', 'B', '--amount', '100', '--desc', 'alice pays bob']);
  run(['add', '--id', 't2', '--buyer', 'B', '--seller', 'A', '--amount', '250', '--desc', 'bob pays alice']);
  const net = run(['net', '--a', 'A', '--b', 'B']);
  assert.deepEqual(net, { net: -150, direction: 'B->A', margin: 150 });

  const phrase = run(['phrase', '--q', 'pays alice']);
  assert.deepEqual(phrase.results, ['t2']);
  assert.ok(Array.isArray(phrase.certificate.segments));

  const near = run(['near', '--x', 'pays', '--y', 'alice', '--k', '2']);
  assert.deepEqual(near.results, [{ id: 't1', window: 1 }, { id: 't2', window: 1 }]);

  const hash1 = run(['hash']);
  const hash2 = run(['hash']); // restart via new process
  assert.deepEqual(hash1, hash2);

  assert.throws(
    () => cliRun(['--data', dir, 'add', '--id', 't3', '--buyer', 'A', '--seller', 'B', '--amount', '-1']),
    (e) => e.code === 'INVALID_AMOUNT');
  const usage = cliRun(['bogus']);
  assert.equal(usage.code, 2);
});
