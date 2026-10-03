import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sync, explainFee } from '../lib/engine.js';
import { run } from '../cli.js';
import { tmpdir, writeNdjson, appendNdjson } from './helpers.js';

// Acceptance 4: tied best-rate rules are all reported with stable ordering,
// and the final fee is explainable via the fixed priority rule.
test('tied best rules are all reported, stably ordered, and selection is explainable', () => {
  const dir = tmpdir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  const stateDir = path.join(dir, 'state');
  const base = 1_700_000_000_000;

  writeNdjson(rulesPath, [
    { op: 'add', ruleId: 'promo-b', validFrom: base, validTo: base + 10_000, rateBps: 80, priority: 1 },
    { op: 'add', ruleId: 'promo-a', validFrom: base, validTo: base + 10_000, rateBps: 80, priority: 2 },
    { op: 'add', ruleId: 'standard', validFrom: base, validTo: null, rateBps: 150, priority: 0 },
  ]);
  writeNdjson(txPath, [{ txId: 'tx-1', time: base + 5000, amount: 123_450 }]);
  sync({ rulesPath, txPath, stateDir });

  const first = run(['fee', '--state', stateDir, '--txId', 'tx-1']);
  assert.equal(first.code, 0, first.stderr);
  const second = run(['fee', '--state', stateDir, '--txId', 'tx-1']);
  assert.equal(first.stdout, second.stdout, 'output must be byte-stable across runs');

  const out = JSON.parse(first.stdout);
  // Both tied rules reported, ordered by the fixed tie-break (priority desc).
  assert.deepEqual(out.tied, [
    { ruleId: 'promo-a', priority: 2 },
    { ruleId: 'promo-b', priority: 1 },
  ]);
  assert.deepEqual(out.selected, { ruleId: 'promo-a', priority: 2 });
  assert.equal(out.bestRateBps, 80);
  assert.equal(out.candidates.length, 3); // the worse 'standard' rule is listed too
  assert.match(out.reason, /2 rules tie for best rate 80bps/);
  assert.match(out.reason, /priority desc, ruleId asc/);
  assert.equal(out.fee, Math.floor((123_450 * 80) / 10_000)); // 987

  // After the promo window closes, only 'standard' applies: fee changes, no tie.
  const later = explainFee({ stateDir, time: base + 20_000, amount: 123_450 });
  assert.equal(later.selected.ruleId, 'standard');
  assert.equal(later.fee, Math.floor((123_450 * 150) / 10_000));
});

test('rule overlap without declared priority exits with code 40', () => {
  const dir = tmpdir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  const stateDir = path.join(dir, 'state');
  const base = 1_700_000_000_000;

  writeNdjson(rulesPath, [
    { op: 'add', ruleId: 'x', validFrom: base, validTo: null, rateBps: 100 },
    { op: 'add', ruleId: 'y', validFrom: base, validTo: null, rateBps: 100 },
  ]);
  writeNdjson(txPath, [{ txId: 'tx-1', time: base + 1, amount: 1000 }]);

  const res = run(['sync', '--rules', rulesPath, '--tx', txPath, '--state', stateDir]);
  assert.equal(res.code, 40, res.stderr);
  assert.match(res.stderr, /"code":40/);
  assert.match(res.stderr, /without declared priority/);
});

test('time going backwards exits with code 41', () => {
  const dir = tmpdir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  const stateDir = path.join(dir, 'state');
  const base = 1_700_000_000_000;

  writeNdjson(rulesPath, [{ op: 'add', ruleId: 'std', validFrom: 0, validTo: null, rateBps: 100 }]);
  writeNdjson(txPath, [
    { txId: 'tx-1', time: base + 5000, amount: 1000 },
    { txId: 'tx-2', time: base + 1000, amount: 1000 }, // unmarked late arrival
  ]);
  const res = run(['sync', '--rules', rulesPath, '--tx', txPath, '--state', stateDir]);
  assert.equal(res.code, 41, res.stderr);
  assert.match(res.stderr, /"code":41/);
  assert.match(res.stderr, /goes backwards/);

  // Duplicate txId without backfill flag is also a stream violation.
  const stateDir2 = path.join(dir, 'state2');
  writeNdjson(txPath, [
    { txId: 'tx-1', time: base + 1000, amount: 1000 },
    { txId: 'tx-1', time: base + 2000, amount: 2000 },
  ]);
  const res2 = run(['sync', '--rules', rulesPath, '--tx', txPath, '--state', stateDir2]);
  assert.equal(res2.code, 41, res2.stderr);
  assert.match(res2.stderr, /duplicate txId/);

  // Rule event times going backwards across sync runs.
  const stateDir3 = path.join(dir, 'state3');
  writeNdjson(txPath, [{ txId: 'tx-9', time: base + 1000, amount: 1000 }]);
  writeNdjson(rulesPath, [{ op: 'add', ruleId: 'v2', validFrom: base + 5000, validTo: null, rateBps: 90 }]);
  sync({ rulesPath, txPath, stateDir: stateDir3 });
  appendNdjson(rulesPath, [{ op: 'add', ruleId: 'v1', validFrom: base, validTo: null, rateBps: 80 }]);
  const res3 = run(['sync', '--state', stateDir3]);
  assert.equal(res3.code, 41, res3.stderr);
});

test('revoke closes a rule going forward but preserves history', () => {
  const dir = tmpdir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  const stateDir = path.join(dir, 'state');
  const base = 1_700_000_000_000;

  writeNdjson(rulesPath, [
    { op: 'add', ruleId: 'old-plan', validFrom: base, validTo: null, rateBps: 60, priority: 1 },
    { op: 'add', ruleId: 'new-plan', validFrom: base, validTo: null, rateBps: 200, priority: 0 },
    { op: 'revoke', ruleId: 'old-plan', at: base + 10_000 },
  ]);
  writeNdjson(txPath, [
    { txId: 'before', time: base + 5000, amount: 10_000 },
    { txId: 'after', time: base + 15_000, amount: 10_000 },
  ]);
  sync({ rulesPath, txPath, stateDir });

  const before = explainFee({ stateDir, txId: 'before' });
  assert.equal(before.selected.ruleId, 'old-plan');
  assert.equal(before.fee, 60);

  const after = explainFee({ stateDir, txId: 'after' });
  assert.equal(after.selected.ruleId, 'new-plan');
  assert.equal(after.fee, 200);
});
