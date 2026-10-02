import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serializeLedger, balancesObject } from '../src/index.js';
import { makeTxn, makeLedgerJson, makeWorkspace, writeJson, runPlanOnFiles } from './helpers.js';

const PLAN = 'param rev_id = "rev-42";\nfor tx in txns(*) { revoke tx; }\n';

function batchLedger() {
  return makeLedgerJson([
    ...makeTxn('txn:1', 'acct:a', 'acct:r', '10.00', 'SETTLED', 1),
    ...makeTxn('txn:2', 'acct:b', 'acct:r', '20.00', 'LOCKED', 0),
    ...makeTxn('txn:3', 'acct:c', 'acct:r', '30.00', 'PENDING', 2),
  ]);
}

test('acceptance 3: re-submitting the same revocation never double-reverses', () => {
  const dir = makeWorkspace();
  const planPath = path.join(dir, 'plan.rvx');
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(planPath, PLAN);
  writeJson(ledgerPath, batchLedger());

  const first = runPlanOnFiles(planPath, ledgerPath, path.join(dir, 'run1.wal'));
  assert.deepEqual(first.counts, { reversed: 1, compensated: 1, cancelRequested: 1, skipped: 0 });
  const firstJson = JSON.stringify(serializeLedger(first.ledger));

  // Second submission of the exact same plan (same revId) against the result.
  const outPath = path.join(dir, 'ledger2.json');
  writeJson(outPath, serializeLedger(first.ledger));
  const second = runPlanOnFiles(planPath, outPath, path.join(dir, 'run2.wal'));
  assert.deepEqual(second.counts, { reversed: 0, compensated: 0, cancelRequested: 0, skipped: 3 });
  assert.equal(JSON.stringify(serializeLedger(second.ledger)), firstJson, 'ledger is byte-identical');
  assert.deepEqual(balancesObject(second.ledger), balancesObject(first.ledger));
});

test('duplicate target within one batch raises E_DUP with txnId and pc', () => {
  const dir = makeWorkspace();
  const planPath = path.join(dir, 'plan.rvx');
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(planPath, 'for tx in txns(txn:1, txn:1) { revoke tx; }\n');
  writeJson(ledgerPath, makeLedgerJson([
    ...makeTxn('txn:1', 'acct:a', 'acct:r', '10.00', 'SETTLED', 1),
  ]));
  assert.throws(
    () => runPlanOnFiles(planPath, ledgerPath, path.join(dir, 'dup.wal')),
    (e) => e.code === 'E_DUP' && e.txnId === 'txn:1' && typeof e.pc === 'number',
  );
});

test('revoking a terminal txn raises E_STATE with txnId and pc', () => {
  const dir = makeWorkspace();
  const planPath = path.join(dir, 'plan.rvx');
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(planPath, 'revoke txn:1;\n');
  writeJson(ledgerPath, makeLedgerJson([
    ...makeTxn('txn:1', 'acct:a', 'acct:r', '10.00', 'REVERSED', 1),
  ]));
  assert.throws(
    () => runPlanOnFiles(planPath, ledgerPath, path.join(dir, 'state.wal')),
    (e) => e.code === 'E_STATE' && e.txnId === 'txn:1' && typeof e.pc === 'number',
  );
});
