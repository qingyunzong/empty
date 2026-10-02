import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, main } from '../src/cli.js';

const DAY = '2026-10-03';

const SAMPLE = [
  { type: 'account', account: 'A', packages: ['P-STD'] },
  { type: 'trade', id: 't1', account: 'A', amount: 100_000 },
  { type: 'trade', id: 't2', account: 'A', amount: 150_000 },
  { type: 'cancel', id: 't2' },
  { type: 'eod' },
].map(JSON.stringify).join('\n');

test('CLI prints fee diffs, hit tiers and certificate', () => {
  const r = runCli({ input: SAMPLE, day: DAY });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  const diffs = lines.filter((l) => l.type === 'fee-diff');
  assert.equal(diffs.length, 3);
  assert.equal(diffs[2].delta, -25);
  assert.ok(diffs[2].reasons.some((x) => x.includes('minimum fee 100 applied')));
  const [eod] = lines.filter((l) => l.type === 'eod');
  assert.equal(eod.net, 100);
  assert.equal(eod.minFeeApplied, true);
  assert.deepEqual(eod.tiers, [{ tier: 'T1', amount: 100_000, rate: 0.0005, fee: 50 }]);
  assert.match(eod.certificate, /^[0-9a-f]{64}$/);
});

test('CLI exits 6 with stderr on invalid events', () => {
  const bad = runCli({ input: '{"type":"trade","id":"r1","account":"A","amount":-5}\n', day: DAY });
  assert.equal(bad.code, 6);
  assert.match(bad.stderr, /must reference original/);
  assert.equal(bad.stdout, '');

  const badJson = runCli({ input: '{oops\n', day: DAY });
  assert.equal(badJson.code, 6);
  assert.match(badJson.stderr, /invalid JSON/);

  const badVersion = runCli({ input: '{"type":"rules","version":"v9"}\n', day: DAY });
  assert.equal(badVersion.code, 6);
  assert.match(badVersion.stderr, /unknown rule version/);

  let err = '';
  const code = main(['--bogus'], { input: '', stderr: (s) => (err += s), stdout: () => {} });
  assert.equal(code, 6);
  assert.match(err, /unknown option/);
});

test('CLI journal run twice does not double bill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-cli-'));
  const journal = path.join(dir, 'invoices.jsonl');
  const first = runCli({ input: SAMPLE, day: DAY, journalPath: journal });
  assert.equal(first.code, 0, first.stderr);
  const billed1 = first.stdout.trim().split('\n').map(JSON.parse).filter((l) => l.type === 'eod');
  assert.equal(billed1.length, 1);
  assert.equal(billed1[0].billed, true);

  const second = runCli({ input: SAMPLE, day: DAY, journalPath: journal });
  assert.equal(second.code, 0, second.stderr);
  const billed2 = second.stdout.trim().split('\n').map(JSON.parse).filter((l) => l.type === 'eod');
  assert.equal(billed2[0].billed, false);
  assert.equal(billed2[0].certificate, billed1[0].certificate);

  const stored = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, `${DAY}:A`);
  assert.equal(stored[0].amount, 100);
});

test('CLI reads events from a file argument', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-cli-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, SAMPLE);
  let out = '';
  const code = main(['--day', DAY, file], { stdout: (s) => (out += s), stderr: () => {} });
  assert.equal(code, 0);
  assert.ok(out.includes('"type":"eod"'));
});
