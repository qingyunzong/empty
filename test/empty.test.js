'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { main } = require('../src/cli');

function runCli(input) {
  let stdout = '';
  let stderr = '';
  const status = main([], {
    readStdin: () => input,
    writeOut: (s) => (stdout += s),
    writeErr: (s) => (stderr += s),
  });
  return { status, stdout, stderr };
}

test('empty engine has no clusters and no suggestions', () => {
  const engine = new Engine();
  assert.deepEqual(engine.getAllClusters(), []);
  assert.deepEqual(engine.getDifferenceClusters(), []);
  assert.deepEqual(engine.getSuggestions(), []);
});

test('CLI on empty input emits only a certificate, exit 0', () => {
  const result = runCli('');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const cert = JSON.parse(lines[0]);
  assert.equal(cert.type, 'certificate');
  assert.equal(cert.clusterCount, 0);
  assert.equal(cert.eventCount, 0);
  assert.match(cert.sha256, /^[0-9a-f]{64}$/);
});

test('CLI on blank-lines-only input behaves like empty input', () => {
  const result = runCli('\n\n  \n');
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, 'certificate');
});
