'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPatch } = require('../src/diff');
const { applyOps } = require('../src/apply');
const { stateHash, validateState } = require('../src/state');

// Independent enumerator: generates every valid target state for up to
// 3 accounts with up to 2 holds each (<= 6 accounts/holds total).
// Per account: limit in {100,200}, holds = any subset of the 2-hold pool,
// and h1's tag in {'a','x'} (exercises changeTag). `used` stays fixed per
// account because the patch format has no op for it.
// All combinations stay valid because max used+holds = 50+30 <= min limit.
function* enumAccounts(used) {
  const pool = [
    { hid: 'h1', amount: 10 },
    { hid: 'h2', amount: 20 },
  ];
  for (const limit of [100, 200]) {
    for (let mask = 0; mask < 4; mask++) {
      for (const tag of ['a', 'x']) {
        const holds = pool
          .filter((_, i) => mask & (1 << i))
          .map((h) => ({ ...h, tag: h.hid === 'h1' ? tag : 'b' }));
        yield { limit, used, holds };
      }
    }
  }
}

function* enumTargets(baseState) {
  const accountIds = Object.keys(baseState.accounts);
  const optionsPerAccount = accountIds.map((id) => [...enumAccounts(baseState.accounts[id].used)]);
  const combo = new Array(accountIds.length);
  function* rec(i) {
    if (i === accountIds.length) {
      const accounts = {};
      accountIds.forEach((id, j) => { accounts[id] = JSON.parse(JSON.stringify(combo[j])); });
      yield { accounts };
      return;
    }
    for (const opt of optionsPerAccount[i]) {
      combo[i] = opt;
      yield* rec(i + 1);
    }
  }
  yield* rec(0);
}

const base = {
  accounts: {
    a1: { limit: 150, used: 20, holds: [{ hid: 'h1', amount: 10, tag: 'a' }] },
    a2: { limit: 100, used: 0, holds: [] },
    a3: { limit: 200, used: 50, holds: [{ hid: 'h2', amount: 20, tag: 'b' }] },
  },
};

test('enumerator: diff/apply/revert roundtrip for all targets (n<=6 accounts/holds)', () => {
  const fromHash = stateHash(base);
  let count = 0;
  for (const target of enumTargets(base)) {
    count++;
    assert.equal(validateState(target), null);
    const patch = buildPatch(base, target);
    assert.equal(patch.fromHash, fromHash);
    assert.equal(patch.toHash, stateHash(target));

    // apply: base -> target
    const applied = applyOps(base, patch.ops);
    assert.ok(applied.ok, `apply failed at op ${applied.error && applied.error.opIndex}`);
    assert.equal(stateHash(applied.state), patch.toHash);
    assert.deepEqual(applied.state, target);

    // idempotent: applying ops on top of target is NOT required; the CLI
    // no-ops on toHash. Here verify revert instead.
    const reverted = applyOps(applied.state, patch.inverse);
    assert.ok(reverted.ok, `revert failed at op ${reverted.error && reverted.error.opIndex}`);
    assert.equal(stateHash(reverted.state), fromHash);
    assert.deepEqual(reverted.state, base);
  }
  assert.equal(count, 16 ** 3); // 4096 targets, 3 accounts x <=2 holds
});

test('enumerator: invalid targets are rejected by buildPatch', () => {
  const bad = {
    accounts: {
      ...base.accounts,
      a1: { limit: 5, used: 20, holds: [] }, // limit < used
    },
  };
  assert.throws(() => buildPatch(base, bad), /invalid target state/);
});
