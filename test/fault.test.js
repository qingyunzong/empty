import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, runCli, initLedger, appendTx } from './helpers.js';

const FAULT_POINTS = ['tmp-write', 'rename', 'head-update'];

function noStaleTmpFiles(dir) {
  const root = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  const txs = fs.readdirSync(path.join(dir, 'txs')).filter((n) => n.includes('.tmp-'));
  return root.length === 0 && txs.length === 0;
}

for (const point of FAULT_POINTS) {
  test(`fault injection at ${point} during append leaves a consistent chain`, () => {
    const dir = makeDir();
    initLedger(dir);
    const first = appendTx(dir, { id: 't1', amount: 10, account: 'a', payloadHash: 'p1' });
    assert.equal(first.status, 0);
    const headBefore = runCli(['verify'], { dir }).json.head;

    const file = path.join(dir, 'fault-tx.json');
    fs.writeFileSync(file, JSON.stringify({ id: 't2', amount: 20, account: 'a', payloadHash: 'p2' }));
    const res = runCli(['append', file], { dir, env: { LEDGER_FAULT: point } });
    assert.equal(res.status, 99);
    assert.equal(res.errJson.error.code, 'FAULT_INJECTED');

    const verify = runCli(['verify'], { dir });
    assert.equal(verify.status, 0, verify.stderr);
    // crash happened before the HEAD commit point: old chain must be intact
    assert.equal(verify.json.head, headBefore);
    assert.equal(verify.json.height, 1);
    assert.ok(noStaleTmpFiles(dir), 'recovery cleans stale tmp files');

    // ledger still usable afterwards
    const retry = appendTx(dir, { id: 't2', amount: 20, account: 'a', payloadHash: 'p2' });
    assert.equal(retry.status, 0);
    assert.equal(runCli(['verify'], { dir }).json.height, 2);
  });
}

for (const point of FAULT_POINTS) {
  test(`fault injection at ${point} during rewrite leaves old or new chain complete`, () => {
    const dir = makeDir();
    initLedger(dir);
    const anchor = appendTx(dir, { id: 'a0', amount: 1, account: 'r', payloadHash: 'p0' }).json.hash;
    appendTx(dir, { id: 'n1', amount: 5, account: 'a', payloadHash: 'p1' });
    appendTx(dir, { id: 'n2', amount: -5, account: 'a', payloadHash: 'p2' });
    appendTx(dir, { id: 'n3', amount: 8, account: 'b', payloadHash: 'p3' });
    const before = runCli(['verify'], { dir }).json;

    const res = runCli(['rewrite', '--keep-published', anchor], { dir, env: { LEDGER_FAULT: point } });
    assert.equal(res.status, 99);
    assert.equal(res.errJson.error.code, 'FAULT_INJECTED');

    const verify = runCli(['verify'], { dir });
    assert.equal(verify.status, 0, verify.stderr);
    // all three injection points are before the HEAD commit: old chain intact
    assert.equal(verify.json.head, before.head);
    assert.deepEqual(verify.json.accounts, before.accounts);
    assert.ok(noStaleTmpFiles(dir));

    // rewrite can be retried successfully after recovery
    const retry = runCli(['rewrite', '--keep-published', anchor], { dir });
    assert.equal(retry.status, 0, retry.stderr);
    const after = runCli(['verify'], { dir });
    assert.equal(after.status, 0);
    // account nets are unchanged; accounts reduced to zero simply disappear
    const nonZero = Object.fromEntries(
      Object.entries(before.accounts).filter(([, v]) => v !== 0),
    );
    assert.deepEqual(after.json.accounts, nonZero);
    assert.equal(after.json.published, anchor);
  });
}

test('a completed rewrite survives a later crash during an unrelated append', () => {
  const dir = makeDir();
  initLedger(dir);
  const anchor = appendTx(dir, { id: 'a0', amount: 1, account: 'r', payloadHash: 'p0' }).json.hash;
  appendTx(dir, { id: 'n1', amount: 4, account: 'a', payloadHash: 'p1' });
  appendTx(dir, { id: 'n2', amount: -4, account: 'a', payloadHash: 'p2' });
  const rewrite = runCli(['rewrite', '--keep-published', anchor], { dir });
  assert.equal(rewrite.status, 0);
  const newHead = runCli(['verify'], { dir }).json.head;

  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'n3', amount: 1, account: 'a', payloadHash: 'p3' }));
  runCli(['append', file], { dir, env: { LEDGER_FAULT: 'head-update' } });

  const verify = runCli(['verify'], { dir });
  assert.equal(verify.status, 0);
  assert.equal(verify.json.head, newHead);
});
