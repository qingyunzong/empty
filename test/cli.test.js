import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { replay } from '../src/log.js';

function freshLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcli-'));
  return path.join(dir, 'graph.log');
}

function run(logPath, ...args) {
  return runCli(args, { logPath, write: () => {} });
}

test('full workflow: add, query, delete changes bridge set, recover', () => {
  const log = freshLog();
  assert.equal(run(log, 'add_edge', '0', '1').output, 'OK');
  assert.equal(run(log, 'add_edge', '1', '2').output, 'OK');
  assert.equal(run(log, 'add_edge', '2', '0').output, 'OK');
  assert.equal(run(log, 'add_edge', '2', '3').output, 'OK');
  assert.equal(run(log, 'commit').output, 'OK');
  assert.equal(run(log, 'query_bridges').output, '[[2,3]]');
  assert.equal(run(log, 'query_articulation').output, '[2]');
  assert.equal(run(log, 'del_edge', '2', '3').output, 'OK');
  assert.equal(run(log, 'query_bridges').output, '[]');
  assert.equal(run(log, 'query_articulation').output, '[]');
  const rec = JSON.parse(run(log, 'recover').output);
  assert.equal(rec.applied, 5);
  assert.equal(rec.discarded, 0);
  assert.match(rec.state_hash, /^[0-9a-f]{64}$/);
});

test('sorted output ordering for bridges and articulation points', () => {
  const log = freshLog();
  run(log, 'add_edge', '10', '2');
  run(log, 'add_edge', '2', '7');
  run(log, 'add_edge', '7', '9');
  assert.equal(run(log, 'query_bridges').output, '[[2,7],[2,10],[7,9]]');
  assert.equal(run(log, 'query_articulation').output, '[2,7]');
});

test('error outputs: INVALID_INPUT and NO_SUCH_EDGE with exit code 1', () => {
  const log = freshLog();
  for (const args of [['add_edge', '0', '0'], ['add_edge', '0', '300'], ['add_edge', 'x', '1'],
    ['add_edge', '0'], ['nonsense'], ['crash_sim', 'nowhere'], []]) {
    const r = run(log, ...args);
    assert.equal(r.output, 'INVALID_INPUT', JSON.stringify(args));
    assert.equal(r.code, 1);
  }
  const r = run(log, 'del_edge', '4', '5');
  assert.equal(r.output, 'NO_SUCH_EDGE');
  assert.equal(r.code, 1);
  run(log, 'add_edge', '0', '1');
  assert.equal(run(log, 'add_edge', '1', '0').output, 'INVALID_INPUT');
  assert.equal(run(log, 'del_edge', '0', '1').code, 0);
});

test('three crash points: recover deterministic, half record discarded not deleted', () => {
  for (const point of ['after_append', 'before_fsync', 'after_index_commit']) {
    const log = freshLog();
    run(log, 'add_edge', '0', '1');
    run(log, 'add_edge', '1', '2');
    run(log, 'commit');
    const before = JSON.parse(run(log, 'recover').output);
    assert.equal(run(log, 'crash_sim', point).output, 'OK');
    const rec = JSON.parse(run(log, 'recover').output);
    assert.equal(rec.applied, 2, point);
    assert.equal(rec.discarded, 1, point);
    assert.equal(rec.state_hash, before.state_hash, point);
    // edge targeted by the torn del_edge still exists
    assert.equal(run(log, 'query_bridges').output, '[[0,1],[1,2]]', point);
    // second recover: stable, nothing left to discard
    const again = JSON.parse(run(log, 'recover').output);
    assert.deepEqual(again, { applied: 2, discarded: 0, state_hash: before.state_hash }, point);
  }
});

test('recover on empty log file and on missing log file', () => {
  const log = freshLog();
  fs.writeFileSync(log, '');
  const rec = JSON.parse(run(log, 'recover').output);
  assert.equal(rec.applied, 0);
  assert.equal(rec.discarded, 0);
  assert.match(rec.state_hash, /^[0-9a-f]{64}$/);
  assert.equal(run(log, 'query_bridges').output, '[]');
  assert.equal(run(log, 'query_articulation').output, '[]');
  const missing = path.join(path.dirname(log), 'nope.log');
  const rec2 = JSON.parse(runCli(['recover'], { logPath: missing, write: () => {} }).output);
  assert.equal(rec2.applied, 0);
  assert.equal(rec2.discarded, 0);
});

test('corrupt complete record -> PERSIST_CORRUPT on all commands', () => {
  const log = freshLog();
  run(log, 'add_edge', '0', '1');
  fs.appendFileSync(log, '{"seq":2,"op":"add_edge","u":1,"v":2,"sum":"0000000000000000"}\n');
  assert.equal(run(log, 'recover').output, 'PERSIST_CORRUPT');
  assert.equal(run(log, 'query_bridges').output, 'PERSIST_CORRUPT');
  assert.equal(run(log, 'add_edge', '3', '4').output, 'PERSIST_CORRUPT');
});

test('CLI state matches library replay from snapshot (consistency)', () => {
  const log = freshLog();
  const ops = [['add_edge', '0', '1'], ['add_edge', '1', '2'], ['add_edge', '2', '3'],
    ['add_edge', '3', '0'], ['add_edge', '0', '2'], ['del_edge', '1', '2'], ['commit']];
  for (const op of ops) assert.equal(run(log, ...op).output, 'OK');
  const st = replay(log);
  assert.equal(run(log, 'query_bridges').output, JSON.stringify(st.graph.bridges()));
  assert.equal(run(log, 'query_articulation').output, JSON.stringify(st.graph.articulationPoints()));
  const rec = JSON.parse(run(log, 'recover').output);
  assert.equal(rec.state_hash, st.stateHash);
});
