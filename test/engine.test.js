'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Engine, EngineError } = require('../src/engine');

const QUOTA = 1000;
const AMOUNT = 100;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trade-engine-'));
}

function readLog(dir) {
  return fs
    .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('both branches pass -> trade confirmed, quota spent', () => {
  const dir = tmpdir();
  const engine = new Engine(dir, { quota: QUOTA });
  const cert = engine.apply({
    id: 'e1',
    type: 'instruction',
    tradeId: 't1',
    amount: AMOUNT,
    riskResult: 'approve',
    accountResult: 'sufficient',
  });
  assert.equal(cert.status, 'confirmed');
  assert.deepEqual(cert.quota, { available: QUOTA - AMOUNT, frozen: 0 });
  const types = readLog(dir).map((e) => e.type);
  assert.deepEqual(types, ['instruction', 'risk', 'account', 'confirm']);
});

test('risk rejection -> cancelled and freeze released', () => {
  const dir = tmpdir();
  const engine = new Engine(dir, { quota: QUOTA });
  const cert = engine.apply({
    id: 'e1',
    type: 'instruction',
    tradeId: 't1',
    amount: AMOUNT,
    riskResult: 'reject',
    accountResult: 'sufficient',
  });
  assert.equal(cert.status, 'cancelled');
  assert.deepEqual(cert.quota, { available: QUOTA, frozen: 0 });
  const final = readLog(dir).at(-1);
  assert.equal(final.type, 'cancel');
  assert.equal(final.reason, 'risk_rejected');
});

test('insufficient account -> cancelled, nothing ever frozen', () => {
  const dir = tmpdir();
  const engine = new Engine(dir, { quota: QUOTA });
  const cert = engine.apply({
    id: 'e1',
    type: 'instruction',
    tradeId: 't1',
    amount: AMOUNT,
    riskResult: 'approve',
    accountResult: 'insufficient',
  });
  assert.equal(cert.status, 'cancelled');
  assert.deepEqual(cert.quota, { available: QUOTA, frozen: 0 });
  const final = readLog(dir).at(-1);
  assert.equal(final.type, 'cancel');
  assert.equal(final.reason, 'account_insufficient');
});

test('out-of-order and duplicated branch events join exactly once', () => {
  const dir = tmpdir();
  const engine = new Engine(dir, { quota: QUOTA });
  engine.apply({ id: 'e1', type: 'instruction', tradeId: 't1', amount: AMOUNT });

  // account branch arrives before risk branch
  engine.apply({ id: 'a1', type: 'account', tradeId: 't1', frozen: true });
  assert.equal(engine.trades.get('t1').status, 'open');
  assert.deepEqual(engine.quota, { available: QUOTA - AMOUNT, frozen: AMOUNT });

  // duplicate account branch: no double freeze
  const dup = engine.apply({ id: 'a1', type: 'account', tradeId: 't1', frozen: true });
  assert.equal(dup.deduped, true);
  assert.deepEqual(engine.quota, { available: QUOTA - AMOUNT, frozen: AMOUNT });

  // risk branch completes the join
  const cert = engine.apply({ id: 'r1', type: 'risk', tradeId: 't1', approved: true });
  assert.equal(cert.status, 'confirmed');

  // duplicated risk branch and duplicated instruction change nothing
  engine.apply({ id: 'r1', type: 'risk', tradeId: 't1', approved: true });
  const again = engine.apply({
    id: 'e1',
    type: 'instruction',
    tradeId: 't1',
    amount: AMOUNT,
  });
  assert.equal(again.deduped, true);
  assert.deepEqual(engine.quota, { available: QUOTA - AMOUNT, frozen: 0 });
  assert.equal(readLog(dir).filter((e) => e.type === 'confirm').length, 1);
});

test('duplicate restarts do not change the final effect', () => {
  const dir = tmpdir();
  const first = new Engine(dir, { quota: QUOTA });
  first.apply({
    id: 'e1',
    type: 'instruction',
    tradeId: 't1',
    amount: AMOUNT,
    riskResult: 'approve',
    accountResult: 'sufficient',
  });
  const hash = first.stateHash();

  const second = new Engine(dir, { quota: QUOTA });
  const third = new Engine(dir, { quota: QUOTA });
  assert.equal(second.stateHash(), hash);
  assert.equal(third.stateHash(), hash);
  assert.deepEqual(third.quota, { available: QUOTA - AMOUNT, frozen: 0 });
  assert.equal(readLog(dir).filter((e) => e.type === 'confirm').length, 1);
});

test('finalize with only one branch arrived must fail', () => {
  const dir = tmpdir();
  const engine = new Engine(dir, { quota: QUOTA });
  engine.apply({ id: 'e1', type: 'instruction', tradeId: 't1', amount: AMOUNT });

  assert.throws(() => engine.finalize('t1'), (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'TRADE_NOT_READY');
    return true;
  });

  engine.apply({ id: 'r1', type: 'risk', tradeId: 't1', approved: true });
  assert.throws(
    () => engine.apply({ id: 'f1', type: 'finalize', tradeId: 't1' }),
    (err) => err.code === 'TRADE_NOT_READY'
  );
  assert.equal(engine.trades.get('t1').status, 'open');
});

test('enumerator: 4 branch outcomes x 2 fault points', () => {
  const RISK_RESULTS = ['approve', 'reject'];
  const ACCOUNT_RESULTS = ['sufficient', 'insufficient'];
  const FAULT_POINTS = ['none', 'crashBeforeConfirm'];

  const cases = [];
  for (const riskResult of RISK_RESULTS) {
    for (const accountResult of ACCOUNT_RESULTS) {
      for (const fault of FAULT_POINTS) {
        cases.push({ riskResult, accountResult, fault });
      }
    }
  }
  assert.equal(cases.length, 8);

  // Independent expectation model: the join confirms only when the risk
  // branch approved AND the account branch froze the amount; anything else
  // cancels and releases whatever was frozen.
  function expected({ riskResult, accountResult }) {
    const approved = riskResult === 'approve';
    const frozen = accountResult === 'sufficient';
    if (approved && frozen) {
      return { status: 'confirmed', available: QUOTA - AMOUNT, frozen: 0 };
    }
    return { status: 'cancelled', available: QUOTA, frozen: 0 };
  }

  for (const c of cases) {
    const label = JSON.stringify(c);
    const dir = tmpdir();
    const event = {
      id: 'e1',
      type: 'instruction',
      tradeId: 't1',
      amount: AMOUNT,
      riskResult: c.riskResult,
      accountResult: c.accountResult,
      crashBeforeConfirm: c.fault === 'crashBeforeConfirm',
    };

    let engine = new Engine(dir, { quota: QUOTA });
    const first = engine.apply(event);
    if (c.fault === 'crashBeforeConfirm') {
      // crash: both branches persisted, join not yet done
      assert.equal(first.crashed, true, label);
      assert.equal(engine.trades.get('t1').status, 'open', label);
      // restart recovers and finishes the join; a second restart is a no-op
      engine = new Engine(dir, { quota: QUOTA });
      engine = new Engine(dir, { quota: QUOTA });
    }

    const want = expected(c);
    const trade = engine.trades.get('t1');
    assert.equal(trade.status, want.status, label);
    assert.deepEqual(engine.quota, { available: want.available, frozen: want.frozen }, label);

    // exactly one final event persisted, even across restarts
    const finals = readLog(dir).filter((e) => e.type === 'confirm' || e.type === 'cancel');
    assert.equal(finals.length, 1, label);
    assert.equal(finals[0].type, want.status === 'confirmed' ? 'confirm' : 'cancel', label);

    // re-applying the same instruction is idempotent
    const again = engine.apply(event);
    assert.equal(again.deduped, true, label);
    assert.deepEqual(engine.quota, { available: want.available, frozen: want.frozen }, label);
  }
});
