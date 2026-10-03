'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../lib/cli');

const ROOT = path.join(__dirname, '..');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'txn-cancel-'));
}

function makeStreams() {
  const store = { out: '', err: '' };
  return {
    store,
    streams: {
      stdout: { write: (s) => (store.out += s) },
      stderr: { write: (s) => (store.err += s) },
    },
  };
}

const input = {
  transactions: [
    {
      id: 'tx1',
      stages: [
        { id: 'trade', type: 'trade', account: 'A', amount: 100 },
        { id: 'fee', type: 'fee', account: 'A', amount: 10, dependsOn: ['trade'] },
      ],
    },
  ],
  batches: [{ id: 'b1', domains: ['trade', 'fee'], quotas: { A: 500 } }],
  requests: [{ idempotencyKey: 'k1', transactionId: 'tx1' }],
};

test('cli main writes output file, prints status, returns 0', () => {
  const dir = tmpdir();
  const inPath = path.join(dir, 'input.json');
  const outPath = path.join(dir, 'output.json');
  fs.writeFileSync(inPath, JSON.stringify(input));

  const { store, streams } = makeStreams();
  const code = main(['cancel', inPath, outPath], streams);
  assert.equal(code, 0);
  assert.equal(store.out, 'COMPLETED\n');

  const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(
    output.state.sequence.map((r) => r.stageId),
    ['fee', 'trade']
  );
});

test('cli main returns 1 on malformed JSON, schema errors, missing files, bad usage', () => {
  const dir = tmpdir();
  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{not json');

  let run = makeStreams();
  assert.equal(main(['cancel', badJson, path.join(dir, 'o.json')], run.streams), 1);
  assert.match(run.store.err, /invalid JSON/);

  const badSchema = path.join(dir, 'schema.json');
  fs.writeFileSync(badSchema, JSON.stringify({ transactions: [], batches: [], requests: [{}] }));
  run = makeStreams();
  assert.equal(main(['cancel', badSchema, path.join(dir, 'o.json')], run.streams), 1);
  assert.match(run.store.err, /invalid input/);

  run = makeStreams();
  assert.equal(main(['cancel', path.join(dir, 'nope.json'), path.join(dir, 'o.json')], run.streams), 1);
  assert.match(run.store.err, /cannot read input/);

  run = makeStreams();
  assert.equal(main([], run.streams), 1);
  assert.match(run.store.err, /usage:/);
});

function spawnCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['.', ...args], { cwd: ROOT });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

test('node . cancel end-to-end exits 0 and writes output', async () => {
  const dir = tmpdir();
  const inPath = path.join(dir, 'input.json');
  const outPath = path.join(dir, 'output.json');
  fs.writeFileSync(inPath, JSON.stringify(input));

  const code = await spawnCli(['cancel', inPath, outPath]);
  assert.equal(code, 0);
  const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(output.status, 'COMPLETED');
});

test('node . cancel exits 1 on bad input', async () => {
  const dir = tmpdir();
  const inPath = path.join(dir, 'input.json');
  fs.writeFileSync(inPath, '{broken');
  assert.equal(await spawnCli(['cancel', inPath, path.join(dir, 'o.json')]), 1);
  assert.equal(await spawnCli(['cancel']), 1);
});
