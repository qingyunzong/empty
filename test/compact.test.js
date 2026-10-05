'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLog, appendEvent, compact, recover, SENTINEL } = require('../src/logio');
const { foldEvents } = require('../src/state');
const { verify } = require('../src/verify');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const H = 3600 * 1000;

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-'));
  return path.join(dir, 'evidence.log');
}

function seedLog(log) {
  const events = [
    { type: 'register', id: 'S1', kind: 'sample', volume: 100, time: iso(T0) },
    { type: 'register', id: 'B1', kind: 'batch', reagent: 'R1', time: iso(T0) },
    { type: 'aliquot', id: 'A1', parent: 'S1', volume: 40, time: iso(T0 + H) },
    { type: 'assay', id: 'X1', parent: 'A1', batch: 'B1', reagent: 'R1', conclusion: 'c1', time: iso(T0 + 2 * H) },
    { type: 'register', id: 'S2', kind: 'sample', volume: 100, time: iso(T0) },
    { type: 'aliquot', id: 'A2', parent: 'S2', volume: 40, time: iso(T0 + H) },
    { type: 'assay', id: 'X2', parent: 'A2', batch: 'B1', reagent: 'R1', conclusion: 'c2', time: iso(T0 + 2 * H) },
    { type: 'qc_fail', target: 'A2', time: iso(T0 + 3 * H) },
    { type: 'attest', target: 'X1', signature: 'sig:auditor-1', time: iso(T0 + 3 * H) },
    { type: 'revoke', target: 'S2', reason: 'consent withdrawn', time: iso(T0 + 4 * H) },
  ];
  for (const ev of events) appendEvent(log, ev);
  return events;
}

function statuses(log, now) {
  return verify(foldEvents(readLog(log)), { now }).results
    .map((r) => `${r.assay}:${r.status}`).sort();
}

test('acceptance 2: verify results are identical before and after compact', () => {
  const log = tmpLog();
  seedLog(log);
  const now = iso(T0 + 5 * H);
  const before = statuses(log, now);
  const { before: nBefore, after: nAfter } = compact(log);
  assert.equal(nBefore, 10);
  assert.equal(nAfter, 1);
  const after = statuses(log, now);
  assert.deepEqual(after, before);
  // And the compacted log still folds to a state with the same violations.
  assert.deepEqual(
    foldEvents(readLog(log)).violations,
    foldEvents(seedLogReplay()).violations,
  );
});

function seedLogReplay() {
  return [
    { type: 'register', id: 'S1', kind: 'sample', volume: 100, time: iso(T0) },
    { type: 'register', id: 'B1', kind: 'batch', reagent: 'R1', time: iso(T0) },
    { type: 'aliquot', id: 'A1', parent: 'S1', volume: 40, time: iso(T0 + H) },
    { type: 'assay', id: 'X1', parent: 'A1', batch: 'B1', reagent: 'R1', conclusion: 'c1', time: iso(T0 + 2 * H) },
    { type: 'register', id: 'S2', kind: 'sample', volume: 100, time: iso(T0) },
    { type: 'aliquot', id: 'A2', parent: 'S2', volume: 40, time: iso(T0 + H) },
    { type: 'assay', id: 'X2', parent: 'A2', batch: 'B1', reagent: 'R1', conclusion: 'c2', time: iso(T0 + 2 * H) },
    { type: 'qc_fail', target: 'A2', time: iso(T0 + 3 * H) },
    { type: 'attest', target: 'X1', signature: 'sig:auditor-1', time: iso(T0 + 3 * H) },
    { type: 'revoke', target: 'S2', reason: 'consent withdrawn', time: iso(T0 + 4 * H) },
  ];
}

test('acceptance 2: crash before rename recovers the old complete log', () => {
  const log = tmpLog();
  seedLog(log);
  const now = iso(T0 + 5 * H);
  const before = statuses(log, now);
  const oldBytes = fs.readFileSync(log, 'utf8');

  // Simulate a crash mid-compact: a torn .tmp exists, rename never happened.
  fs.writeFileSync(log + '.tmp', '{"type":"snapshot","state":{"entities":[{'); // torn write
  assert.equal(recover(log), 'old');
  assert.equal(fs.readFileSync(log, 'utf8'), oldBytes); // old log intact
  assert.deepEqual(statuses(log, now), before);
  assert.ok(!fs.existsSync(log + '.tmp'));
});

test('crash after fsync(tmp) but before rename recovers the new complete log', () => {
  const log = tmpLog();
  seedLog(log);
  const now = iso(T0 + 5 * H);
  const before = statuses(log, now);

  // Build the would-be compacted payload, then "crash" before rename.
  const state = foldEvents(readLog(log));
  const snapshotLine = JSON.stringify({ type: 'snapshot', state: require('../src/state').snapshotOf(state) });
  fs.writeFileSync(log + '.tmp', snapshotLine + '\n' + SENTINEL + '\n');

  assert.equal(recover(log), 'new');
  assert.deepEqual(statuses(log, now), before); // new complete log, same verdicts
  assert.equal(readLog(log).length, 1);
});

test('recover on a clean log is a no-op', () => {
  const log = tmpLog();
  seedLog(log);
  assert.equal(recover(log), 'clean');
});
