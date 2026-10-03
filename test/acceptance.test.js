import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildState, verifyTarget, descendantClosure, COLD_CHAIN_HOURS,
} from '../src/chain.js';
import {
  appendEvent, compact, recover, readEvents, SimulatedCrash, CRASH_POINTS,
} from '../src/store.js';
import { main as cliMain } from '../src/cli.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chain-test-'));
}

// Build a standard two-branch scenario:
//   S1 -> A1 -> M1 (RNA-seq)     S2 -> M2 (RNA-seq, attested)
function standardLog(dir) {
  appendEvent(dir, { type: 'batch', batchId: 'B1', expiresAt: 1000, assays: ['rna-seq'] });
  appendEvent(dir, { type: 'register', sampleId: 'S1', volume: 100, time: 0 });
  appendEvent(dir, { type: 'register', sampleId: 'S2', volume: 100, time: 0 });
  appendEvent(dir, { type: 'aliquot', aliquotId: 'A1', parentId: 'S1', volume: 40, time: 10 });
  appendEvent(dir, { type: 'assay', assayId: 'M1', sourceId: 'A1', batchId: 'B1', assayType: 'rna-seq', time: 20 });
  appendEvent(dir, { type: 'assay', assayId: 'M2', sourceId: 'S2', batchId: 'B1', assayType: 'rna-seq', time: 20 });
  appendEvent(dir, { type: 'attest', targetId: 'M2', signer: 'pathologist-1', time: 30 });
}

test('acceptance 1: revoke propagates downstream; attested independent branch preserved', () => {
  const dir = tmpDir();
  standardLog(dir);
  appendEvent(dir, { type: 'revoke', targetId: 'S1', reason: 'consent-withdrawn', time: 40 });

  const state = buildState(recover(dir));

  const downstream = verifyTarget(state, 'M1', { now: 40 });
  assert.equal(downstream.verdict, 'BROKEN');
  assert.equal(downstream.core.length, 1);
  assert.equal(downstream.core[0].node, 'S1');
  assert.equal(downstream.core[0].reasons[0].kind, 'revoke');

  const independent = verifyTarget(state, 'M2', { now: 40 });
  assert.equal(independent.verdict, 'VALID');
  assert.equal(independent.certificate.attested, true);
  assert.equal(independent.certificate.signatureValid, true);
});

test('acceptance 2: compact preserves verify; crash before rename recovers old log', () => {
  const dir = tmpDir();
  standardLog(dir);
  appendEvent(dir, { type: 'revoke', targetId: 'S1', reason: 'consent-withdrawn', time: 40 });
  // A stale conclusion: cold chain exceeded (100h > 72h).
  appendEvent(dir, { type: 'register', sampleId: 'S3', volume: 50, time: 0 });
  appendEvent(dir, { type: 'assay', assayId: 'M3', sourceId: 'S3', batchId: 'B1', assayType: 'rna-seq', time: COLD_CHAIN_HOURS + 28 });

  const verdictsBefore = {};
  for (const t of ['M1', 'M2', 'M3']) {
    verdictsBefore[t] = verifyTarget(buildState(recover(dir)), t, { now: 40 });
  }
  assert.equal(verdictsBefore.M1.verdict, 'BROKEN');
  assert.equal(verdictsBefore.M2.verdict, 'VALID');
  assert.equal(verdictsBefore.M3.verdict, 'STALE');
  const eventsBefore = readEvents(dir);

  // Crash at every defined failure point: recover must yield a complete log.
  for (const point of CRASH_POINTS) {
    const crashDir = tmpDir();
    for (const e of eventsBefore) appendEvent(crashDir, e);
    assert.throws(() => compact(crashDir, { crashAt: point }), SimulatedCrash);
    const recovered = recover(crashDir);
    const recoveredEvents = readEvents(crashDir);
    assert.ok(
      JSON.stringify(recoveredEvents) === JSON.stringify(eventsBefore)
        || (recoveredEvents.length === 1 && recoveredEvents[0].type === 'snapshot'),
      `recover after crash at ${point} must yield old or new complete log`,
    );
    if (point !== 'after-rename') {
      // Crash before rename: the OLD complete log must be authoritative.
      assert.deepEqual(recovered, eventsBefore, `crash at ${point}`);
    }
    for (const t of ['M1', 'M2', 'M3']) {
      const v = verifyTarget(buildState(recovered), t, { now: 40 });
      assert.equal(v.verdict, verdictsBefore[t].verdict, `verdict drift after crash at ${point}`);
    }
  }

  // Clean compact: verify results (and chain hashes) are unchanged.
  compact(dir);
  assert.equal(readEvents(dir).length, 1);
  assert.equal(readEvents(dir)[0].type, 'snapshot');
  for (const t of ['M1', 'M2', 'M3']) {
    const after = verifyTarget(buildState(recover(dir)), t, { now: 40 });
    assert.deepEqual(after, verdictsBefore[t], `verify drift for ${t} after compact`);
  }
});

test('acceptance 3: QC failure propagates with minimal broken core', () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'batch', batchId: 'B1', expiresAt: 1000, assays: ['rna-seq'] });
  appendEvent(dir, { type: 'register', sampleId: 'S1', volume: 100, time: 0 });
  appendEvent(dir, { type: 'aliquot', aliquotId: 'A1', parentId: 'S1', volume: 40, time: 10 });
  appendEvent(dir, { type: 'aliquot', aliquotId: 'A2', parentId: 'A1', volume: 15, time: 12 });
  appendEvent(dir, { type: 'assay', assayId: 'M1', sourceId: 'A2', batchId: 'B1', assayType: 'rna-seq', time: 20 });
  appendEvent(dir, { type: 'qc_fail', targetId: 'A1', reason: 'contamination', time: 25 });

  const state = buildState(recover(dir));
  const v = verifyTarget(state, 'M1', { now: 30 });
  assert.equal(v.verdict, 'BROKEN');
  // Minimal core is exactly the qc_fail on A1 -- not S1, not M1 itself.
  assert.equal(v.core.length, 1);
  assert.equal(v.core[0].node, 'A1');
  assert.equal(v.core[0].reasons[0].kind, 'qc_fail');
  assert.equal(v.core[0].reasons[0].detail, 'contamination');
});

test('constraint breaks: volume conservation and reagent compatibility', () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'batch', batchId: 'B1', expiresAt: 1000, assays: ['rna-seq'] });
  appendEvent(dir, { type: 'register', sampleId: 'S1', volume: 50, time: 0 });
  appendEvent(dir, { type: 'aliquot', aliquotId: 'A1', parentId: 'S1', volume: 40, time: 10 });
  appendEvent(dir, { type: 'aliquot', aliquotId: 'A2', parentId: 'S1', volume: 20, time: 11 }); // 40+20 > 50
  appendEvent(dir, { type: 'assay', assayId: 'M1', sourceId: 'A2', batchId: 'B1', assayType: 'rna-seq', time: 20 });
  appendEvent(dir, { type: 'assay', assayId: 'M2', sourceId: 'A1', batchId: 'B1', assayType: 'wgs', time: 20 }); // incompatible

  const state = buildState(recover(dir));
  const v1 = verifyTarget(state, 'M1', { now: 30 });
  assert.equal(v1.verdict, 'BROKEN');
  assert.equal(v1.core[0].node, 'A2');
  assert.equal(v1.core[0].reasons[0].reason, 'volume-conservation');

  const v2 = verifyTarget(state, 'M2', { now: 30 });
  assert.equal(v2.verdict, 'BROKEN');
  assert.equal(v2.core[0].node, 'M2');
  assert.equal(v2.core[0].reasons[0].reason, 'reagent-incompatible');
});

test('PENDING on exhausted audit budget is not BROKEN', () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'batch', batchId: 'B1', expiresAt: 1000, assays: ['rna-seq'] });
  appendEvent(dir, { type: 'register', sampleId: 'S1', volume: 100, time: 0 });
  appendEvent(dir, { type: 'aliquot', aliquotId: 'A1', parentId: 'S1', volume: 40, time: 10 });
  appendEvent(dir, { type: 'assay', assayId: 'M1', sourceId: 'A1', batchId: 'B1', assayType: 'rna-seq', time: 20 });

  const state = buildState(recover(dir));
  const pending = verifyTarget(state, 'M1', { budget: 1, now: 30 });
  assert.equal(pending.verdict, 'PENDING');
  assert.notEqual(pending.verdict, 'BROKEN');
  const full = verifyTarget(state, 'M1', { budget: 100, now: 30 });
  assert.equal(full.verdict, 'VALID');
});

test('acceptance 4: derivation closure enumeration cross-check (n <= 8)', () => {
  // Independent brute-force fixpoint implementation.
  function bruteClosure(n, edges, sources) {
    const tainted = new Set(sources);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [a, b] of edges) {
        if (tainted.has(a) && !tainted.has(b)) { tainted.add(b); changed = true; }
      }
    }
    return tainted;
  }
  const allEdges = (n) => {
    const e = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) e.push([i, j]);
    return e;
  };
  const subsets = (arr) => arr.reduce((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);

  let checked = 0;
  // Exhaustive for n <= 5: every DAG x every revoked-source subset.
  for (let n = 1; n <= 5; n++) {
    for (const edges of subsets(allEdges(n))) {
      for (const sources of subsets([...Array(n).keys()])) {
        assert.deepEqual(
          descendantClosure(n, edges, sources),
          bruteClosure(n, edges, sources),
        );
        checked++;
      }
    }
  }
  // Random DAGs for n = 6..8.
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 6; n <= 8; n++) {
    for (let trial = 0; trial < 500; trial++) {
      const edges = allEdges(n).filter(() => rand() < 0.3);
      const sources = [...Array(n).keys()].filter(() => rand() < 0.3);
      assert.deepEqual(
        descendantClosure(n, edges, sources),
        bruteClosure(n, edges, sources),
      );
      checked++;
    }
  }
  assert.ok(checked > 5000, `expected thorough enumeration, checked ${checked}`);
});

test('CLI smoke test: append, verify, compact, recover', () => {
  const dir = tmpDir();
  const cli = (args) => cliMain([dir, ...args]);
  cli(['batch', 'B1', '1000', 'rna-seq']);
  cli(['register', 'S1', '100', '0']);
  cli(['aliquot', 'A1', 'S1', '40', '10']);
  cli(['assay', 'M1', 'A1', 'B1', 'rna-seq', '20']);
  const valid = JSON.parse(cli(['verify', 'M1', '--now', '30']).stdout);
  assert.equal(valid.verdict, 'VALID');
  cli(['revoke', 'S1', 'consent-withdrawn', '40']);
  const brokenResult = cli(['verify', 'M1', '--now', '50']);
  assert.equal(brokenResult.code, 1);
  const broken = JSON.parse(brokenResult.stdout);
  assert.equal(broken.verdict, 'BROKEN');
  cli(['compact']);
  const stillBroken = JSON.parse(cli(['verify', 'M1', '--now', '50']).stdout);
  assert.equal(stillBroken.verdict, 'BROKEN');
  assert.equal(stillBroken.core[0].node, 'S1');
});
