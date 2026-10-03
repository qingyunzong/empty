// Acceptance 1: while the backfill runs, inserts / payments / reversals /
// risk-flag changes execute concurrently; once finished, index queries match
// the by-version full-table-scan reference for every risk flag.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CLI, makeDir, ok, run, tx, seedAccounts } from '../test-support/util.js';

function waitExit(child, errFile) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`build-index exited ${code}: ${fs.readFileSync(errFile, 'utf8')}`))));
  });
}

test('backfill concurrent with insert/pay/reverse/risk load', async () => {
  const dir = makeDir();
  await seedAccounts(dir, 12);

  const errFile = `${dir}/.build.err.log`;
  const errFd = fs.openSync(errFile, 'w');
  const builder = spawn(process.execPath,
    [CLI, '--dir', dir, 'build-index', '--batch', '1', '--delay-ms', '25'],
    { stdio: ['ignore', 'ignore', errFd] });
  const done = waitExit(builder, errFile);

  // Wait until the backfill has actually started before hammering it.
  for (let i = 0; i < 300; i++) {
    const st = await run(dir, ['status']);
    if (st.json?.index?.state === 'building') break;
    await new Promise((r) => setTimeout(r, 10));
  }

  for (let i = 0; i < 8; i++) {
    await tx(dir, [
      { op: 'insert', account: `N${i}`, amount: 500 },
      { op: 'risk', account: `N${i}`, flag: `R${i % 3}` },
    ]);
    await tx(dir, [{ op: 'pay', account: `A${i}`, id: `p${i}`, amount: 100 }]);
    if (i % 2 === 0) await tx(dir, [{ op: 'reverse', payment: `p${i}` }]);
    if (i % 3 === 0) await tx(dir, [{ op: 'risk', account: `A${i}`, flag: `R${(i + 1) % 3}` }]);
  }

  await done;

  const st = await ok(dir, 'status');
  assert.equal(st.index.state, 'ready');
  assert.ok(st.index.watermark < st.version, 'backfill snapshot predates concurrent txs');

  for (const risk of ['R0', 'R1', 'R2']) {
    const viaIndex = await ok(dir, 'query', '--risk', risk);
    const viaScan = await ok(dir, 'query', '--risk', risk, '--scan');
    assert.equal(viaIndex.source, 'index');
    assert.equal(viaScan.source, 'scan');
    assert.deepEqual(viaIndex.accounts, viaScan.accounts, `risk ${risk}`);
  }

  // Spot-check balances reflect payments and reversals (snapshot scan at latest).
  const expected = {};
  for (let i = 0; i < 8; i++) expected[`A${i}`] = 1000 - (i % 2 === 0 ? 0 : 100);
  for (let i = 8; i < 12; i++) expected[`A${i}`] = 1000;
  for (let i = 0; i < 8; i++) expected[`N${i}`] = 500;
  const { scanAccounts } = await import('../src/engine.js');
  const { Store } = await import('../src/store.js');
  const view = scanAccounts(new Store(dir).load(), st.version);
  for (const [id, balance] of Object.entries(expected)) {
    assert.equal(view[id].balance, balance, `balance of ${id}`);
  }
});
