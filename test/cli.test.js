import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/feecli.js', import.meta.url));

// Spawn the CLI with stdout/stderr redirected to files so the captured
// output is reliable regardless of pipe buffering.
function run(args, { input } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fee-cli-'));
  const outFile = join(dir, 'stdout.txt');
  const errFile = join(dir, 'stderr.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['pipe', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (status) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({
        status,
        stdout: readFileSync(outFile, 'utf8'),
        stderr: readFileSync(errFile, 'utf8'),
      });
    });
    child.stdin.end(input === undefined ? '' : input);
  });
}

function writeEvents(lines) {
  const file = join(mkdtempSync(join(tmpdir(), 'fee-events-')), 'events.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const BASE_EVENTS = [
  JSON.stringify({
    type: 'package',
    id: 'std',
    version: 1,
    tiers: [
      { upTo: 100000, rate: 0.001 },
      { upTo: null, rate: 0.0008 },
    ],
    minFee: 5,
  }),
  JSON.stringify({ type: 'trade', id: 't1', account: 'A', amount: 120000 }),
  JSON.stringify({ type: 'trade', id: 't2', account: 'B', amount: 30000 }),
  JSON.stringify({ type: 'amend', id: 't1', amount: 90000 }),
  JSON.stringify({ type: 'reversal', id: 'r1', ref: 't2', amount: -10000 }),
];

test('CLI prints per-account diffs, hit tiers and a certificate', async () => {
  const result = await run([writeEvents(BASE_EVENTS), '--explain']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const diffs = Object.fromEntries(lines.filter((l) => l.type === 'fee-diff').map((l) => [l.account, l]));
  // A: amended 120000 -> 90000, all in tier 0: 90000 * 0.001 = 90.00
  assert.equal(diffs.A.fee, '90.00');
  assert.equal(diffs.A.previousFee, '0.00');
  assert.equal(diffs.A.delta, '90.00');
  assert.equal(diffs.A.hitTier, 0);
  assert.equal(diffs.A.package, 'std');
  assert.deepEqual(diffs.A.tied, ['std']);
  assert.ok(diffs.A.changes.some((c) => c.includes('amend t1')));
  // B: 30000 - 10000 = 20000 -> 20.00
  assert.equal(diffs.B.fee, '20.00');
  assert.equal(diffs.B.delta, '20.00');
  const cert = lines.find((l) => l.type === 'certificate');
  assert.match(cert.digest, /^[0-9a-f]{64}$/);
  assert.equal(cert.events, 5);
  assert.equal(cert.trades, 3);
});

test('CLI reads JSONL from stdin when no file is given', async () => {
  const result = await run([], { input: `${BASE_EVENTS.join('\n')}\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('"type":"certificate"'));
});

test('CLI is deterministic: identical runs produce identical certificates', async () => {
  const file = writeEvents(BASE_EVENTS);
  const firstRun = await run([file]);
  const secondRun = await run([file]);
  const first = JSON.parse(firstRun.stdout.trim().split('\n').at(-1));
  const second = JSON.parse(secondRun.stdout.trim().split('\n').at(-1));
  assert.equal(first.digest, second.digest);
});

test('CLI exits 6 with stderr on a bare negative trade', async () => {
  const file = writeEvents([
    BASE_EVENTS[0],
    JSON.stringify({ type: 'trade', id: 'bad', account: 'A', amount: -10 }),
  ]);
  const result = await run([file]);
  assert.equal(result.status, 6);
  assert.match(result.stderr, /reversal/);
  assert.equal(result.stdout, '');
});

test('CLI exits 6 on invalid JSON, unknown events and dangling references', async () => {
  for (const lines of [
    ['{"type":"trade"'],
    [JSON.stringify({ type: 'teleport', id: 'x' })],
    [BASE_EVENTS[0], JSON.stringify({ type: 'amend', id: 'ghost', amount: 10 })],
    [BASE_EVENTS[0], JSON.stringify({ type: 'reversal', id: 'r1', ref: 'ghost', amount: -1 })],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await run([writeEvents(lines)]);
    assert.equal(result.status, 6, lines[0]);
    assert.match(result.stderr, /^error: /);
  }
});

test('CLI --state carries fees across runs so diffs are incremental', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fee-state-'));
  const first = await run([writeEvents(BASE_EVENTS), '--state', stateDir]);
  assert.equal(first.status, 0, first.stderr);
  const second = await run([
    writeEvents([JSON.stringify({ type: 'trade', id: 't3', account: 'A', amount: 30000 })]),
    '--state',
    stateDir,
  ]);
  assert.equal(second.status, 0, second.stderr);
  const diffs = Object.fromEntries(
    second.stdout.trim().split('\n').map((l) => JSON.parse(l))
      .filter((l) => l.type === 'fee-diff')
      .map((l) => [l.account, l]),
  );
  // A: 90000 -> 120000 crosses into tier 1: 100 + 20000*0.0008 = 116.00
  assert.equal(diffs.A.previousFee, '90.00');
  assert.equal(diffs.A.fee, '116.00');
  assert.equal(diffs.A.delta, '26.00');
  assert.equal(diffs.A.hitTier, 1);
});

test('CLI --persist writes committed invoice batches and recovers cleanly', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'fee-persist-'));
  const first = await run([writeEvents(BASE_EVENTS), '--persist', persistDir]);
  assert.equal(first.status, 0, first.stderr);
  const log = readFileSync(join(persistDir, 'invoices.log'), 'utf8');
  assert.ok(log.includes('"begin"'));
  assert.ok(log.includes('"commit"'));
  const invoices = log.split('\n')
    .filter((l) => l.includes('"invoice"'))
    .map((l) => JSON.parse(l).invoice);
  assert.deepEqual(invoices.map((i) => i.account).sort(), ['A', 'B']);
  // A re-run against the same journal must not duplicate invoice lines.
  const second = await run([writeEvents(BASE_EVENTS), '--persist', persistDir]);
  assert.equal(second.status, 0, second.stderr);
  const after = readFileSync(join(persistDir, 'invoices.log'), 'utf8');
  assert.equal(after.split('\n').filter((l) => l.includes('"invoice"')).length, 4);
});
