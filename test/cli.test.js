import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

const NODES = [
  { id: 'R', parentId: null, amount: 5, reason: 'root node', state: 'active' },
  { id: 'A', parentId: 'R', amount: 10, reason: 'foo x bar refund', state: 'active' },
  { id: 'D', parentId: 'A', amount: 40, reason: 'foo bar again', state: 'active' },
];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txcli-'));
  const data = path.join(dir, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ nodes: NODES }));
  return { dir, data, stateDir: path.join(dir, 'state') };
}

// The sandboxed test environment drops pipes of doubly-nested node processes,
// so the CLI is run through `bash -c exec ...` with output redirected to files.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runCli(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txcli-io-'));
  const outFile = path.join(dir, 'stdout');
  const errFile = path.join(dir, 'stderr');
  const command = [process.execPath, CLI, ...args].map(shellQuote).join(' ');
  const res = spawnSync(
    'bash',
    ['-c', `exec ${command} >${shellQuote(outFile)} 2>${shellQuote(errFile)}`],
    { encoding: 'utf8' },
  );
  return {
    status: res.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

test('cli query prints sorted hits and exits 0', () => {
  const { data } = fixture();
  const res = runCli(['query', '--data', data, '--root', 'R', '--terms', 'foo bar', '--slop', '1']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.hits, [
    { id: 'A', positions: [[0, 2]] },
    { id: 'D', positions: [[0, 1]] },
  ]);
});

test('cli undo prints certificate, exits 0, then duplicate run exits 1', () => {
  const { data, stateDir } = fixture();
  const base = ['undo', '--data', data, '--root', 'R', '--terms', 'foo bar', '--slop', '1', '--budget', '100', '--state-dir', stateDir];
  const first = runCli(base);
  assert.equal(first.status, 0, first.stderr);
  const cert = JSON.parse(first.stdout);
  assert.equal(cert.batch, 1);
  assert.equal(cert.totalAmount, 50);
  assert.deepEqual(cert.nodes.map((n) => n.id), ['A', 'D']);

  const second = runCli(base);
  assert.equal(second.status, 1);
  assert.equal(second.stdout, '');
  assert.equal(JSON.parse(second.stderr).error.code, 'ALREADY_UNDONE');
});

test('cli undo with tiny budget exits 1 and writes nothing', () => {
  const { data, stateDir } = fixture();
  const res = runCli(['undo', '--data', data, '--root', 'R', '--terms', 'foo bar', '--slop', '1', '--budget', '1', '--state-dir', stateDir]);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'BUDGET_EXCEEDED');
  assert.equal(fs.existsSync(stateDir), false);
});

test('cli undo with unknown root exits 1 with ROOT_NOT_FOUND', () => {
  const { data, stateDir } = fixture();
  const res = runCli(['undo', '--data', data, '--root', 'NOPE', '--terms', 'foo bar', '--budget', '1', '--state-dir', stateDir]);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'ROOT_NOT_FOUND');
});

test('cli status reflects committed batches', () => {
  const { data, stateDir } = fixture();
  const setup = runCli(['undo', '--data', data, '--root', 'R', '--terms', 'foo bar', '--slop', '1', '--budget', '100', '--state-dir', stateDir]);
  assert.equal(setup.status, 0, setup.stderr);
  const res = runCli(['status', '--state-dir', stateDir]);
  assert.equal(res.status, 0);
  const status = JSON.parse(res.stdout);
  assert.equal(status.batch, 1);
  assert.deepEqual(status.undone, ['A', 'D']);
});
