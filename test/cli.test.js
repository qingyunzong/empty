import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

const entry = (id, over = {}) => ({
  id,
  account: 'acct-1',
  day: '2026-10-03',
  merchant: 'm-1',
  amount: 100,
  currency: 'USD',
  ...over,
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cli-'));
  return { dir, ledgerPath: path.join(dir, 'ledger.json'), snapshotPath: path.join(dir, 'snapshot.json') };
}

// In-process CLI invocation (the sandbox forbids child processes); bin/recon.js
// is a thin shim over this same run() function.
function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const status = run(argv, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { status, stdout, stderr };
}

test('reconcile prints repaired/pending/conflicts/auditRoot', () => {
  const { ledgerPath, snapshotPath } = fixture();
  fs.writeFileSync(ledgerPath, JSON.stringify([entry('a'), entry('b'), entry('c')]));
  fs.writeFileSync(snapshotPath, JSON.stringify([entry('a')]));
  const res = runCli(['reconcile', '--ledger', ledgerPath, '--snapshot', snapshotPath, '--slots', '1']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.repaired, ['repair:missing_in_snapshot:b']);
  assert.deepEqual(out.pending, ['repair:missing_in_snapshot:c']);
  assert.deepEqual(out.conflicts, []);
  assert.match(out.auditRoot, /^[0-9a-f]{64}$/);
});

test('sealed day produces a SEALED conflict via CLI', () => {
  const { ledgerPath, snapshotPath } = fixture();
  fs.writeFileSync(ledgerPath, JSON.stringify([entry('late-1', { late: true })]));
  fs.writeFileSync(snapshotPath, JSON.stringify([]));
  const res = runCli(['reconcile', '--ledger', ledgerPath, '--snapshot', snapshotPath, '--seal', 'acct-1@2026-10-03']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.conflicts[0].code, 'SEALED');
  assert.deepEqual(out.repaired, []);
});

test('undo via CLI restores snapshot bytes byte-for-byte', () => {
  const { dir, ledgerPath, snapshotPath } = fixture();
  fs.writeFileSync(ledgerPath, JSON.stringify([entry('a'), entry('b')]));
  fs.writeFileSync(snapshotPath, JSON.stringify([entry('a')]));
  const out1 = path.join(dir, 'after-repair.snap');
  const res1 = runCli(['reconcile', '--ledger', ledgerPath, '--snapshot', snapshotPath, '--out', out1]);
  assert.equal(res1.status, 0, res1.stderr);
  const repairedBytes = fs.readFileSync(out1);

  const out2 = path.join(dir, 'after-undo.snap');
  const res2 = runCli([
    'reconcile', '--ledger', ledgerPath, '--snapshot', snapshotPath,
    '--undo', 'repair:missing_in_snapshot:b', '--out', out2,
  ]);
  assert.equal(res2.status, 0, res2.stderr);
  assert.equal(JSON.parse(res2.stdout).undone, 'repair:missing_in_snapshot:b');
  const restoredBytes = fs.readFileSync(out2);
  assert.notDeepEqual(repairedBytes, restoredBytes);
  const expected = Buffer.from(
    '{"account":"acct-1","amount":100,"currency":"USD","day":"2026-10-03","id":"a","merchant":"m-1"}\n',
    'utf8',
  );
  assert.deepEqual(restoredBytes, expected);
});

test('journal recover via CLI is idempotent and discards orphan plans', () => {
  const { dir, ledgerPath, snapshotPath } = fixture();
  fs.writeFileSync(ledgerPath, JSON.stringify([entry('a')]));
  fs.writeFileSync(snapshotPath, JSON.stringify([]));
  const journalPath = path.join(dir, 'journal.log');
  const res1 = runCli(['reconcile', '--ledger', ledgerPath, '--snapshot', snapshotPath, '--journal', journalPath]);
  assert.equal(res1.status, 0, res1.stderr);
  fs.appendFileSync(
    journalPath,
    JSON.stringify({ type: 'plan', id: 'ghost', payload: { repair: { action: 'insert', entry: entry('z') }, domain: 'acct-1@2026-10-03', after: '' } }) + '\n',
  );
  const outPath = path.join(dir, 'recovered.snap');
  const res2 = runCli(['reconcile', '--ledger', ledgerPath, '--snapshot', snapshotPath, '--recover', journalPath, '--out', outPath]);
  assert.equal(res2.status, 0, res2.stderr);
  const recovered = fs.readFileSync(outPath, 'utf8');
  assert.ok(recovered.includes('"id":"a"'));
  assert.ok(!recovered.includes('"id":"z"'), 'orphan plan must be discarded');
});

test('diff command and usage errors', () => {
  const { ledgerPath, snapshotPath } = fixture();
  fs.writeFileSync(ledgerPath, JSON.stringify([entry('a')]));
  fs.writeFileSync(snapshotPath, JSON.stringify([]));
  const res = runCli(['diff', '--ledger', ledgerPath, '--snapshot', snapshotPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).diffs[0].kind, 'missing_in_snapshot');

  assert.equal(runCli(['reconcile', '--ledger', ledgerPath]).status, 2);
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['bogus']).status, 2);

  const missing = runCli(['reconcile', '--ledger', '/nonexistent.json', '--snapshot', snapshotPath]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /BAD_DIFF/);
});
