import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balancesObject, serializeLedger, loadLedger } from '../src/index.js';
import { genLedger, oracleBalances, runPlanInMemory, mulberry32 } from './helpers.js';

const stripZeros = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== 0));

test('acceptance 4: random 50-txn ledgers match the brute-force state-machine oracle', () => {
  for (const seed of [1, 7, 42, 1337, 20261003, 99991, 5, 314159]) {
    const { ledgerJson, ids } = genLedger(seed, 50);
    const rng = mulberry32(seed * 31 + 1);
    const targets = ids.filter(() => rng() < 0.7);
    const plan = `for tx in txns(${targets.join(', ')}) { revoke tx; }`;
    const { ledger } = runPlanInMemory(plan, ledgerJson);
    const vmBalances = stripZeros(balancesObject(ledger));
    const expected = stripZeros(oracleBalances(ledgerJson, targets));
    assert.deepEqual(vmBalances, expected, `seed=${seed}`);
    const total = Object.values(vmBalances).reduce((a, b) => a + b, 0);
    assert.equal(total, 0, `seed=${seed}: balanced ledger sums to zero`);
  }
});

test('acceptance 4b: fuzz result ledger survives a serialize/load round-trip', () => {
  const { ledgerJson, ids } = genLedger(77, 50);
  const plan = `for tx in txns(${ids.slice(0, 30).join(', ')}) { revoke tx; }`;
  const { ledger } = runPlanInMemory(plan, ledgerJson);
  const reloaded = loadLedger(JSON.parse(JSON.stringify(serializeLedger(ledger))));
  assert.deepEqual(balancesObject(reloaded), balancesObject(ledger));
});
