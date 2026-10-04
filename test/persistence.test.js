'use strict';
// Acceptance: crash in the middle of writing the cluster index; after restart
// no cluster is duplicated and the recovered state verifies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCli, SimulatedCrash } = require('../src/cli');
const { tmpdir } = require('../helpers');

function makeIo(env = {}) {
  const io = {
    out: '',
    err: '',
    readStdin: () => '',
    writeOut(s) {
      io.out += s;
    },
    writeErr(s) {
      io.err += s;
    },
    env,
  };
  return io;
}

const EVENTS = [
  { type: 'internal', id: 'I1', amount: 100, date: '2026-01-10' },
  { type: 'internal', id: 'I2', amount: 200, date: '2026-01-10' },
  { type: 'external', id: 'E1', amount: 100, date: '2026-01-10' },
];

test('crash mid index-write: restart recovers without duplicate clusters', () => {
  const dir = tmpdir('recon-crash-');
  const state = path.join(dir, 'state');
  const input = path.join(dir, 'in.jsonl');
  fs.writeFileSync(input, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // First run crashes while writing the cluster index.
  const crashIo = makeIo({ RECON_FAULT: 'index-write' });
  assert.throws(() => runCli(['run', input, '--state', state], crashIo), SimulatedCrash);
  assert.equal(crashIo.out, '', 'crash happens before any cluster output');
  assert.ok(fs.existsSync(path.join(state, 'clusters.json.tmp')), 'partial tmp left behind');
  assert.ok(!fs.existsSync(path.join(state, 'clusters.json')), 'no renamed index after crash');
  assert.ok(fs.existsSync(path.join(state, 'events.jsonl')), 'event log survived');

  // Restart with an empty delta: engine rebuilds from the event log.
  const empty = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  const recovered = makeIo();
  assert.equal(runCli(['run', empty, '--state', state], recovered), 0, recovered.err);
  assert.ok(!fs.existsSync(path.join(state, 'clusters.json.tmp')), 'stale tmp discarded');

  const lines = recovered.out.trim().split('\n').map(JSON.parse);
  const clusters = lines.filter((l) => l.kind === 'cluster');
  const ids = clusters.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate cluster ids after restart');
  assert.equal(clusters.length, 1, 'only the unmatched I2 singleton is a diff cluster');
  assert.deepEqual(clusters[0].members, ['I2']);

  const index = JSON.parse(fs.readFileSync(path.join(state, 'clusters.json'), 'utf8'));
  assert.deepEqual(index.clusterIds, ids, 'persisted index matches emitted clusters');

  const vio = makeIo();
  assert.equal(runCli(['verify', '--state', state], vio), 0);
  assert.equal(JSON.parse(vio.out).ok, true);

  // A further restart reproduces identical cluster ids (content-derived).
  const again = makeIo();
  assert.equal(runCli(['run', empty, '--state', state], again), 0);
  const againIds = again.out.trim().split('\n').map(JSON.parse).filter((l) => l.kind === 'cluster').map((c) => c.id);
  assert.deepEqual(againIds, ids, 'stable cluster ids across restarts');
});
