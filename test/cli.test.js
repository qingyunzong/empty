import assert from 'node:assert/strict';
import test from 'node:test';
import { formatResults, runCommands } from '../src/cli.js';

function run(input) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  const { results, exitCode } = runCommands(payload);
  return { results, exitCode };
}

test('CLI processes a JSON array of commands from stdin', () => {
  const { results, exitCode } = run([
    { cmd: 'transaction', id: 'tx-1', ops: [
      { op: 'putFile', id: 'f0', content: 'raw' },
      { op: 'addArtifact', id: 'a0', builder: 'normalize', inputs: ['f0'] },
      { op: 'addRelease', id: 'r0', inputs: ['a0'] },
    ] },
    { cmd: 'hash', id: 'a0' },
    { cmd: 'state' },
  ]);
  assert.equal(exitCode, 0);
  const [build, hash, state] = results;
  assert.equal(build.ok, true);
  assert.equal(build.tx, 'tx-1');
  assert.deepEqual(build.diff.recomputed, ['a0']);
  assert.equal(build.certificate.releases.r0.status, 'ok');
  assert.equal(hash.ok, true);
  assert.match(hash.hash, /^[0-9a-f]{64}$/);
  assert.equal(state.ok, true);
  assert.deepEqual(state.state.history, ['tx-1']);
});

test('CLI supports newline-delimited JSON commands', () => {
  const lines = [
    JSON.stringify({ cmd: 'transaction', ops: [{ op: 'putFile', id: 'f0', content: 'x' }] }),
    JSON.stringify({ cmd: 'certificate' }),
  ].join('\n');
  const { results } = run(lines);
  const [tx, cert] = results;
  assert.equal(tx.ok, true);
  assert.equal(cert.ok, true);
  assert.match(cert.certificate.graphHash, /^[0-9a-f]{64}$/);
});

test('CLI emits one JSON line per command', () => {
  const { results } = run([
    { cmd: 'transaction', ops: [{ op: 'putFile', id: 'f0', content: 'x' }] },
    { cmd: 'state' },
  ]);
  const text = formatResults(results);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});

test('CLI surfaces structured errors for cycle, builder, rollback and empty transaction', () => {
  const { results } = run([
    { cmd: 'transaction', id: 't1', ops: [
      { op: 'putFile', id: 'f0', content: 'x' },
      { op: 'addArtifact', id: 'a', builder: 'concat', inputs: ['f0'] },
      { op: 'addArtifact', id: 'b', builder: 'concat', inputs: ['a'] },
      { op: 'addArtifact', id: 'bad', builder: 'nope', inputs: ['f0'] },
    ] },
    { cmd: 'transaction', id: 't2', ops: [{ op: 'addEdge', from: 'a', to: 'b' }] },
    { cmd: 'transaction', id: 't3', ops: [] },
    { cmd: 'rollback', tx: 'missing' },
    { cmd: 'rollback', tx: 't2' },
    { cmd: 'hash', id: 'a' },
  ]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].diff.failed.bad, 'E_BUILDER');
  assert.equal(results[1].ok, true);
  assert.ok(results[1].errors.some((e) => e.code === 'E_CYCLE'));
  assert.equal(results[2].ok, false);
  assert.equal(results[2].error.code, 'E_EMPTY_TRANSACTION');
  assert.equal(results[3].ok, false);
  assert.equal(results[3].error.code, 'E_TX_NOT_FOUND');
  assert.equal(results[4].ok, true);
  assert.deepEqual(results[4].reverted, ['t2']);
  assert.equal(results[5].ok, true);
});

test('CLI rejects invalid JSON with E_PARSE', () => {
  const { results, exitCode } = run('{not json');
  assert.equal(exitCode, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.code, 'E_PARSE');
});
