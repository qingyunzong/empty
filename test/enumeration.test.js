'use strict';

// Acceptance D: cross-check the engine against an independent naive reference
// over all op sequences up to length 4 (2 accounts), plus seeded random
// sequences up to length 10 including batches and undo, checking invariants
// after every step and undo-restore consistency.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, checkInvariants } = require('../src/engine');

function refApply(state, op) {
  const next = {
    accounts: structuredClone(state.accounts),
    budget: state.budget ? { ...state.budget } : null,
  };
  const acc = (n) => {
    if (!next.accounts[n]) next.accounts[n] = { balance: 0, frozen: 0 };
    return next.accounts[n];
  };
  const avail = (n) => {
    const a = next.accounts[n] || { balance: 0, frozen: 0 };
    return a.balance - a.frozen;
  };
  let err = null;
  switch (op.op) {
    case 'deposit':
      acc(op.account).balance += op.amount;
      if (next.budget) next.budget.day -= op.amount;
      break;
    case 'withdraw':
      if (avail(op.account) < op.amount) err = 'INSUFFICIENT';
      else {
        acc(op.account).balance -= op.amount;
        if (next.budget) next.budget.day -= op.amount;
      }
      break;
    case 'transfer':
      if (avail(op.from) < op.amount) err = 'INSUFFICIENT';
      else {
        acc(op.from).balance -= op.amount;
        acc(op.to).balance += op.amount;
        if (next.budget) next.budget.day -= op.amount;
      }
      break;
    case 'freeze':
      if (avail(op.account) < op.amount) err = 'INSUFFICIENT';
      else acc(op.account).frozen += op.amount;
      break;
    case 'unfreeze': {
      const frozen = (next.accounts[op.account] || { frozen: 0 }).frozen;
      if (frozen < op.amount) err = 'INSUFFICIENT';
      else acc(op.account).frozen -= op.amount;
      break;
    }
  }
  if (!err && !checkInvariants(next.accounts, next.budget)) err = 'INVARIANT';
  if (err) return { state, err };
  const touched = op.account !== undefined ? [op.account] : [op.from, op.to];
  for (const n of touched) {
    const a = next.accounts[n];
    if (a && a.balance === 0 && a.frozen === 0) delete next.accounts[n];
  }
  return { state: next, err: null };
}

const MONEY_ALPHABET = [
  { op: 'deposit', account: 'a', amount: 10 },
  { op: 'deposit', account: 'b', amount: 25 },
  { op: 'withdraw', account: 'a', amount: 10 },
  { op: 'withdraw', account: 'b', amount: 10 },
  { op: 'transfer', from: 'a', to: 'b', amount: 10 },
  { op: 'transfer', from: 'b', to: 'a', amount: 25 },
  { op: 'freeze', account: 'a', amount: 10 },
  { op: 'freeze', account: 'b', amount: 10 },
  { op: 'unfreeze', account: 'a', amount: 10 },
  { op: 'unfreeze', account: 'b', amount: 10 },
];

test('D1: exhaustive money-op sequences (len <= 4, 2 accounts) match reference', () => {
  const budgetSpec = { day: 60 };
  let checked = 0;
  const compare = (seq) => {
    const engine = new Engine({ budget: { ...budgetSpec } });
    let ref = { accounts: {}, budget: { ...budgetSpec } };
    for (const op of seq) {
      const r = engine.apply(op);
      const expected = refApply(ref, op);
      if (expected.err) {
        assert.equal(r.status, 'error', 'seq=' + JSON.stringify(seq));
        assert.equal(r.error.code, expected.err, 'seq=' + JSON.stringify(seq));
      } else {
        assert.equal(r.status, 'ok', 'seq=' + JSON.stringify(seq) + ': ' + JSON.stringify(r.error));
      }
      ref = expected.state;
      assert.deepEqual(r.state, ref, 'seq=' + JSON.stringify(seq));
      checked++;
    }
  };
  const walk = (prefix, depth) => {
    compare(prefix);
    if (depth === 0) return;
    for (const op of MONEY_ALPHABET) walk([...prefix, op], depth - 1);
  };
  walk([], 4);
  assert.ok(checked > 10000, 'expected >10k steps, got ' + checked);
});

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOp(rand) {
  const kinds = ['deposit', 'withdraw', 'transfer', 'freeze', 'unfreeze', 'batchBegin', 'batchEnd', 'undo'];
  const kind = kinds[Math.floor(rand() * kinds.length)];
  const acct = () => (rand() < 0.5 ? 'a' : 'b');
  const amount = [0, 5, 10, 25, 60][Math.floor(rand() * 5)];
  switch (kind) {
    case 'transfer': {
      const from = acct();
      return { op: 'transfer', from, to: from === 'a' ? 'b' : 'a', amount };
    }
    case 'batchBegin':
      return { op: 'batchBegin', id: rand() < 0.5 ? 'b1' : 'b2' };
    case 'batchEnd':
      return { op: 'batchEnd' };
    case 'undo':
      return rand() < 0.3 ? { op: 'undo', batch: rand() < 0.5 ? 'b1' : 'b2' } : { op: 'undo' };
    default:
      return { op: kind, account: acct(), amount };
  }
}

test('D2: random sequences (len <= 10) keep invariants and undo restores state', () => {
  const rand = mulberry32(20261006);
  const SEQS = 400;
  for (let s = 0; s < SEQS; s++) {
    const engine = new Engine({ budget: { day: 200 } });
    const markers = [];
    let batchOpen = false;
    let prevState = engine.snapshotState();
    const len = 1 + Math.floor(rand() * 10);
    for (let i = 0; i < len; i++) {
      const op = randomOp(rand);
      const r = engine.apply(op);
      assert.ok(
        checkInvariants(r.state.accounts, r.state.budget),
        'invariant broken after ' + JSON.stringify(op)
      );
      if (r.status === 'error') {
        if (op.op === 'undo') {
          // failed undo pops nothing
          assert.deepEqual(r.state, prevState, 'failed undo must not change state');
        } else if (batchOpen && op.op !== 'batchBegin' && op.op !== 'batchEnd') {
          const begin = markers.pop();
          batchOpen = false;
          assert.deepEqual(r.state, begin.preState, 'aborted batch must roll back to batch-begin state');
        } else {
          assert.deepEqual(r.state, prevState, 'failed op must not change state: ' + JSON.stringify(op));
        }
        prevState = r.state;
        continue;
      }
      switch (op.op) {
        case 'batchBegin':
          batchOpen = true;
          markers.push({ id: op.id !== undefined ? op.id : null, preState: prevState, begin: true });
          break;
        case 'batchEnd': {
          const begin = markers.pop();
          markers.push({ id: begin.id, preState: begin.preState });
          batchOpen = false;
          break;
        }
        case 'undo': {
          let oldest;
          if (op.batch !== undefined) {
            do {
              oldest = markers.pop();
            } while (oldest.id !== op.batch);
          } else {
            oldest = markers.pop();
          }
          assert.deepEqual(
            r.state,
            oldest.preState,
            'undo did not restore pre-unit state for ' + JSON.stringify(op)
          );
          break;
        }
        default:
          if (!batchOpen) markers.push({ id: null, preState: prevState });
      }
      prevState = r.state;
    }
  }
});
