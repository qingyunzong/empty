import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mvcc-cli-'));

function runCli(input, args = []) {
  // Feed the script via a temp file on stdin: spawnSync's `input` pipe is
  // unreliable in some sandboxed environments, a redirected file is not.
  const inputFile = path.join(tmpdir(), 'input.json');
  fs.writeFileSync(inputFile, input);
  const fd = fs.openSync(inputFile, 'r');
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      stdio: [fd, 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } finally {
    fs.closeSync(fd);
 }
}

test('CLI: happy path exits 0 and emits canonical JSON per command', () => {
  const script = JSON.stringify([
    { op: 'begin', tx: 't1' },
    { op: 'put', tx: 't1', key: 'wo-1', value: { timeSlot: '08:00', workcenter: 'cnc-1' } },
    { op: 'commit', tx: 't1' },
    { op: 'begin', tx: 't2' },
    { op: 'get', tx: 't2', key: 'wo-1' },
    { op: 'get', tx: 't2', key: 'missing' },
    { op: 'abort', tx: 't2' },
  ]);
  const res = runCli(script);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, '');
  const lines = res.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), { ok: true, snapshot: 0, tx: 't1' });
  assert.deepEqual(JSON.parse(lines[1]), { ok: true });
  assert.deepEqual(JSON.parse(lines[2]), { ok: true, version: 1 });
  assert.deepEqual(JSON.parse(lines[4]), {
    ok: true,
    found: true,
    value: { workcenter: 'cnc-1', timeSlot: '08:00' },
  });
  assert.deepEqual(JSON.parse(lines[5]), { ok: true, found: false, value: null });
  // Canonical form: keys sorted.
  assert.ok(lines[4].startsWith('{"found":true,"ok":true,"value":{'));
  assert.ok(lines[4].includes('"timeSlot":"08:00","workcenter":"cnc-1"'));
});

test('CLI: unique conflict exits 1 with E_UNIQUE on stderr, run continues', () => {
  const script = JSON.stringify([
    { op: 'begin', tx: 'a' },
    { op: 'begin', tx: 'b' },
    { op: 'put', tx: 'a', key: 'wo-1', value: { workcenter: 'w', timeSlot: 's' } },
    { op: 'put', tx: 'b', key: 'wo-2', value: { workcenter: 'w', timeSlot: 's' } },
    { op: 'commit', tx: 'a' },
    { op: 'commit', tx: 'b' },
    { op: 'abort', tx: 'b' },
  ]);
  const res = runCli(script);
  assert.equal(res.status, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.code, 'E_UNIQUE');
  assert.equal(typeof err.message, 'string');
  const lines = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[4], { ok: true, version: 1 });
  assert.equal(lines[5].ok, false);
  assert.equal(lines[5].code, 'E_UNIQUE');
  assert.deepEqual(lines[6], { ok: true }); // abort still processed
});

test('CLI: snapshot conflict exits 1 with E_SNAPSHOT on stderr', () => {
  const script = JSON.stringify([
    { op: 'begin', tx: 'a' },
    { op: 'begin', tx: 'b' },
    { op: 'put', tx: 'a', key: 'k', value: 'v1' },
    { op: 'commit', tx: 'a' },
    { op: 'put', tx: 'b', key: 'k', value: 'v2' },
    { op: 'commit', tx: 'b' },
  ]);
  const res = runCli(script);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).code, 'E_SNAPSHOT');
});

test('CLI: malformed JSON input exits 2 with E_USAGE', () => {
  const res = runCli('{not json');
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).code, 'E_USAGE');
});

test('CLI: unknown op exits 2', () => {
  const res = runCli(JSON.stringify([{ op: 'explode', tx: 'a' }]));
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).code, 'E_USAGE');
});

test('CLI: command on unknown transaction exits 2', () => {
  const res = runCli(JSON.stringify([{ op: 'get', tx: 'ghost', key: 'k' }]));
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).code, 'E_USAGE');
});

test('CLI: unknown argument exits 2', () => {
  const res = runCli('[]', ['--bogus']);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).code, 'E_USAGE');
});

test('CLI: accepts newline-delimited JSON as well as arrays', () => {
  const ndjson = [
    JSON.stringify({ op: 'begin', tx: 'a' }),
    JSON.stringify({ op: 'put', tx: 'a', key: '', value: '' }),
    JSON.stringify({ op: 'commit', tx: 'a' }),
  ].join('\n');
  const res = runCli(ndjson);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim().split('\n').length, 3);
});

test('CLI: --data persists across invocations', () => {
  const dir = tmpdir();
  const first = runCli(
    JSON.stringify([
      { op: 'begin', tx: 'a' },
      { op: 'put', tx: 'a', key: 'wo-1', value: { workcenter: 'w', timeSlot: 's' } },
      { op: 'commit', tx: 'a' },
    ]),
    ['--data', dir],
  );
  assert.equal(first.status, 0);

  const second = runCli(
    JSON.stringify([
      { op: 'begin', tx: 'b' },
      { op: 'get', tx: 'b', key: 'wo-1' },
    ]),
    ['--data', dir],
  );
  assert.equal(second.status, 0);
  const lines = second.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[1], { ok: true, found: true, value: { workcenter: 'w', timeSlot: 's' } });

  // And the unique index still bites in the new process.
  const third = runCli(
    JSON.stringify([
      { op: 'begin', tx: 'c' },
      { op: 'put', tx: 'c', key: 'wo-2', value: { workcenter: 'w', timeSlot: 's' } },
      { op: 'commit', tx: 'c' },
    ]),
    ['--data', dir],
  );
  assert.equal(third.status, 1);
  assert.equal(JSON.parse(third.stderr).code, 'E_UNIQUE');
});
