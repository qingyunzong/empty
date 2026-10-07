'use strict';
// Acceptance 4: the recall certificate replays and verifies via the CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../testlib/cli-runner');

const EVENTS = [
  { type: 'intake', batch: 'RM-1' },
  { type: 'intake', batch: 'RM-2' },
  { type: 'inspect', id: 'IN-1', batch: 'RM-1', test: 'micro', status: 'pass' },
  { type: 'mix', output: 'B-1', inputs: ['RM-1', 'RM-2'] },
  { type: 'split', input: 'B-1', outputs: ['P-1', 'P-2'] },
];

function setup(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'food-trace-'));
  const input = path.join(dir, 'events.jsonl');
  fs.writeFileSync(input, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { dir, input, state: path.join(dir, 'state.json'), cert: path.join(dir, 'cert.json') };
}

test('build -> correct -> recall -> verify round trip', () => {
  const { input, state, cert } = setup(EVENTS);

  const built = runCli(['build', '--input', input, '--state', state]);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(JSON.parse(built.stdout).contaminated.length, 0);

  const corrected = runCli(['correct', '--state', state, '--inspection', 'IN-1', '--status', 'fail', '--reason', 'retest']);
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.deepEqual(JSON.parse(corrected.stdout).added, ['B-1', 'P-1', 'P-2', 'RM-1']);

  const recalled = runCli(['recall', '--state', state, '--out', cert]);
  assert.equal(recalled.status, 0, recalled.stderr);
  const certificate = JSON.parse(fs.readFileSync(cert, 'utf8'));
  assert.equal(certificate.rules_version, '1.0.0');
  assert.match(certificate.input_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(certificate.sources, ['RM-1']);
  assert.deepEqual(certificate.affected_products, ['P-1', 'P-2']);

  // Replay verification against the state (includes the correction).
  const verified = runCli(['verify', '--state', state, '--cert', cert]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /OK/);

  // Replay against the raw input (no correction) must NOT match.
  const replayedInput = runCli(['verify', '--input', input, '--cert', cert]);
  assert.equal(replayedInput.status, 2);
  assert.match(replayedInput.stderr, /MISMATCH/);

  // A tampered certificate is rejected.
  fs.writeFileSync(cert, JSON.stringify({ ...certificate, affected_products: ['P-1'] }));
  const bad = runCli(['verify', '--state', state, '--cert', cert]);
  assert.equal(bad.status, 2);
});

test('multiple earliest sources are ordered lexicographically', () => {
  const { input, state } = setup([
    { type: 'intake', batch: 'RM-b' },
    { type: 'intake', batch: 'RM-a' },
    { type: 'inspect', id: 'IN-1', batch: 'RM-b', test: 't', status: 'fail' },
    { type: 'inspect', id: 'IN-2', batch: 'RM-a', test: 't', status: 'fail' },
    { type: 'mix', output: 'B-1', inputs: ['RM-a', 'RM-b'] },
  ]);
  assert.equal(runCli(['build', '--input', input, '--state', state]).status, 0);
  const recalled = runCli(['recall', '--state', state]);
  assert.deepEqual(JSON.parse(recalled.stdout).sources, ['RM-a', 'RM-b']);
});
