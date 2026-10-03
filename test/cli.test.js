import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runCli } from '../src/cli.js';

// Drives the CLI in-process: NDJSON in via a Readable, JSONL out via a
// Writable. Equivalent to piping stdin/stdout into `node src/cli.js`.
async function runSession(ndjson) {
  let stdout = '';
  const input = Readable.from([ndjson]);
  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += chunk.toString();
      callback();
    },
  });
  const code = await runCli(input, output);
  const lines = stdout.trim() === '' ? [] : stdout.trim().split('\n').map((line) => JSON.parse(line));
  return { code, lines };
}

test('CLI processes an NDJSON session end to end', async () => {
  const script = [
    JSON.stringify({ op: 'add-edge', from: 0, to: 1 }),
    JSON.stringify({ op: 'add-edge', from: 1, to: 0 }),
    JSON.stringify({ op: 'add-edge', from: 1, to: 2 }),
    JSON.stringify({ op: 'snapshot' }),
    JSON.stringify({ op: 'add-edge', from: 2, to: 1 }),
    JSON.stringify({ op: 'query' }),
    JSON.stringify({ op: 'rollback', snapshot: 1 }),
    JSON.stringify({ op: 'query' }),
    '',
  ].join('\n');
  const { code, lines } = await runSession(script);
  assert.equal(code, 0);
  assert.equal(lines.length, 8);
  assert.equal(lines[3].op, 'snapshot');
  assert.equal(lines[3].snapshotId, 1);
  assert.match(lines[3].hash, /^[0-9a-f]{64}$/);
  const merged = lines[5].result;
  assert.deepEqual(merged.sccs.map((s) => s.members), [[0, 1, 2]]);
  assert.deepEqual(merged.topologicalOrder, [0]);
  assert.equal(merged.certificates.length, 1);
  assert.equal(merged.certificates[0].representative, 0);
  const afterRollback = lines[7].result;
  assert.deepEqual(afterRollback.sccs.map((s) => s.members), [[0, 1], [2]]);
  assert.deepEqual(afterRollback.topologicalOrder, [0, 1]);
  assert.equal(lines[6].hash, lines[3].hash);
});

test('CLI reports errors per line and exits non-zero', async () => {
  const script = [
    JSON.stringify({ op: 'add-edge', from: 0, to: 1 }),
    JSON.stringify({ op: 'add-edge', from: 0, to: 1 }), // duplicate
    JSON.stringify({ op: 'add-edge', from: -5, to: 1 }), // negative id
    JSON.stringify({ op: 'rollback', snapshot: 7 }), // future snapshot
    JSON.stringify({ op: 'snapshot' }),
    JSON.stringify({ op: 'remove-edge', from: 0, to: 1 }),
    JSON.stringify({ op: 'rollback', snapshot: 1 }),
    JSON.stringify({ op: 'rollback', snapshot: 1 }), // still valid: no-op
    'not json at all',
    JSON.stringify({ op: 'fly-to-moon' }),
    '',
  ].join('\n');
  const { code, lines } = await runSession(script);
  assert.equal(code, 1);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[1].error.code, 'DUPLICATE_EDGE');
  assert.equal(lines[2].error.code, 'NEGATIVE_ID');
  assert.equal(lines[3].error.code, 'FUTURE_SNAPSHOT');
  assert.equal(lines[4].ok, true);
  assert.equal(lines[5].ok, true);
  assert.equal(lines[6].ok, true);
  assert.equal(lines[7].ok, true);
  assert.equal(lines[8].error.code, 'INVALID_JSON');
  assert.equal(lines[9].error.code, 'UNKNOWN_OP');
});

test('CLI reports unknown snapshot after invalidation', async () => {
  const script = [
    JSON.stringify({ op: 'add-edge', from: 0, to: 1 }),
    JSON.stringify({ op: 'snapshot' }), // id 1
    JSON.stringify({ op: 'add-edge', from: 1, to: 2 }),
    JSON.stringify({ op: 'snapshot' }), // id 2
    JSON.stringify({ op: 'rollback', snapshot: 1 }),
    JSON.stringify({ op: 'rollback', snapshot: 2 }), // invalidated -> unknown
    '',
  ].join('\n');
  const { code, lines } = await runSession(script);
  assert.equal(code, 1);
  assert.equal(lines[4].ok, true);
  assert.equal(lines[5].error.code, 'UNKNOWN_SNAPSHOT');
});
