import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'px-cli-'));
}

function run(args) {
  // Sandboxed environments may not pipe grandchild stdout back through
  // spawnSync, so capture via a temp file instead.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'px-out-')) + '/out.json';
  const fd = fs.openSync(out, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', fd, 'inherit'] });
  fs.closeSync(fd);
  return { status: r.status, body: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('cli: init/put/transfer/state round trip with JSON output', () => {
  const dir = tmpdir();
  assert.equal(run(['init', '--dir', dir]).status, 0);
  assert.equal(run(['put', '--dir', dir, '--pallet', 'P1', '--lot', 'L1']).status, 0);
  assert.equal(run(['put', '--dir', dir, '--pallet', 'P1', '--lot', 'L2', '--quarantine']).status, 0);
  const t = run(['transfer', '--dir', dir, '--from', 'P1', '--to', 'P2', '--lot', 'L1', '--lot', 'L2', '--quarantine']);
  assert.equal(t.status, 0);
  assert.equal(t.body.ok, true);
  const s = run(['state', '--dir', dir]);
  assert.equal(s.status, 0);
  assert.deepStrictEqual(
    s.body.pallets.P2.map((b) => [b.lot, b.quarantine]),
    [['L1', true], ['L2', true]],
  );
});

test('cli: business error exits 1 (E_DUP)', () => {
  const dir = tmpdir();
  run(['init', '--dir', dir]);
  run(['put', '--dir', dir, '--pallet', 'P1', '--lot', 'L1']);
  run(['put', '--dir', dir, '--pallet', 'P2', '--lot', 'L1']);
  const r = run(['transfer', '--dir', dir, '--from', 'P1', '--to', 'P2', '--lot', 'L1']);
  assert.equal(r.status, 1);
  assert.equal(r.body.code, 'E_DUP');
});

test('cli: corrupted wal exits 2 (E_CORRUPT)', () => {
  const dir = tmpdir();
  run(['init', '--dir', dir]);
  run(['put', '--dir', dir, '--pallet', 'P1', '--lot', 'L1']);
  run(['put', '--dir', dir, '--pallet', 'P1', '--lot', 'L2']);
  const wal = path.join(dir, 'wal.log');
  const lines = fs.readFileSync(wal, 'utf8').split('\n');
  lines[1] = lines[1].replace('"L1"', '"L9"'); // payload changed, checksum stale
  fs.writeFileSync(wal, lines.join('\n'));
  const r = run(['state', '--dir', dir]);
  assert.equal(r.status, 2);
  assert.equal(r.body.code, 'E_CORRUPT');
});

test('cli: --crash-after records rolls back, --crash-after commit persists', () => {
  const dir = tmpdir();
  run(['init', '--dir', dir]);
  for (const lot of ['L1', 'L2', 'L3']) run(['put', '--dir', dir, '--pallet', 'P1', '--lot', lot]);

  let r = run(['transfer', '--dir', dir, '--from', 'P1', '--to', 'P2', '--lot', 'L1', '--lot', 'L2', '--lot', 'L3', '--quarantine', '--crash-after', 'records']);
  assert.equal(r.status, 3);
  assert.equal(r.body.code, 'E_CRASH');
  let s = run(['state', '--dir', dir]);
  assert.equal(s.status, 0);
  assert.equal(s.body.pallets.P1.length, 3);
  assert.equal(s.body.pallets.P2, undefined);

  r = run(['transfer', '--dir', dir, '--from', 'P1', '--to', 'P2', '--lot', 'L1', '--lot', 'L2', '--lot', 'L3', '--quarantine', '--crash-after', 'commit']);
  assert.equal(r.status, 3);
  s = run(['state', '--dir', dir]);
  assert.equal(s.body.pallets.P1, undefined);
  assert.deepStrictEqual(
    s.body.pallets.P2.map((b) => [b.lot, b.quarantine]),
    [['L1', true], ['L2', true], ['L3', true]],
  );
});
