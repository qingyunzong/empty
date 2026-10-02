import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, applyOp } from '../src/limit.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('20k operations: completes and invariants hold throughout', () => {
  const rand = lcg(20261003);
  const ledger = new Ledger();
  ledger.open('alice', 100000);

  const activeIds = [];
  let now = 0;
  const total = 20000;
  let okCount = 0;
  let errCount = 0;

  const checkInvariants = () => {
    const acct = ledger.account('alice');
    assert.ok(acct.frozen >= 0, 'frozen >= 0');
    assert.ok(acct.used >= 0, 'used >= 0');
    assert.ok(acct.frozen + acct.used <= acct.creditLimit, 'frozen+used <= limit');
    let sum = 0;
    for (const auth of ledger.auths.values()) {
      if (auth.state === 'active') sum += auth.amount - auth.captured;
    }
    assert.equal(acct.frozen, sum, 'frozen equals sum of active remaining');
  };

  for (let i = 0; i < total; i++) {
    now += Math.floor(rand() * 3);
    const kind = rand();
    let op;
    if (kind < 0.45 || activeIds.length === 0) {
      const authId = `a${i}`;
      op = {
        op: 'freeze',
        authId,
        acc: 'alice',
        amount: 1 + Math.floor(rand() * 2000),
        ttl: Math.floor(rand() * 50),
        t: now,
      };
      activeIds.push(authId);
    } else {
      const authId = activeIds[Math.floor(rand() * activeIds.length)];
      const pick = rand();
      if (pick < 0.5) {
        op = { op: 'capture', authId, amount: 1 + Math.floor(rand() * 1000), t: now };
      } else if (pick < 0.75) {
        op = { op: 'release', authId, t: now };
      } else if (pick < 0.9) {
        op = { op: 'extend', authId, ttl: Math.floor(rand() * 50), t: now };
      } else {
        op = { op: 'scan', t: now };
      }
    }
    const result = applyOp(ledger, op);
    if (result === 'ok') okCount++;
    else errCount++;
    if (i % 1000 === 0) checkInvariants();
  }
  checkInvariants();
  assert.equal(okCount + errCount, total);
  assert.ok(okCount > total / 2, `expected mostly successful ops, got ${okCount}`);
});
