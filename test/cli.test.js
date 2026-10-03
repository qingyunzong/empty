import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

// Child-process spawning is unavailable in some sandboxes, so the CLI is
// exercised in-process through its injectable io seam.
function run(args) {
  const io = { out: '', err: '', exitCode: 0 };
  io.stdout = (s) => (io.out += s);
  io.stderr = (s) => (io.err += s);
  main(args, io);
  return {
    code: io.exitCode,
    stdout: io.out ? JSON.parse(io.out) : null,
    stderr: io.err ? JSON.parse(io.err) : null,
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lg-cli-'));
}

test('CLI: merge conservation violation exits 2 with JSON stderr', () => {
  const s = path.join(tmpdir(), 's');
  run(['add', '--store', s, '--register', 'A:100']);
  run(['add', '--store', s, '--register', 'B:50']);
  const r = run(['add', '--store', s, '--op', 'merge', '--in', 'A:100', '--in', 'B:50', '--out', 'C:200']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr.code, 2);
  assert.match(r.stderr.error, /not conserved/);
});

test('CLI: cyclic relabel exits 2', () => {
  const s = path.join(tmpdir(), 's');
  run(['add', '--store', s, '--register', 'A:10']);
  run(['add', '--store', s, '--op', 'relabel', '--in', 'A:10', '--out', 'B:10']);
  const r = run(['add', '--store', s, '--op', 'relabel', '--in', 'B:10', '--out', 'A:10']);
  assert.equal(r.code, 2);
  assert.match(r.stderr.error, /cycle/);
});

test('CLI: unknown parent exits 3, backfill converges, prove+verify exit 0', () => {
  const s = path.join(tmpdir(), 's');
  const p = run(['add', '--store', s, '--op', 'merge', '--in', 'P:10', '--in', 'Q:10', '--out', 'R:20']);
  assert.equal(p.code, 3);
  assert.equal(p.stderr.code, 3);
  run(['add', '--store', s, '--register', 'P:10']);
  run(['add', '--store', s, '--register', 'Q:10']);
  const cert = path.join(tmpdir(), 'c.json');
  const prove = run(['prove', '--store', s, '--lot', 'R', '--out', cert]);
  assert.equal(prove.code, 0);
  const verify = run(['verify', '--store', s, '--cert', cert]);
  assert.equal(verify.code, 0);
  assert.equal(verify.stdout.head, prove.stdout.head);
});

test('CLI: tampered certificate exits 7', () => {
  const s = path.join(tmpdir(), 's');
  run(['add', '--store', s, '--register', 'A:10']);
  const cert = path.join(tmpdir(), 'c.json');
  run(['prove', '--store', s, '--lot', 'A', '--out', cert]);
  const c = JSON.parse(fs.readFileSync(cert, 'utf8'));
  c.entries[0].mass = 12345;
  fs.writeFileSync(cert, JSON.stringify(c));
  const r = run(['verify', '--store', s, '--cert', cert]);
  assert.equal(r.code, 7);
  assert.equal(r.stderr.code, 7);
});

test('CLI: prove of pending-blocked lot exits 3', () => {
  const s = path.join(tmpdir(), 's');
  run(['add', '--store', s, '--op', 'merge', '--in', 'U:5', '--in', 'V:5', '--out', 'W:10']);
  const r = run(['prove', '--store', s, '--lot', 'W']);
  assert.equal(r.code, 3);
});

test('CLI: sync, resume end-to-end', () => {
  const a = path.join(tmpdir(), 'a');
  const b = path.join(tmpdir(), 'b');
  run(['add', '--store', a, '--register', 'M:100', '--site', 'A']);
  run(['add', '--store', a, '--op', 'split', '--in', 'M:100', '--out', 'S1:60', '--out', 'S2:40', '--site', 'A']);
  const sync = run(['sync', '--store', a, '--peer', b]);
  assert.equal(sync.stdout.sentToPeer, 2);
  const again = run(['sync', '--store', a, '--peer', b]);
  assert.equal(again.stdout.sentToPeer, 0); // idempotent
  fs.appendFileSync(path.join(b, 'edges.log'), '{"torn":'); // crash mid-write
  const resume = run(['resume', '--store', b]);
  assert.ok(resume.stdout.truncatedBytes > 0);
  const prove = run(['prove', '--store', b, '--lot', 'S1']);
  assert.equal(prove.code, 0);
});
