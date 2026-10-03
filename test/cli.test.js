import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli-main.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through runCli(); src/cli.js is a thin wrapper around it.

function run(args) {
  const { code, stdout, stderr } = runCli(args);
  assert.equal(code, 0, `expected exit 0, got ${code}: ${stderr}`);
  return JSON.parse(stdout);
}

function runErr(args) {
  const res = runCli(args);
  assert.notEqual(res.code, 0);
  return res;
}

const alice = [
  { clock: 1, agentId: 'alice', op: 'addEvidence', id: 'e1', weight: 2 },
  { clock: 2, agentId: 'alice', op: 'defineClaim', id: 'c1', type: 'quorum', threshold: 4 },
  { clock: 3, agentId: 'alice', op: 'addEdge', claim: 'c1', ref: 'e1' },
];
const bob = [
  { clock: 1, agentId: 'bob', op: 'addEvidence', id: 'e2', weight: 3 },
  { clock: 2, agentId: 'bob', op: 'addEdge', claim: 'c1', ref: 'e2' },
  { clock: 4, agentId: 'bob', op: 'retractEvidence', id: 'e1' },
];

function writeHistories() {
  const dir = mkdtempSync(join(tmpdir(), 'evhist-'));
  const fa = join(dir, 'alice.json');
  const fb = join(dir, 'bob.json');
  writeFileSync(fa, JSON.stringify({ branch: 'alice', ops: alice }));
  writeFileSync(fb, JSON.stringify(bob)); // plain array also accepted
  return { fa, fb };
}

test('state command prints JSON with hash, evidence, claims, statuses', () => {
  const { fa, fb } = writeHistories();
  const out = run(['state', fa, fb]);
  assert.match(out.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(out.evidence.length, 2);
  assert.equal(out.claims.length, 1);
  const c1 = out.statuses.find((s) => s.id === 'c1');
  assert.equal(c1.satisfied, false); // e1 retracted: only weight 3 < 4
  assert.equal(c1.error, null);
});

test('acceptance 2 via CLI: branch file order does not change the result', () => {
  const { fa, fb } = writeHistories();
  const ab = run(['state', fa, fb]);
  const ba = run(['state', fb, fa]);
  assert.equal(ab.stateHash, ba.stateHash);
  assert.deepEqual(ab.statuses, ba.statuses);
  assert.deepEqual(ab.evidence, ba.evidence);
});

test('order command prints the deterministic total order', () => {
  const { fa, fb } = writeHistories();
  const ordered = run(['order', fb, fa]);
  assert.deepEqual(
    ordered.map((o) => [o.clock, o.agentId]),
    [
      [1, 'alice'],
      [1, 'bob'],
      [2, 'alice'],
      [2, 'bob'],
      [3, 'alice'],
      [4, 'bob'],
    ]
  );
});

test('cert command prints a certificate with minimal support', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evhist-'));
  const f = join(dir, 'h.json');
  writeFileSync(
    f,
    JSON.stringify([
      { clock: 1, agentId: 'a', op: 'addEvidence', id: 'e1', weight: 2 },
      { clock: 2, agentId: 'a', op: 'addEvidence', id: 'e2', weight: 3 },
      { clock: 3, agentId: 'a', op: 'defineClaim', id: 'c', type: 'quorum', threshold: 3 },
      { clock: 4, agentId: 'a', op: 'addEdge', claim: 'c', ref: 'e1' },
      { clock: 5, agentId: 'a', op: 'addEdge', claim: 'c', ref: 'e2' },
    ])
  );
  const cert = run(['cert', 'c', f]);
  assert.equal(cert.satisfied, true);
  assert.deepEqual(cert.minimalSupport, ['e2']);
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
});

test('cert for an unsatisfied claim prints the reason chain', () => {
  const { fa, fb } = writeHistories();
  const cert = run(['cert', 'c1', fa, fb]);
  assert.equal(cert.satisfied, false);
  assert.equal(cert.reasons[0].code, 'E_QUORUM');
  assert.ok(cert.reasons[0].children.some((c) => c.node === 'e1' && c.code === 'E_INACTIVE'));
});

test('missing file exits non-zero with JSON error on stderr', () => {
  const err = runErr(['state', '/nonexistent/history.json']);
  const parsed = JSON.parse(err.stderr);
  assert.equal(parsed.error.code, 'E_INPUT');
});

test('no arguments exits non-zero with usage', () => {
  const err = runErr([]);
  assert.match(err.stderr, /usage/);
});
