import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, runCli, stdoutLines } from './helpers.js';

function expectError(result, code) {
  assert.notEqual(result.status, 0, `expected non-zero exit, got 0 (stdout: ${result.stdout})`);
  const lines = result.stderr.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'stderr must be exactly one line');
  const err = JSON.parse(lines[0]);
  assert.equal(typeof err.msg, 'string');
  assert.equal(err.code, code);
}

test('cli happy path: init/put/correct/delete/status emit JSON lines', () => {
  const dir = tmpdir();
  let r = runCli(['--store', dir, 'init', '--node', 'A', '--nodes', 'A,B', '--retention', '0']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, node: 'A', nodes: ['A', 'B'], retention: 0 });

  r = runCli(['--store', dir, 'put'], { input: '{"key":"obs-1","value":{"temp":21.5}}\n' });
  assert.equal(r.status, 0, r.stderr);
  const putOut = stdoutLines(r)[0];
  assert.equal(putOut.ok, true);
  assert.equal(putOut.op, 'put');
  assert.deepEqual(putOut.clock, { A: 1 });
  assert.equal(putOut.lamport, 1);

  r = runCli(['--store', dir, 'correct'], { input: '{"key":"obs-1","value":{"temp":22}}\n' });
  assert.equal(r.status, 0, r.stderr);

  r = runCli(['--store', dir, 'status']);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.records, 1);
  assert.equal(summary.tombstones, 0);

  r = runCli(['--store', dir, 'status', '--key', 'obs-1']);
  const detail = JSON.parse(r.stdout);
  assert.equal(detail.history.length, 2, 'correction history is kept');
  assert.deepEqual(detail.history.map((v) => v.value.temp), [21.5, 22]);

  r = runCli(['--store', dir, 'delete'], { input: '{"key":"obs-1"}\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stdoutLines(r)[0].deleted, true);

  r = runCli(['--store', dir, 'status']);
  assert.equal(JSON.parse(r.stdout).tombstones, 1);
});

test('cli errors: single-line JSON on stderr, non-zero exit', () => {
  const dir = tmpdir();
  runCli(['--store', dir, 'init', '--node', 'A']);
  runCli(['--store', dir, 'put'], { input: '{"key":"k","value":1}\n' });

  expectError(runCli(['--store', dir, 'correct'], { input: '{"key":"nope","value":1}\n' }), 'NOT_FOUND');
  expectError(runCli(['--store', dir, 'put'], { input: '{"key":"k","value":2}\n' }), 'EXISTS');
  expectError(runCli(['--store', dir, 'put'], { input: 'not json\n' }), 'BAD_INPUT');
  expectError(runCli(['--store', dir, 'put'], { input: '{"value":1}\n' }), 'BAD_INPUT');
  expectError(runCli(['--store', tmpdir(), 'status']), 'NO_STORE');
  expectError(runCli(['--store', dir, 'init', '--node', 'A']), 'STORE_EXISTS');
  expectError(runCli(['--store', dir, 'bogus']), 'USAGE');
  expectError(runCli(['--store', dir, 'delete'], { input: '{"key":"nope"}\n' }), 'NOT_FOUND');

  runCli(['--store', dir, 'delete'], { input: '{"key":"k"}\n' });
  expectError(runCli(['--store', dir, 'delete'], { input: '{"key":"k"}\n' }), 'ALREADY_DELETED');
  expectError(runCli(['--store', dir, 'correct'], { input: '{"key":"k","value":9}\n' }), 'DELETED');
});

test('cli end-to-end: concurrent corrections across replicas merge deterministically', () => {
  const dA = tmpdir();
  const dB = tmpdir();
  runCli(['--store', dA, 'init', '--node', 'A', '--nodes', 'A,B']);
  runCli(['--store', dB, 'init', '--node', 'B', '--nodes', 'A,B']);

  runCli(['--store', dA, 'put'], { input: '{"key":"obs-1","value":"v0"}\n' });
  const dumpA0 = runCli(['--store', dA, 'status', '--dump']).stdout;
  runCli(['--store', dB, 'merge'], { input: dumpA0 });

  runCli(['--store', dA, 'correct'], { input: '{"key":"obs-1","value":"va"}\n' });
  runCli(['--store', dB, 'correct'], { input: '{"key":"obs-1","value":"vb"}\n' });

  // Cross-merge both ways.
  const dumpA = runCli(['--store', dA, 'status', '--dump']).stdout;
  const dumpB = runCli(['--store', dB, 'status', '--dump']).stdout;
  const mergeA = runCli(['--store', dA, 'merge'], { input: dumpB });
  const mergeB = runCli(['--store', dB, 'merge'], { input: dumpA });
  assert.equal(mergeA.status, 0, mergeA.stderr);
  assert.equal(mergeB.status, 0, mergeB.stderr);
  assert.equal(stdoutLines(mergeA)[0].concurrent, true, 'merge reports concurrent histories');

  // Both replicas agree on the deterministic winner (lamport tie, origin 'B' > 'A').
  const detailA = JSON.parse(runCli(['--store', dA, 'status', '--key', 'obs-1']).stdout);
  const detailB = JSON.parse(runCli(['--store', dB, 'status', '--key', 'obs-1']).stdout);
  assert.equal(detailA.value, 'vb');
  assert.equal(detailB.value, 'vb');
  assert.equal(detailA.history.length, 3, 'put + two concurrent corrections are all retained');
  assert.ok(detailA.concurrentPairs.length > 0, 'concurrent version pairs are reported');
});
