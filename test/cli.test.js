import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';

function run(args, opts = {}) {
  return runCli(args, opts);
}

function runOk(args) {
  const res = run(args);
  assert.equal(res.code, 0, `expected success, got ${res.code}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

const GRAPH_CHANGE = JSON.stringify({
  addNodes: [
    { id: 's', op: 0, device: 'A', time: 5 },
    { id: 'm', op: 1, device: 'B', time: 3 },
    { id: 't', op: 2, device: 'A', time: 4 },
  ],
  addEdges: [
    ['s', 'm'],
    ['m', 't'],
    ['s', 't'],
  ],
});

test('CLI end-to-end: init, commit, route, conflict, show, log', () => {
  const store = mkdtempSync(join(tmpdir(), 'route-cli-'));

  const { version: g } = runOk(['init', '--store', store]);
  assert.ok(g);

  const { version: v1 } = runOk([
    'commit', '--store', store, '--base', g, '--change', GRAPH_CHANGE,
  ]);
  assert.notEqual(v1, g);

  // Optimal route: direct s->t costs 9, via m costs 12.
  const route = runOk(['route', '--store', store, '--from', 's', '--to', 't']);
  assert.deepEqual(route, { path: ['s', 't'], time: 9 });

  // Capacity too tight for every route -> E_CAPACITY, exit code 4.
  const cap = run(['route', '--store', store, '--from', 's', '--to', 't',
    '--capacity', '{"A":5,"B":1}']);
  assert.equal(cap.code, 4);
  assert.equal(JSON.parse(cap.stderr).error, 'E_CAPACITY');

  // Planner A commits from v1; planner B (stale base, same read set) conflicts.
  const { version: v2 } = runOk([
    'commit', '--store', store, '--base', v1, '--read', 's',
    '--change', '{"removeEdges":[["s","t"]],"occupy":{"A":10}}',
  ]);
  const conflict = run([
    'commit', '--store', store, '--base', v1, '--read', 's',
    '--change', '{"removeEdges":[["s","t"]]}',
  ]);
  assert.equal(conflict.code, 2);
  const cert = JSON.parse(conflict.stderr).certificate;
  assert.equal(cert.code, 'E_CONFLICT');
  assert.equal(cert.theirVersion, v2);
  assert.equal(cert.commonAncestor, v1);
  assert.deepEqual(cert.readSet, ['s']);

  // Unrelated read set commits fine on the stale base.
  const ok = runOk([
    'commit', '--store', store, '--base', v1, '--read', 'm',
    '--change', '{"occupy":{"B":2}}',
  ]);
  assert.ok(ok.version);

  const shown = runOk(['show', '--store', store]);
  assert.equal(shown.version, ok.version);
  assert.equal(shown.error, null);
  assert.equal(shown.deviceLoad.A, 10);
  assert.equal(shown.deviceLoad.B, 2);

  const { versions } = runOk(['log', '--store', store]);
  assert.equal(versions.length, 4);
  assert.equal(versions[0].version, ok.version);
});

test('CLI reports unknown commands and missing stores', () => {
  const bad = run(['frobnicate']);
  assert.equal(bad.code, 8);
  assert.equal(JSON.parse(bad.stderr).error, 'E_INVALID');

  const missing = run(['log', '--store', join(tmpdir(), 'no-such-store-xyz')]);
  assert.equal(missing.code, 7);
  assert.equal(JSON.parse(missing.stderr).error, 'E_NOT_FOUND');
});
