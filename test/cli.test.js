import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../cli.js';

function run(args) {
  const { lines, error, exitCode } = runCli(args);
  if (exitCode !== 0) {
    const err = new Error(error ?? `exit code ${exitCode}`);
    err.status = exitCode;
    throw err;
  }
  return `${lines.join('\n')}\n`;
}

test('model command prints seed, pool, verdict, certificate and state hash', () => {
  const out = run(['model', '--seed', '7', '--accounts', '3', '--tasks', '8']);
  assert.match(out, /^seed: 7$/m);
  assert.match(out, /^accounts: 3$/m);
  assert.match(out, /^tasks: 8$/m);
  assert.match(out, /^prng: seed=7 draws=\d+$/m);
  assert.match(out, /^  T0 freeze /m);
  assert.match(out, /^safety: SAFE$/m);
  assert.match(out, /^violation: none$/m);
  assert.match(out, /^certificate: schedules=\d+ states=\d+ transitions=\d+ invariantChecks=\d+ invariant="used \+ frozen <= limit"$/m);
  assert.match(out, /^state-hash: [0-9a-f]{64}$/m);
});

test('replay rebuilds the identical pool and search result', () => {
  const modelOut = run(['model', '--seed', '7', '--accounts', '3', '--tasks', '8']);
  const replayOut = run(['replay', '--seed', '7', '--accounts', '3', '--tasks', '8']);
  const hashOf = (out) => out.match(/^state-hash: ([0-9a-f]{64})$/m)[1];
  assert.equal(hashOf(replayOut), hashOf(modelOut));
  assert.match(replayOut, /^replay: consistent$/m);
  const poolOf = (out) => out.match(/^pool:\n((?:  .+\n)+)/m)[1];
  assert.equal(poolOf(replayOut), poolOf(modelOut));
});

test('model output is stable across invocations', () => {
  const a = run(['model', '--seed', '13', '--accounts', '2', '--tasks', '5']);
  const b = run(['model', '--seed', '13', '--accounts', '2', '--tasks', '5']);
  assert.equal(a, b);
});

test('unknown command and bad arguments exit with code 2', () => {
  for (const args of [['bogus'], ['model', '--seed', 'x', '--accounts', '3', '--tasks', '8']]) {
    assert.throws(() => run(args), (err) => err.status === 2);
  }
});
