import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../cli.js';

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-cli-'));
  return path.join(dir, 'ops.jsonl');
}

// Drives the CLI in-process (each call is a fresh invocation, exactly like
// a separate `node cli.js ...` process: a new Monitor is built per call).
function run(log, ...args) {
  const lines = [];
  const code = runCli([log, ...args], (line) => lines.push(line));
  return { code, out: lines.join('\n') };
}

test('CLI: build a chain, commit, query bridges and articulation points', () => {
  const log = tmpLog();
  assert.deepEqual(run(log, 'add_edge', '1', '2'), { code: 0, out: 'OK' });
  assert.equal(run(log, 'add_edge', '2', '3').out, 'OK');
  assert.equal(run(log, 'add_edge', '3', '4').out, 'OK');
  assert.equal(run(log, 'commit').out, 'OK');
  const bridges = run(log, 'query_bridges');
  assert.equal(bridges.code, 0);
  assert.deepEqual(JSON.parse(bridges.out), [[1, 2], [2, 3], [3, 4]]);
  const art = run(log, 'query_articulation');
  assert.deepEqual(JSON.parse(art.out), [2, 3]);
});

test('CLI: closing a cycle removes all bridges', () => {
  const log = tmpLog();
  run(log, 'add_edge', '1', '2');
  run(log, 'add_edge', '2', '3');
  run(log, 'add_edge', '3', '1');
  run(log, 'commit');
  assert.deepEqual(JSON.parse(run(log, 'query_bridges').out), []);
  assert.deepEqual(JSON.parse(run(log, 'query_articulation').out), []);
});

test('CLI: operations persist across separate invocations', () => {
  const log = tmpLog();
  run(log, 'add_edge', '1', '2');
  run(log, 'commit');
  run(log, 'add_edge', '2', '3'); // appended + fsynced: survives reopen
  assert.deepEqual(JSON.parse(run(log, 'query_bridges').out), [[1, 2], [2, 3]]);
  assert.deepEqual(JSON.parse(run(log, 'query_articulation').out), [2]);
});

test('CLI: invalid input, unknown edge, and error exit codes', () => {
  const log = tmpLog();
  let r = run(log, 'add_edge', '1', 'x');
  assert.equal(r.out, 'INVALID_INPUT');
  assert.equal(r.code, 1);
  r = run(log, 'add_edge', '5', '5'); // self-loop
  assert.equal(r.out, 'INVALID_INPUT');
  r = run(log, 'del_edge', '7', '8'); // unknown edge
  assert.equal(r.out, 'NO_SUCH_EDGE');
  assert.equal(r.code, 1);
  r = run(log, 'del_edge', '-1', '2');
  assert.equal(r.out, 'INVALID_INPUT');
});

test('CLI: crash_sim + recover prints applied, discarded, state_hash', () => {
  const log = tmpLog();
  run(log, 'add_edge', '1', '2');
  run(log, 'add_edge', '2', '3');
  run(log, 'commit');
  assert.equal(run(log, 'crash_sim', 'after_append').out, 'OK');
  const r = run(log, 'recover');
  assert.equal(r.code, 0);
  const stats = JSON.parse(r.out);
  assert.equal(stats.applied, 2);
  assert.equal(stats.discarded, 1); // the torn half record
  assert.match(stats.state_hash, /^[0-9a-f]{64}$/);
  // recover is idempotent
  const again = JSON.parse(run(log, 'recover').out);
  assert.deepEqual(again, { applied: 2, discarded: 0, state_hash: stats.state_hash });
});

test('CLI: recover on empty and missing log files', () => {
  const log = tmpLog();
  fs.writeFileSync(log, '');
  const stats = JSON.parse(run(log, 'recover').out);
  assert.equal(stats.applied, 0);
  assert.equal(stats.discarded, 0);
  const missing = path.join(path.dirname(log), 'missing.jsonl');
  const statsMissing = JSON.parse(run(missing, 'recover').out);
  assert.deepEqual(statsMissing, stats);
});

test('CLI: corrupt log reports PERSIST_CORRUPT', () => {
  const log = tmpLog();
  run(log, 'add_edge', '1', '2');
  run(log, 'commit');
  fs.appendFileSync(log, '{"seq":3,"op":"commit","crc":"0000000000000000"}\n');
  const r = run(log, 'query_bridges');
  assert.equal(r.out, 'PERSIST_CORRUPT');
  assert.equal(r.code, 1);
});

test('CLI: crash_sim accepts all three fault point names and numbers', () => {
  for (const point of ['after_append', 'before_fsync', 'after_index_commit', '1', '2', '3']) {
    const log = tmpLog();
    run(log, 'add_edge', '1', '2');
    run(log, 'commit');
    assert.equal(run(log, 'crash_sim', point).out, 'OK', `point=${point}`);
    assert.equal(run(log, 'recover').code, 0, `point=${point}`);
  }
  const log = tmpLog();
  run(log, 'add_edge', '1', '2');
  const bad = run(log, 'crash_sim', 'nonsense');
  assert.equal(bad.out, 'INVALID_INPUT');
});
