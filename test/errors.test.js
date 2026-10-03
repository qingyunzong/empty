import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from '../src/store.js';
import { tmpdir, mulberry32, randomSample } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Note: this sandbox cannot pipe-capture child stdio (EPERM), so the CLI's
// stdout/stderr are redirected to files and read back.
let outCounter = 0;
function runCli(args) {
  const dir = tmpdir('biospec-cli-io-');
  const outFile = path.join(dir, `out-${outCounter++}.txt`);
  const errFile = path.join(dir, 'err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, [cli, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: res.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

test('duplicate sample id returns DUP (API and CLI)', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const rec = randomSample(mulberry32(1), 'S1');
  store.add(rec);
  assert.throws(() => store.add(rec), (e) => e instanceof StoreError && e.code === 'DUP');
  const tx = store.begin();
  tx.add(randomSample(mulberry32(2), 'S2'));
  tx.add(rec); // DUP inside a multi-op transaction
  assert.throws(() => tx.commit(), (e) => e.code === 'DUP');
  store.close();

  const res = runCli(['--data', dir, 'add', '--id', 'S1', '--type', 'blood', '--date', '2024-01-01', '--location', 'F1-R1', '--status', 'stored']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /^DUP/);
});

test('update/remove of missing sample returns NOT_FOUND (API and CLI)', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  assert.throws(() => store.update('nope', { status: 'archived' }), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.remove('nope'), (e) => e.code === 'NOT_FOUND');
  store.close();

  let res = runCli(['--data', dir, 'update', '--id', 'nope', '--status', 'archived']);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr, /^NOT_FOUND/);
  res = runCli(['--data', dir, 'remove', '--id', 'nope']);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr, /^NOT_FOUND/);
  res = runCli(['--data', dir, 'find', '--id', 'nope']);
  assert.strictEqual(res.status, 3);
  assert.match(res.stderr, /^NOT_FOUND/);
});

test('torn WAL tail is truncated on recovery, committed data survives', () => {
  const dir = tmpdir();
  const rng = mulberry32(3);
  let store = Store.open(dir);
  for (let i = 1; i <= 50; i++) store.add(randomSample(rng, `S${i}`));
  const before = store.scan({});
  store.close();

  const genDir = fs.readdirSync(dir).find((n) => n.startsWith('gen-'));
  const walFile = path.join(dir, genDir, 'wal.log');
  // Append garbage: a half-written frame (simulates crash mid-write).
  fs.appendFileSync(walFile, Buffer.from([0x30, 0x00, 0x00, 0x00, 0x02, 0xff]));

  store = Store.open(dir);
  assert.deepStrictEqual(store.scan({}), before);
  store.add(randomSample(rng, 'S51')); // WAL still writable after truncation
  store.close();

  store = Store.open(dir);
  assert.strictEqual(store.scan({}).length, 51);
  store.close();
});

test('uncommitted transaction is never applied', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.add(randomSample(mulberry32(4), 'S1'));
  const tx = store.begin();
  tx.add(randomSample(mulberry32(5), 'S2'));
  // no commit
  assert.strictEqual(store.find('S2'), null);
  store.close();
  store = Store.open(dir);
  assert.strictEqual(store.find('S2'), null);
  assert.ok(store.find('S1'));
  store.close();
});

test('CLI end-to-end: add/find/scan/compact/rebuild-index', () => {
  const dir = tmpdir();
  let res = runCli(['--data', dir, 'add', '--id', 'A1', '--type', 'plasma', '--date', '2024-05-01', '--location', 'F2-R3', '--status', 'stored']);
  assert.strictEqual(res.status, 0, res.stderr);
  res = runCli(['--data', dir, 'add', '--id', 'A2', '--type', 'plasma', '--date', '2024-06-01', '--location', 'F2-R4', '--status', 'stored']);
  assert.strictEqual(res.status, 0, res.stderr);
  res = runCli(['--data', dir, 'scan', '--type', 'plasma']);
  assert.strictEqual(JSON.parse(res.stdout).length, 2);
  res = runCli(['--data', dir, 'scan', '--from', '2024-05-15', '--to', '2024-07-01']);
  assert.deepStrictEqual(JSON.parse(res.stdout).map((r) => r.id), ['A2']);
  res = runCli(['--data', dir, 'compact']);
  assert.strictEqual(res.status, 0, res.stderr);
  res = runCli(['--data', dir, 'rebuild-index']);
  assert.strictEqual(res.status, 0, res.stderr);
  res = runCli(['--data', dir, 'find', '--id', 'A1']);
  assert.strictEqual(JSON.parse(res.stdout).id, 'A1');
  res = runCli(['--data', dir, 'remove', '--id', 'A1']);
  assert.strictEqual(res.status, 0, res.stderr);
  res = runCli(['--data', dir, 'scan']);
  assert.strictEqual(JSON.parse(res.stdout).length, 1);
});
