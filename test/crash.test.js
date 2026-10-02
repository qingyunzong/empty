import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Wal, recoverWal, serializeLedger, CrashFault } from '../src/index.js';
import { makeTxn, makeLedgerJson, makeWorkspace, writeJson, runPlanOnFiles } from './helpers.js';

function setupBatch(dir, txnCount = 5) {
  const entries = [];
  for (let i = 0; i < txnCount; i += 1) {
    entries.push(...makeTxn(`txn:${i + 1}`, `acct:u${i}`, 'acct:revenue', `${10 + i}.00`, 'SETTLED', 1));
  }
  const planPath = path.join(dir, 'plan.rvx');
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(planPath, 'for tx in txns(*) { revoke tx; }\n');
  writeJson(ledgerPath, makeLedgerJson(entries));
  return { planPath, ledgerPath };
}

test('acceptance 2: crash after SAVEPOINT, recover replays to the no-crash reference state', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath } = setupBatch(dir);

  // Reference: full run without crash.
  const refWal = path.join(dir, 'ref.wal');
  const ref = runPlanOnFiles(planPath, ledgerPath, refWal);
  const reference = JSON.stringify(serializeLedger(ref.ledger));

  // Find the WAL seq of the first SAVEPOINT so we can crash right after it.
  const { records } = Wal.read(refWal);
  const savepoint = records.find((r) => r.op === 'SAVEPOINT');
  assert.ok(savepoint, 'plan emits SAVEPOINT records');

  // Crashed run: fault injected immediately after the SAVEPOINT record is written.
  const crashWal = path.join(dir, 'crash.wal');
  assert.throws(
    () => runPlanOnFiles(planPath, ledgerPath, crashWal, { crashAfterSeq: savepoint.seq }),
    (e) => e instanceof CrashFault,
  );

  // Recovery must replay the WAL and finish the plan to the exact reference state.
  const { ledger: recovered, resumed } = recoverWal(crashWal);
  assert.equal(resumed, true);
  assert.equal(JSON.stringify(serializeLedger(recovered)), reference);
});

test('acceptance 2b: crash at every instruction boundary still recovers to reference', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath } = setupBatch(dir, 3);
  const refWal = path.join(dir, 'ref.wal');
  const ref = runPlanOnFiles(planPath, ledgerPath, refWal);
  const reference = JSON.stringify(serializeLedger(ref.ledger));
  const { records } = Wal.read(refWal);
  const maxSeq = records.filter((r) => r.type !== 'done').at(-1).seq;

  for (let seq = 1; seq <= maxSeq; seq += 1) {
    const walPath = path.join(dir, `crash-${seq}.wal`);
    assert.throws(
      () => runPlanOnFiles(planPath, ledgerPath, walPath, { crashAfterSeq: seq }),
      (e) => e instanceof CrashFault,
    );
    const { ledger } = recoverWal(walPath);
    assert.equal(JSON.stringify(serializeLedger(ledger)), reference, `crash at seq=${seq}`);
  }
});

test('recovery is idempotent: recovering twice yields the same ledger', () => {
  const dir = makeWorkspace();
  const { planPath, ledgerPath } = setupBatch(dir, 3);
  const walPath = path.join(dir, 'crash.wal');
  assert.throws(() => runPlanOnFiles(planPath, ledgerPath, walPath, { crashAfterSeq: 3 }), CrashFault);
  const first = recoverWal(walPath);
  const second = recoverWal(walPath);
  assert.equal(JSON.stringify(serializeLedger(first.ledger)), JSON.stringify(serializeLedger(second.ledger)));
});
