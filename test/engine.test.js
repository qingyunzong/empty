import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine, TradeError, BRANCHES } from '../src/engine.js';

const INITIAL = 1_000;
const AMOUNT = 120;
const FEE = 7;

function setup({ irreversible = false } = {}) {
  const engine = new TradingEngine();
  engine.deposit('acct', INITIAL);
  engine.executeTrade({
    tradeId: 't1',
    accountId: 'acct',
    amount: AMOUNT,
    fee: FEE,
    irreversible,
  });
  return engine;
}

function failOnceAt(branch) {
  const calls = Object.fromEntries(BRANCHES.map((b) => [b, 0]));
  let tripped = false;
  const hooks = {};
  for (const b of BRANCHES) {
    hooks[b] = () => {
      calls[b] += 1;
      if (b === branch && !tripped) {
        tripped = true;
        throw new Error(`boom on ${b}`);
      }
    };
  }
  return { hooks, calls };
}

test('cancel interrupted at any of the three stages eventually rolls back all resources', () => {
  for (const stage of BRANCHES) {
    const engine = setup();
    const { hooks } = failOnceAt(stage);

    const first = engine.cancelTrade('t1', hooks);
    assert.equal(first.status, 'CANCELLING', `stage ${stage}`);
    assert.equal(first.failed.branch, stage);
    assert.equal(first.certificate, null);

    const second = engine.cancelTrade('t1');
    assert.equal(second.status, 'CANCELLED', `stage ${stage}`);

    const account = engine.getAccount('acct');
    assert.deepEqual(account, { accountId: 'acct', available: INITIAL, reserved: 0 });
    assert.equal(engine.state.feesCollected, 0);
    assert.equal(Object.keys(engine.state.matches).length, 0);
    assert.deepEqual(second.certificate.compensated, BRANCHES);
  }
});

test('repeated cancel and repeated ACK never refund twice', () => {
  const engine = setup();
  const first = engine.cancelTrade('t1');
  assert.equal(first.status, 'CANCELLED');
  const snapshot = JSON.stringify(engine.state.accounts);

  // Repeated cancel requests are idempotent and return the same certificate.
  for (let i = 0; i < 3; i += 1) {
    const again = engine.cancelTrade('t1');
    assert.equal(again.status, 'CANCELLED');
    assert.deepEqual(again.certificate, first.certificate);
  }
  // Repeated ACKs on already-ACKed branches are no-ops.
  for (const branch of BRANCHES) {
    const ack = engine.acknowledge('t1', branch);
    assert.equal(ack.applied, false);
  }
  assert.equal(JSON.stringify(engine.state.accounts), snapshot);
  assert.equal(engine.getAccount('acct').available, INITIAL);
  assert.equal(engine.state.feesCollected, 0);
});

test('irreversible trade is rejected with IRREVERSIBLE_CONFLICT and nothing changes', () => {
  const engine = setup({ irreversible: true });
  const before = JSON.stringify(engine.state);

  assert.throws(
    () => engine.cancelTrade('t1'),
    (err) => err instanceof TradeError && err.code === 'IRREVERSIBLE_CONFLICT',
  );

  assert.equal(JSON.stringify(engine.state), before);
  const account = engine.getAccount('acct');
  assert.deepEqual(account, {
    accountId: 'acct',
    available: INITIAL - AMOUNT - FEE,
    reserved: AMOUNT,
  });
  assert.equal(engine.state.feesCollected, FEE);
  assert.ok(engine.state.matches.t1);
  assert.equal(engine.getTrade('t1').status, 'EXECUTED');
  assert.equal(engine.getTrade('t1').compensationLog.length, 0);
});

test('failed branch recovers: resume skips ACKed branches, order and certificate correct', () => {
  const engine = setup();
  const { hooks, calls } = failOnceAt('REFUND_FEE');

  const first = engine.cancelTrade('t1', hooks);
  assert.equal(first.status, 'CANCELLING');
  assert.deepEqual(first.acked, ['UNDO_MATCH']);
  // UNDO_MATCH applied, fee not yet refunded, reserve still occupied.
  assert.equal(Object.keys(engine.state.matches).length, 0);
  assert.equal(engine.state.feesCollected, FEE);
  assert.equal(engine.getAccount('acct').reserved, AMOUNT);

  const second = engine.cancelTrade('t1', hooks);
  assert.equal(second.status, 'CANCELLED');
  // The ACKed UNDO_MATCH branch was never invoked again.
  assert.equal(calls.UNDO_MATCH, 1);
  assert.equal(calls.REFUND_FEE, 2); // failed once, retried once
  assert.equal(calls.RELEASE_RESERVE, 1);

  const cert = second.certificate;
  assert.deepEqual(cert.compensated, ['UNDO_MATCH', 'REFUND_FEE', 'RELEASE_RESERVE']);
  assert.deepEqual(
    cert.compensationLog.map((e) => [e.seq, e.branch]),
    [[1, 'UNDO_MATCH'], [2, 'REFUND_FEE'], [3, 'RELEASE_RESERVE']],
  );
  assert.deepEqual(cert.account, { accountId: 'acct', available: INITIAL, reserved: 0 });
  assert.equal(cert.feesCollected, 0);
});
