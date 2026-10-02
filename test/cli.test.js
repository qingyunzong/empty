'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runCli } = require('../src/cliApp');

const alice = [
  { clock: 1, agentId: 'alice', op: 'addEvidence', id: 'e1', weight: 2 },
  { clock: 3, agentId: 'alice', op: 'addClaim', id: 'c1', type: 'quorum', threshold: 3 },
  { clock: 4, agentId: 'alice', op: 'addEdge', claim: 'c1', ref: 'e1' },
  { clock: 6, agentId: 'alice', op: 'setWeight', id: 'e1', weight: 4 },
];
const bob = [
  { clock: 2, agentId: 'bob', op: 'addEvidence', id: 'e2', weight: 1 },
  { clock: 5, agentId: 'bob', op: 'addEdge', claim: 'c1', ref: 'e2' },
  { clock: 7, agentId: 'bob', op: 'retract', id: 'e2' },
];

// Drive the CLI entry point in-process and capture its JSON output.
function runCliJson(argv, stdinText = '') {
  let out = '';
  let err = '';
  const code = runCli(argv, {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    readStdin: () => stdinText,
  });
  return { code, json: out ? JSON.parse(out) : null, err };
}

test('cli replay emits JSON state; branch order in file is irrelevant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const f1 = join(dir, 'h1.json');
  const f2 = join(dir, 'h2.json');
  writeFileSync(f1, JSON.stringify({ branches: { alice, bob } }));
  writeFileSync(f2, JSON.stringify({ branches: { bob, alice } }));

  const r1 = runCliJson(['replay', f1]);
  const r2 = runCliJson(['replay', f2]);
  assert.equal(r1.code, 0);
  assert.equal(r1.json.stateHash, r2.json.stateHash);
  assert.match(r1.json.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(r1.json.evidence.e1.weight, 4); // alice@6 wins over alice@1
  assert.equal(r1.json.evidence.e2.active, false);
  assert.equal(r1.json.claims.c1.state, 'satisfied'); // 4 >= 3
});

test('cli cert emits certificate JSON with support and hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const f = join(dir, 'h.json');
  writeFileSync(f, JSON.stringify({ branches: { alice, bob } }));
  const cert = runCliJson(['cert', 'c1', f]);
  assert.equal(cert.code, 0);
  assert.equal(cert.json.claim, 'c1');
  assert.equal(cert.json.state, 'satisfied');
  assert.deepEqual(cert.json.support, ['e1']);
  assert.match(cert.json.stateHash, /^[0-9a-f]{64}$/);

  const replayOut = runCliJson(['replay', f]);
  assert.equal(cert.json.stateHash, replayOut.json.stateHash);
});

test('cli reads history from stdin via "-"', () => {
  const r = runCliJson(['replay', '-'], JSON.stringify(alice));
  assert.equal(r.code, 0);
  assert.equal(r.json.claims.c1.state, 'satisfied');
});

test('cli with no valid command prints usage and exits non-zero', () => {
  const r = runCliJson([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage:/);
});
