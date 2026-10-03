import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'clearing-cli-'));
  const store = join(dir, 'store.jsonl');
  let counter = 0;
  const cli = (command, payload, extraArgs = []) => {
    counter += 1;
    const input = join(dir, `in${counter}.json`);
    writeFileSync(input, JSON.stringify(payload), 'utf8');
    const captured = { stdout: '', stderr: '' };
    const code = run([command, '--input', input, '--store', store, ...extraArgs], {
      stdout: (s) => (captured.stdout += s),
      stderr: (s) => (captured.stderr += s),
    });
    return { code, ...captured };
  };
  const readStore = () =>
    readFileSync(store, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { cli, readStore, store, dir };
}

test('CLI: full lifecycle over JSON files with JSONL persistence', () => {
  const { cli, readStore } = setup();

  let res = cli('create-batch', {
    requestId: 'r1',
    batchId: 'B1',
    entries: [
      { entryId: 'e1', account: 'alice', amount: 500 },
      { entryId: 'e2', account: 'bob', amount: -500 },
    ],
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    batchId: 'B1',
    version: 1,
    status: 'open',
    frozenTotal: 0,
  });

  res = cli('apply-correction', {
    requestId: 'r2',
    batchId: 'B1',
    version: 2,
    corrections: [{ type: 'adjust', entryId: 'e1', newAmount: 700 }],
  });
  assert.equal(res.code, 0, res.stderr);

  res = cli('confirm', { requestId: 'r3', batchId: 'B1' });
  assert.equal(res.code, 0, res.stderr);
  const confirmed = JSON.parse(res.stdout);
  assert.deepEqual(confirmed.certificate.accounts, { alice: 700, bob: -500 });

  res = cli('status', { batchId: 'B1' });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).status, 'confirmed');

  const events = readStore();
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ['batch_created', 'correction_applied', 'confirmed'],
  );
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3],
  );
});

test('CLI: stale version exits 1 with standard error JSON and leaves the store untouched', () => {
  const { cli, readStore } = setup();
  cli('create-batch', {
    requestId: 'r1',
    batchId: 'B1',
    entries: [{ entryId: 'e1', account: 'alice', amount: 100 }],
  });
  cli('apply-correction', {
    requestId: 'r2',
    batchId: 'B1',
    version: 2,
    corrections: [{ type: 'reverse', entryId: 'e1' }],
  });

  const res = cli('apply-correction', {
    requestId: 'r3',
    batchId: 'B1',
    version: 2,
    corrections: [{ type: 'add', entryId: 'e2', account: 'bob', amount: 5 }],
  });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'VERSION_CONFLICT');
  assert.equal(readStore().length, 2);
});

test('CLI: duplicate requestId returns the original result without appending events', () => {
  const { cli, readStore } = setup();
  cli('create-batch', {
    requestId: 'r1',
    batchId: 'B1',
    entries: [{ entryId: 'e1', account: 'alice', amount: 100 }],
  });
  const correction = {
    requestId: 'r2',
    batchId: 'B1',
    version: 2,
    corrections: [{ type: 'adjust', entryId: 'e1', newAmount: 130 }],
  };
  const first = cli('apply-correction', correction);
  const second = cli('apply-correction', correction);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
  assert.equal(readStore().length, 2);
});

test('CLI: cancel after confirm emits compensation and zeroes balances', () => {
  const { cli } = setup();
  cli('create-batch', {
    requestId: 'r1',
    batchId: 'B1',
    entries: [
      { entryId: 'e1', account: 'alice', amount: 250 },
      { entryId: 'e2', account: 'bob', amount: -100 },
    ],
  });
  cli('confirm', { requestId: 'r2', batchId: 'B1' });
  const cancelled = cli('cancel', { requestId: 'r3', batchId: 'B1' });
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.mode, 'compensate');
  assert.deepEqual(payload.compensation, [
    { account: 'alice', amount: -250 },
    { account: 'bob', amount: 100 },
  ]);
  const status = cli('status', { batchId: 'B1' });
  assert.deepEqual(JSON.parse(status.stdout).balances, {});
});

test('CLI: --output writes the result JSON to a file', () => {
  const { cli, dir } = setup();
  const out = join(dir, 'result.json');
  const res = cli(
    'create-batch',
    {
      requestId: 'r1',
      batchId: 'B1',
      entries: [{ entryId: 'e1', account: 'alice', amount: 42 }],
    },
    ['--output', out],
  );
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).frozenTotal, 42);
});

test('CLI: invalid input and unknown command fail with exit 1 and error JSON', () => {
  const { cli } = setup();
  let res = cli('create-batch', { requestId: 'r1', batchId: 'B1', entries: [] });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'INVALID_INPUT');

  res = cli('status', { batchId: 'NOPE' });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'BATCH_NOT_FOUND');

  res = cli('bogus-command', { requestId: 'r', batchId: 'B1' });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'UNKNOWN_COMMAND');
});
