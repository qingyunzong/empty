import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, applyOp } from '../src/limit.js';
import { checkLinearizable } from '../src/linearize.js';

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function bruteForce(log) {
  for (const order of permutations(log.map((_, i) => i))) {
    const ledger = new Ledger();
    let ok = true;
    for (const i of order) {
      if (applyOp(ledger, log[i]) !== (log[i].result ?? 'ok')) {
        ok = false;
        break;
      }
    }
    if (ok) return order;
  }
  return null;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomOp(rand, i) {
  const authId = `a${Math.floor(rand() * 3)}`;
  const t = Math.floor(rand() * 30);
  const kind = Math.floor(rand() * 4);
  if (kind === 0) {
    return { op: 'freeze', authId, acc: 'alice', amount: 10 + Math.floor(rand() * 80), ttl: 5 + Math.floor(rand() * 20), t };
  }
  if (kind === 1) return { op: 'capture', authId, amount: 5 + Math.floor(rand() * 60), t };
  if (kind === 2) return { op: 'release', authId, t };
  return { op: 'extend', authId, ttl: 5 + Math.floor(rand() * 20), t };
}

function randomLog(rand) {
  const ops = [randomOp(rand, 0), randomOp(rand, 1), randomOp(rand, 2)];
  if (rand() < 0.5) {
    const ledger = new Ledger();
    ledger.open('alice', 100);
    for (const op of ops) op.result = applyOp(ledger, op);
  } else {
    const codes = ['ok', 'ok', 'E_LIMIT', 'E_STATE', 'E_EXPIRED'];
    for (const op of ops) op.result = codes[Math.floor(rand() * codes.length)];
  }
  return [{ op: 'open', acc: 'alice', creditLimit: 100, t: 0, result: 'ok' }, ...ops];
}

test('C: checker agrees with brute-force permutation search (accept and reject)', () => {
  const rand = lcg(42);
  let accepts = 0;
  let rejects = 0;
  for (let iter = 0; iter < 500; iter++) {
    const log = randomLog(rand);
    const expected = bruteForce(log) !== null;
    const { linearizable, witness } = checkLinearizable(log);
    assert.equal(linearizable, expected, `mismatch on ${JSON.stringify(log)}`);
    if (linearizable) {
      accepts++;
      const ledger = new Ledger();
      for (const i of witness) {
        assert.equal(applyOp(ledger, log[i]), log[i].result ?? 'ok');
      }
    } else {
      rejects++;
    }
  }
  assert.ok(accepts > 50, `too few accept cases: ${accepts}`);
  assert.ok(rejects > 50, `too few reject cases: ${rejects}`);
});

test('C: concurrent captures on one auth are serializable only in capture-compatible order', () => {
  const log = [
    { op: 'open', acc: 'alice', creditLimit: 100, t: 0, result: 'ok' },
    { op: 'freeze', authId: 'a1', acc: 'alice', amount: 100, ttl: 1000, t: 0, result: 'ok' },
    { op: 'capture', authId: 'a1', amount: 60, t: 1, result: 'ok' },
    { op: 'capture', authId: 'a1', amount: 60, t: 1, result: 'E_LIMIT' },
  ];
  const { linearizable, witness } = checkLinearizable(log);
  assert.equal(linearizable, true);
  assert.deepEqual(witness, [0, 1, 2, 3]);
});

test('C: impossible recorded results are rejected', () => {
  const log = [
    { op: 'open', acc: 'alice', creditLimit: 100, t: 0, result: 'ok' },
    { op: 'freeze', authId: 'a1', acc: 'alice', amount: 100, ttl: 10, t: 0, result: 'ok' },
    { op: 'capture', authId: 'a1', amount: 100, t: 5, result: 'ok' },
    { op: 'capture', authId: 'a1', amount: 100, t: 6, result: 'ok' },
  ];
  assert.equal(checkLinearizable(log).linearizable, false);
});

test('C: expiry reordering — capture recorded ok only if it precedes the expiry-inducing op', () => {
  const log = [
    { op: 'open', acc: 'alice', creditLimit: 100, t: 0, result: 'ok' },
    { op: 'freeze', authId: 'a1', acc: 'alice', amount: 50, ttl: 10, t: 0, result: 'ok' },
    { op: 'capture', authId: 'a1', amount: 30, t: 5, result: 'ok' },
    { op: 'release', authId: 'a1', t: 20, result: 'E_EXPIRED' },
  ];
  assert.equal(checkLinearizable(log).linearizable, true);

  const flipped = log.map((e, i) => (i === 3 ? { ...e, result: 'ok' } : e));
  assert.equal(checkLinearizable(flipped).linearizable, false);
});
