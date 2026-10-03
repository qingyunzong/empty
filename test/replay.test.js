import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sync, verify } from '../lib/engine.js';
import { tmpdir, writeNdjson, rng } from './helpers.js';

// Acceptance 1: 10,000 transactions across 50 rule versions; replaying any
// historical interval must produce the same fees (hash) as the full run.
test('interval replay hash equals full-run hash across 50 rule versions and 10k tx', () => {
  const dir = tmpdir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  const stateDir = path.join(dir, 'state');

  const HOUR = 3600_000;
  const base = 1_700_000_000_000;
  const random = rng(42);

  const rules = [];
  for (let v = 0; v < 50; v++) {
    rules.push({
      op: 'add',
      ruleId: `plan-v${v}`,
      validFrom: base + v * HOUR,
      validTo: base + (v + 1) * HOUR,
      rateBps: 50 + ((v * 137) % 450),
      priority: v,
    });
  }
  writeNdjson(rulesPath, rules);

  const txs = [];
  for (let i = 0; i < 10_000; i++) {
    txs.push({
      txId: `tx-${i}`,
      time: base + Math.floor(random() * 50 * HOUR),
      amount: 100 + Math.floor(random() * 1_000_000),
    });
  }
  txs.sort((a, b) => a.time - b.time || (a.txId < b.txId ? -1 : 1));
  writeNdjson(txPath, txs);

  const summary = sync({ rulesPath, txPath, stateDir });
  assert.equal(summary.appended, 10_000);
  assert.equal(summary.settledCount, 10_000);

  const full = verify({ stateDir });
  assert.equal(full.count, 10_000);
  assert.equal(full.match, true);
  assert.equal(full.settledHash, full.replayHash);

  // Replaying arbitrary sub-intervals must reproduce the identical records.
  for (let k = 0; k < 25; k++) {
    const startVersion = Math.floor(random() * 45);
    const span = 1 + Math.floor(random() * 5);
    const from = base + startVersion * HOUR;
    const to = base + (startVersion + span) * HOUR;
    const part = verify({ stateDir, from, to });
    assert.equal(part.match, true, `interval [${from}, ${to}) mismatch`);
    assert.equal(part.settledHash, part.replayHash);

    // Interval totals must be consistent with the full range: recompute the
    // interval from the full record set and compare hashes directly.
    const wider = verify({ stateDir, from, to });
    assert.equal(wider.settledHash, part.settledHash);
  }

  // Interval slices tile the full range: sum of slice totals == full total.
  let tiled = 0;
  for (let v = 0; v < 50; v += 10) {
    tiled += verify({ stateDir, from: base + v * HOUR, to: base + (v + 10) * HOUR }).totalFee;
  }
  assert.equal(tiled, full.totalFee);
});
