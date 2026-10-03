'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main, EXIT_ERROR } = require('../src/cli');

// The CLI is exercised in-process through its io interface (the sandbox
// forbids spawning child node processes); bin/recon.js is a thin wrapper.
function runCli(input, args = []) {
  let stdout = '';
  let stderr = '';
  const status = main(args, {
    readStdin: () => input,
    writeOut: (s) => (stdout += s),
    writeErr: (s) => (stderr += s),
  });
  return { status, stdout, stderr };
}

const SCENARIO = [
  { type: 'internal', id: 'I1', amount: 60, ts: '2026-01-01T10:00:00Z' },
  { type: 'internal', id: 'I2', amount: 40, ts: '2026-01-01T11:00:00Z' },
  { type: 'external', id: 'E1', amount: 100, ts: '2026-01-01T12:00:00Z' },
  { type: 'internal', id: 'I9', amount: 7, ts: '2026-01-05T00:00:00Z' },
];

test('CLI emits difference clusters, suggestions and a certificate', () => {
  const input = SCENARIO.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const result = runCli(input);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const clusters = lines.filter((l) => l.type === 'cluster');
  const suggestions = lines.filter((l) => l.type === 'suggestion');
  const certs = lines.filter((l) => l.type === 'certificate');

  assert.equal(certs.length, 1);
  assert.equal(certs[0], lines[lines.length - 1], 'certificate is the last line');
  assert.equal(clusters.length, 2); // unresolved trio + unmatched I9
  assert.ok(clusters.some((c) => c.status === 'UNRESOLVED'));
  assert.ok(clusters.some((c) => c.status === 'OPEN'));
  assert.ok(suggestions.some((s) => s.action === 'MANUAL_REVIEW'));
  assert.ok(suggestions.some((s) => s.action === 'REQUEST_RECEIPT_REUPLOAD'));
  assert.match(certs[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(certs[0].differenceClusterCount, 2);
});

test('CLI is deterministic across runs', () => {
  const input = SCENARIO.map((e) => JSON.stringify(e)).join('\n');
  const a = runCli(input);
  const b = runCli(input);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
});

test('CLI exits 9 with stderr on invalid JSON', () => {
  const result = runCli(
    '{"type":"internal","id":"I1","amount":1,"ts":"2026-01-01T00:00:00Z"}\n{bad\n'
  );
  assert.equal(result.status, EXIT_ERROR);
  assert.match(result.stderr, /recon: line 2: invalid JSON/);
  assert.equal(result.stdout, '');
});

test('CLI exits 9 on unknown event type and on validation errors', () => {
  for (const input of [
    '{"type":"bogus","id":"X"}\n',
    '{"type":"internal","id":"I1","amount":-5,"ts":"2026-01-01T00:00:00Z"}\n',
    '{"type":"internal","id":"I1","amount":1,"ts":"not-a-date"}\n',
    '{"type":"revoke","id":"missing"}\n',
  ]) {
    const result = runCli(input);
    assert.equal(result.status, EXIT_ERROR, input);
    assert.match(result.stderr, /^recon: /);
  }
});

test('CLI exits 9 on unknown option and unknown rule version', () => {
  assert.equal(runCli('', ['--nope']).status, EXIT_ERROR);
  assert.equal(runCli('', ['--rules', 'v9']).status, EXIT_ERROR);
});

test('CLI reads events from a file argument', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cli-file-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, SCENARIO.map((e) => JSON.stringify(e)).join('\n'));
  const result = runCli(null, [file]);
  assert.equal(result.status, 0, result.stderr);
  const cert = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(cert.differenceClusterCount, 2);
});

test('CLI persists state and recovers it on the next run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cli-state-'));
  const first = SCENARIO.slice(0, 3).map((e) => JSON.stringify(e)).join('\n');
  const r1 = runCli(first, ['--state', dir]);
  assert.equal(r1.status, 0, r1.stderr);

  // second run: switch rules; engine recovers prior rows from the state dir
  const r2 = runCli('{"type":"rule","version":"v2"}\n', ['--state', dir]);
  assert.equal(r2.status, 0, r2.stderr);
  const lines = r2.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const cert = lines[lines.length - 1];
  assert.equal(cert.type, 'certificate');
  assert.equal(cert.rulesVersion, 'v2');
  // the one-to-many group settled after the switch: no difference clusters
  assert.equal(cert.differenceClusterCount, 0);
  assert.equal(cert.clusterCount, 1);
});
