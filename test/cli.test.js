import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';

function run(input) {
  const { stdout, exitCode } = runCli(typeof input === 'string' ? input : JSON.stringify(input));
  return { exitCode, json: JSON.parse(stdout) };
}

test('CLI executes a command batch from stdin and writes JSON to stdout', () => {
  const { exitCode, json } = run({
    commands: [
      {
        cmd: 'transact',
        id: 't1',
        ops: [
          { op: 'upsert_file', id: 'raw', content: 'v1' },
          { op: 'add_artifact', id: 'clean', builder: 'concat', edges: [{ id: 'src', target: 'raw' }] },
          { op: 'add_release', id: 'rel', edges: [{ id: 'main', target: 'clean' }] },
        ],
      },
      { cmd: 'transact', id: 't2', ops: [{ op: 'upsert_file', id: 'raw', content: 'v2' }] },
      { cmd: 'rollback', txId: 't2' },
      { cmd: 'state' },
    ],
  });
  assert.equal(exitCode, 0);
  const [t1, t2, rb, state] = json.results;
  assert.equal(t1.ok, true);
  assert.deepEqual(t1.diff.added, ['clean', 'raw', 'rel']);
  assert.equal(t1.certificates[0].release, 'rel');
  assert.equal(t2.ok, true);
  assert.deepEqual(t2.diff.changed.map((c) => c.id), ['clean', 'raw', 'rel']);
  assert.equal(rb.ok, true);
  assert.equal(rb.rolledBack, 't2');
  assert.equal(state.ok, true);
  assert.deepEqual(state.hashes, t1.hashes);
});

test('CLI accepts a bare array of commands and a single command object', () => {
  const asArray = run([
    { cmd: 'transact', id: 't1', ops: [{ op: 'upsert_file', id: 'f', content: 'x' }] },
    { cmd: 'build' },
  ]);
  assert.equal(asArray.json.results.length, 2);
  assert.equal(asArray.json.results[1].ok, true);
  const single = run({ cmd: 'build' });
  assert.equal(single.json.results.length, 1);
  assert.equal(single.json.results[0].error.code, 'E_EMPTY');
});

test('CLI surfaces error codes for cycle, unknown builder, bad rollback, empty build', () => {
  const { json } = run({
    commands: [
      { cmd: 'build' },
      {
        cmd: 'transact',
        id: 'cyc',
        ops: [
          { op: 'add_artifact', id: 'x', builder: 'concat', edges: [{ id: 'in', target: 'y' }] },
          { op: 'add_artifact', id: 'y', builder: 'concat', edges: [{ id: 'in', target: 'x' }] },
        ],
      },
      {
        cmd: 'transact',
        id: 'bad-builder',
        ops: [
          { op: 'upsert_file', id: 'f', content: 'x' },
          { op: 'add_artifact', id: 'a', builder: 'nope', edges: [{ id: 'in', target: 'f' }] },
        ],
      },
      { cmd: 'rollback', txId: 'missing' },
      { cmd: 'frobnicate' },
    ],
  });
  const [empty, cycle, builder, rollback, unknown] = json.results;
  assert.equal(empty.error.code, 'E_EMPTY');
  assert.equal(cycle.error.code, 'E_CYCLE');
  assert.equal(builder.ok, true);
  assert.deepEqual(builder.errors, [{ node: 'a', code: 'E_BUILDER', message: 'unknown builder: nope' }]);
  assert.equal(rollback.error.code, 'E_TX_NOT_FOUND');
  assert.equal(unknown.error.code, 'E_CMD');
});

test('CLI rejects malformed JSON input with E_INPUT and non-zero exit', () => {
  const { exitCode, json } = run('{not json');
  assert.equal(exitCode, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'E_INPUT');
});
