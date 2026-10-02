import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { hashEvent } from '../src/ledger.js';

// Drives the CLI in-process: same code path as the `node cli.js ...` entry
// point, with the ledger file and stdout line capture injected.
function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'));
  const ledgerPath = join(dir, 'ledger.json');
  const run = (args) => {
    const lines = [];
    const code = runCli(args, { ledgerPath, stdout: (line) => lines.push(line) });
    assert.equal(lines.length, 1, `expected exactly one JSON line for: ${args.join(' ')}`);
    return { code, json: JSON.parse(lines[0]) };
  };
  return { dir, ledgerPath, run };
}

test('CLI acceptance 1: trade, cancel, restore -> get reports active', () => {
  const { run } = makeHarness();
  const trade = run(['trade', 'T1']);
  assert.equal(trade.code, 0);
  assert.equal(trade.json.type, 'trade');
  assert.equal(trade.json.tradeId, 'T1');
  assert.ok(typeof trade.json.hash === 'string');

  const cancel = run(['cancel', 'T1']);
  assert.equal(cancel.code, 0);
  assert.equal(cancel.json.type, 'cancel');
  assert.equal(cancel.json.observes, trade.json.hash);

  const mid = run(['get', 'T1']);
  assert.equal(mid.json.status, 'cancelled');

  const restore = run(['restore', 'T1']);
  assert.equal(restore.code, 0);
  assert.equal(restore.json.type, 'restore');
  assert.equal(restore.json.observes, cancel.json.hash);

  const final = run(['get', 'T1']);
  assert.equal(final.code, 0);
  assert.deepEqual(final.json, {
    tradeId: 'T1',
    status: 'active',
    tombstone: false,
    cancels: 1,
    restores: 1,
  });
});

test('CLI acceptance 2: delayed replay of an old cancel cannot undo a restored trade', () => {
  const { run, ledgerPath, dir } = makeHarness();
  run(['trade', 'T1']);
  run(['cancel', 'T1']);
  const staleCopy = join(dir, 'stale-replica.json');
  copyFileSync(ledgerPath, staleCopy); // old replica snapshot: trade + cancel

  run(['restore', 'T1']);
  assert.equal(run(['get', 'T1']).json.status, 'active');

  const merge = run(['merge', staleCopy]); // stale replica replays its old cancel
  assert.equal(merge.code, 0);
  assert.deepEqual(merge.json, { added: 0, duplicates: 2 });

  const final = run(['get', 'T1']);
  assert.equal(final.json.status, 'active');
  assert.equal(final.json.tombstone, false);
});

test('CLI acceptance 3a: restore without cancel -> {"error":"restore-without-cancel"}, exit 1', () => {
  const { run } = makeHarness();
  run(['trade', 'T1']);
  const res = run(['restore', 'T1']);
  assert.equal(res.code, 1);
  assert.deepEqual(res.json, { error: 'restore-without-cancel' });
  assert.equal(run(['get', 'T1']).json.status, 'active');
});

test('CLI acceptance 3b: concurrent cancel and restore -> conflict', () => {
  const { run, dir } = makeHarness();
  const trade = run(['trade', 'T1']).json;
  const cancel1 = run(['cancel', 'T1']).json;
  run(['restore', 'T1']); // observes cancel1, prev = [cancel1]

  // A concurrent cancel built on cancel1, not observing the restore.
  const concurrent = {
    id: 'concurrent-cancel',
    type: 'cancel',
    tradeId: 'T1',
    prev: [cancel1.hash],
    observes: trade.hash,
  };
  concurrent.hash = hashEvent(concurrent); // canonical hash from the library
  const mergeFile = join(dir, 'concurrent.json');
  writeFileSync(mergeFile, JSON.stringify([concurrent]));

  const merge = run(['merge', mergeFile]);
  assert.equal(merge.code, 0);
  assert.deepEqual(merge.json, { added: 1, duplicates: 0 });

  const state = run(['get', 'T1']);
  assert.equal(state.code, 0);
  assert.equal(state.json.status, 'conflict');
});

test('CLI errors are JSON with exit code 1', () => {
  const { run } = makeHarness();

  const unknownGet = run(['get', 'NOPE']);
  assert.equal(unknownGet.code, 1);
  assert.deepEqual(unknownGet.json, { error: 'unknown-trade' });

  const unknownCancel = run(['cancel', 'NOPE']);
  assert.equal(unknownCancel.code, 1);
  assert.deepEqual(unknownCancel.json, { error: 'unknown-trade' });

  const dup = run(['trade', 'T1']);
  assert.equal(dup.code, 0);
  const dupAgain = run(['trade', 'T1']);
  assert.equal(dupAgain.code, 1);
  assert.deepEqual(dupAgain.json, { error: 'duplicate-trade' });

  const badCommand = run(['frobnicate']);
  assert.equal(badCommand.code, 1);
  assert.deepEqual(badCommand.json, { error: 'unknown-command' });

  const missingArg = run(['get']);
  assert.equal(missingArg.code, 1);
  assert.deepEqual(missingArg.json, { error: 'missing-argument' });
});

test('CLI merge rejects a restore that observes no cancel', () => {
  const { run, dir } = makeHarness();
  const trade = run(['trade', 'T1']).json;
  const forged = {
    id: 'forged-restore',
    type: 'restore',
    tradeId: 'T1',
    prev: [trade.hash],
    observes: '0'.repeat(64),
  };
  // fix the hash so only the referential check can fail
  forged.hash = hashEvent(forged);
  const file = join(dir, 'forged.json');
  writeFileSync(file, JSON.stringify([forged]));
  const res = run(['merge', file]);
  assert.equal(res.code, 1);
  assert.deepEqual(res.json, { error: 'restore-without-cancel' });
  assert.equal(run(['get', 'T1']).json.status, 'active');
});
