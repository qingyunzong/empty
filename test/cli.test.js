'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');

// Note: pipes to spawned children are restricted in some sandboxes, so the
// child's stdin/stdout are redirected through temp files.
function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creditnet-'));
  const inFile = path.join(dir, 'in.ndjson');
  const outFile = path.join(dir, 'out.txt');
  fs.writeFileSync(inFile, input);
  const inFd = fs.openSync(inFile, 'r');
  const outFd = fs.openSync(outFile, 'w');
  const res = spawnSync(process.execPath, [CLI], { stdio: [inFd, outFd, 'pipe'] });
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  assert.ifError(res.error);
  const stdout = fs.readFileSync(outFile, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  const lines = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, lines };
}

test('CLI processes NDJSON commands and exits 0 on success', () => {
  const { status, lines } = runCli(
    [
      { cmd: 'add-edge', from: 'S', to: 'A', capacity: 5 },
      { cmd: 'add-edge', from: 'A', to: 'T', capacity: 5 },
      { cmd: 'add-edge', from: 'S', to: 'T', capacity: 2 },
      { cmd: 'freeze', source: 'S', target: 'T', amount: 6, id: 'f1' },
      { cmd: 'release', id: 'f1', amount: 3 },
      { cmd: 'freeze', source: 'S', target: 'T', amount: 3 },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n'
  );
  assert.equal(status, 0);
  assert.equal(lines.length, 6);
  assert.equal(lines[3].ok, true);
  assert.equal(lines[3].id, 'f1');
  assert.equal(lines[3].flows.reduce((s, f) => s + f.amount, 0) >= 6, true);
  assert.equal(lines[4].remaining, 3);
  assert.equal(lines[5].ok, true);
});

test('CLI reports insufficient capacity with min-cut certificate, exit 0', () => {
  const { status, lines } = runCli(
    [
      { cmd: 'add-edge', from: 'S', to: 'T', capacity: 4 },
      { cmd: 'freeze', source: 'S', target: 'T', amount: 5 },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n'
  );
  assert.equal(status, 0);
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].error.code, 'INSUFFICIENT_CAPACITY');
  assert.equal(lines[1].cut.capacity, 4);
  assert.deepEqual(lines[1].cut.customerSide, ['T']);
});

test('CLI emits JSON errors and exits 1 on hard errors', () => {
  const { status, lines } = runCli(
    [
      JSON.stringify({ cmd: 'add-edge', from: 'S', to: 'T', capacity: 4 }),
      'not json',
      JSON.stringify({ cmd: 'freeze', source: 'ghost', target: 'T', amount: 1 }),
      JSON.stringify({ cmd: 'release', id: 'missing' }),
      JSON.stringify({ cmd: 'bogus' }),
    ].join('\n') + '\n'
  );
  assert.equal(status, 1);
  assert.equal(lines.length, 5);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[1].error.code, 'INVALID_JSON');
  assert.equal(lines[2].error.code, 'UNKNOWN_SOURCE');
  assert.equal(lines[3].error.code, 'UNKNOWN_FREEZE');
  assert.equal(lines[4].error.code, 'UNKNOWN_COMMAND');
});

test('CLI duplicate and over release errors exit 1', () => {
  const { status, lines } = runCli(
    [
      { cmd: 'add-edge', from: 'S', to: 'T', capacity: 10 },
      { cmd: 'freeze', source: 'S', target: 'T', amount: 4, id: 'x' },
      { cmd: 'release', id: 'x' },
      { cmd: 'release', id: 'x' },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n'
  );
  assert.equal(status, 1);
  assert.equal(lines[2].ok, true);
  assert.equal(lines[3].error.code, 'ALREADY_RELEASED');
});
