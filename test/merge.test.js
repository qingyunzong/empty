import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { tmpdirPath, mulberry32, shuffle } from '../testlib/helpers.js';
import { appendToLog, readJsonl, writeJsonl } from '../lib/store.js';
import { verify, loadRecords, causalOrder } from '../lib/verify.js';
import { canonical } from '../lib/canon.js';

function copyRecords(logFile, records) {
  for (const r of records) appendFileSync(logFile, canonical(r) + '\n');
}

// Acceptance 1: three sites, out-of-order merge is replayable.
test('three-site out-of-order merge replays to the same head', () => {
  const dir = tmpdirPath();
  const logA = join(dir, 'a.jsonl');
  const logB = join(dir, 'b.jsonl');
  const logC = join(dir, 'c.jsonl');

  // A works alone at epoch 1.
  appendToLog(logA, { site: 'A', epoch: 1, type: 'step', payload: { step: 'sterilize' } });
  appendToLog(logA, { site: 'A', epoch: 1, type: 'step', payload: { step: 'fill' } });
  // B receives A's log (site-to-site sync), then records its own step: B's
  // record causally depends on A's first two records via the vector clock.
  copyRecords(logB, readJsonl(logA));
  appendToLog(logB, { site: 'B', epoch: 1, type: 'step', payload: { step: 'env-check' } });
  // C works independently at epoch 2.
  appendToLog(logC, { site: 'C', epoch: 2, type: 'deviation', payload: { dev: 'pressure-drop' } });
  appendToLog(logC, { site: 'C', epoch: 2, type: 'step', payload: { step: 'stop-line' } });
  // A receives C's log, then resumes at epoch 2.
  copyRecords(logA, readJsonl(logC));
  appendToLog(logA, { site: 'A', epoch: 2, type: 'step', payload: { step: 'resume' } });

  const all = [...readJsonl(logA), ...readJsonl(logB), ...readJsonl(logC)];
  assert.equal(new Set(all.map((r) => r.hash)).size, 6, "6 unique records, copies dedupe by hash");

  const rand = mulberry32(42);
  const heads = new Set();
  for (let trial = 0; trial < 12; trial++) {
    const shuffled = shuffle(all, rand);
    const cert = verify(shuffled);
    heads.add(cert.head);
    assert.equal(cert.status, 'ok');
    assert.deepEqual(cert.missing, []);
  }
  assert.equal(heads.size, 1, 'all shuffles must converge to one chain head');

  // Replay: merging the canonical merged output again yields the same head.
  const ordered = causalOrder(loadRecords(all));
  const mergedFile = join(dir, 'merged.jsonl');
  writeJsonl(mergedFile, ordered);
  const replayed = verify(readJsonl(mergedFile));
  assert.equal(replayed.head, verify(all).head, 'replayed merge keeps the same head');

  // B's step must sort after A's first two records (vector causality).
  const bStep = all.find((r) => r.site === 'B');
  const aFirst = all.find((r) => r.site === 'A' && r.seq === 2);
  const pos = new Map(ordered.map((r, i) => [r.hash, i]));
  assert.ok(pos.get(bStep.hash) > pos.get(aFirst.hash), 'causal order respected');
});
