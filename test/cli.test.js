import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';
import {
  scenario1Events, scenario1Gross, scenario1Net,
  scenario2Setup, scenario2Correct, scenario2BadCorrect,
  scenario3Setup, scenario3Update,
} from './fixtures.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-cli-'));
}

function cli(args) {
  const { code, output } = run(args);
  return { code, output, json: JSON.parse(output) };
}

function writeEvents(dir, name, events) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ events }, null, 2));
  return file;
}

test('CLI scenario 1: apply then query returns version, net and hash', () => {
  const dir = tmpdir();
  const ev = writeEvents(dir, 'ev1.json', scenario1Events);
  const applied = cli(['apply', ev, '--dir', dir]);
  assert.equal(applied.code, 0);
  assert.equal(applied.json.version, 1);

  const q = cli(['query', '--dir', dir]);
  assert.equal(q.code, 0);
  assert.equal(q.json.version, 1);
  assert.deepEqual(q.json.gross, scenario1Gross);
  assert.deepEqual(q.json.net, scenario1Net);
  assert.match(q.json.hash, /^sha256:[0-9a-f]{64}$/);
  // First version: deltas are relative to the empty state (from 0).
  const expectedPositive = Object.fromEntries(
    Object.entries(scenario1Net).filter(([, v]) => v !== null && v > 0),
  );
  assert.deepEqual(q.json.delta.positive, expectedPositive);
  assert.deepEqual(q.json.delta.negative, { B: -5 });
});

test('CLI scenario 2: null -> 0 correction and unknown-key error exit 1', () => {
  const dir = tmpdir();
  cli(['apply', writeEvents(dir, 'ev1.json', scenario2Setup), '--dir', dir]);
  let q = cli(['query', '--dir', dir]);
  assert.equal(q.json.net.C9, null);

  cli(['apply', writeEvents(dir, 'ev2.json', scenario2Correct), '--dir', dir]);
  q = cli(['query', '--dir', dir]);
  assert.equal(q.json.net.C9, 5);
  assert.deepEqual(q.json.delta.components.C9, { from: null, to: 5, delta: null });

  const bad = cli(['apply', writeEvents(dir, 'ev3.json', scenario2BadCorrect), '--dir', dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /unknown key/);
  assert.deepEqual(Object.keys(bad.json), ['error']);
});

test('CLI scenario 3: both crash points and replay recovery', () => {
  const dir = tmpdir();
  cli(['apply', writeEvents(dir, 'ev1.json', scenario3Setup), '--dir', dir]);

  // before_append: exit 1, no effect.
  const ev2 = writeEvents(dir, 'ev2.json', scenario3Update);
  const crashed = cli(['apply', ev2, '--dir', dir, '--fail', 'before_append']);
  assert.equal(crashed.code, 1);
  assert.match(crashed.json.error, /before_append/);
  let q = cli(['query', '--dir', dir]);
  assert.equal(q.json.version, 1);
  assert.equal(q.json.net.C1, 5);

  // after_append: exit 1, log persisted, snapshot stale; query recovers.
  const crashed2 = cli(['apply', ev2, '--dir', dir, '--fail', 'after_append']);
  assert.equal(crashed2.code, 1);
  assert.match(crashed2.json.error, /after_append/);
  q = cli(['query', '--dir', dir]);
  assert.equal(q.json.version, 2);
  assert.equal(q.json.recovered, true);
  assert.equal(q.json.net.C1, -4);
  assert.deepEqual(q.json.delta.negative, { C1: -9 });
});

test('CLI: malformed command exits 1 with error JSON', () => {
  const bad = cli(['frobnicate']);
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /unknown command/);
});
