import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

// Invokes the CLI in-process (sandbox forbids child processes) and captures
// the single JSON line it emits plus the exit code.
function cli(args) {
  const lines = [];
  const code = run(args, { stdout: (line) => lines.push(line) });
  return { code, json: JSON.parse(lines[lines.length - 1]) };
}

test('CLI end-to-end: causal rejections, conflict merge, resolution, cert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-cli-'));
  const db1 = join(dir, 'r1.json');
  const db2 = join(dir, 'r2.json');

  // Acceptance 1: cancel causally before match -> already-canceled, exit 1.
  let r = cli(['--db', db1, '--replica', 'A', 'create', 'o1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'NEW');
  r = cli(['--db', db1, 'cancel', 'o1']);
  assert.equal(r.json.state, 'CANCELED');
  r = cli(['--db', db1, 'match', 'o1']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'already-canceled' });

  // Acceptance 2: match causally before cancel -> already-matched, exit 1.
  r = cli(['--db', db2, '--replica', 'B', 'create', 'o1']);
  assert.equal(r.code, 0);
  r = cli(['--db', db2, 'match', 'o1']);
  assert.equal(r.json.state, 'MATCHED');
  r = cli(['--db', db2, 'cancel', 'o1']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'already-matched' });

  // Acceptance 3: concurrent cancel/match merge into CONFLICT, cert invalid.
  r = cli(['--db', db1, 'merge', db2]);
  assert.equal(r.code, 0);
  const order = r.json.orders.find((o) => o.orderId === 'o1');
  assert.equal(order.state, 'CONFLICT');
  assert.deepEqual(order.events.map((e) => e.type).sort(), ['cancel', 'match']);

  r = cli(['--db', db1, 'cert', 'o1']);
  assert.equal(r.json.valid, false);
  assert.equal(r.json.state, 'CONFLICT');

  // Legal resolution settles the order; cert becomes valid with basis.
  r = cli(['--db', db1, 'resolve', 'o1', '--to', 'CANCELED', '--reason', 'ops ticket 7']);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'CANCELED');

  r = cli(['--db', db1, 'cert', 'o1']);
  assert.equal(r.json.valid, true);
  assert.equal(r.json.resolution.to, 'CANCELED');
  assert.equal(r.json.resolution.reason, 'ops ticket 7');
  assert.ok(r.json.resolution.basis.cancelHash);
  assert.ok(r.json.resolution.basis.matchHash);

  r = cli(['--db', db1, 'state', 'o1']);
  assert.equal(r.json.state, 'CANCELED');
});

test('CLI error paths return {"error":code} with exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-cli-err-'));
  const db = join(dir, 'r.json');
  let r = cli(['--db', db, 'state', 'nope']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'not-found' });

  cli(['--db', db, 'create', 'o']);
  r = cli(['--db', db, 'create', 'o']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'already-exists' });

  r = cli(['--db', db, 'resolve', 'o', '--to', 'CANCELED']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'no-conflict' });

  r = cli(['--db', db, 'merge', join(dir, 'missing.json')]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'file-not-found' });
});
