'use strict';

// Acceptance 1: inject crash at each of the 3 fault points; after recovery
// the result must equal the uninterrupted reference run.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  CRASH_EXIT,
  makeDir,
  runCli,
  writeProtocol,
  readJson,
  normalizeResult,
  linearProtocol,
} = require('./helpers');

const NOW = 1_000_000;

function referenceRun() {
  const dir = makeDir('lab-ref-');
  const proto = writeProtocol(dir, linearProtocol());
  const journal = path.join(dir, 'run.jsonl');
  const r = runCli(['run', '--protocol', proto, '--journal', journal, '--now', String(NOW)]);
  assert.equal(r.status, 0, r.stderr);
  return readJson(path.join(dir, 'result.json'));
}

const ref = referenceRun();

for (const point of ['before-effect', 'after-effect', 'during-checkpoint']) {
  test(`crash at ${point}:incubate recovers to reference result`, () => {
    const dir = makeDir('lab-crash-');
    const proto = writeProtocol(dir, linearProtocol());
    const journal = path.join(dir, 'run.jsonl');

    const crashed = runCli([
      'run', '--protocol', proto, '--journal', journal,
      '--crash-at', `${point}:incubate`, '--now', String(NOW),
    ]);
    assert.equal(crashed.status, CRASH_EXIT, `expected crash exit, got ${crashed.status}: ${crashed.stderr}`);

    const recovered = runCli(['recover', '--journal', journal, '--now', String(NOW + 1000)]);
    assert.equal(recovered.status, 0, recovered.stderr);

    const result = readJson(path.join(dir, 'result.json'));
    assert.deepEqual(normalizeResult(result), normalizeResult(ref));

    const refDir = null; // product files compared against expected set
    assert.deepEqual(result.products, ['s.diluted', 's.incubated', 's.mixed', 's.result', 's.weighed']);

    const report = readJson(path.join(dir, 'recovery_report.json'));
    if (point === 'before-effect') {
      assert.deepEqual(report.continuedSteps, ['incubate']);
    } else {
      assert.deepEqual(report.effectsPreserved, ['incubate']);
      assert.deepEqual(report.repairedCheckpoints, ['incubate']);
    }
    if (point === 'during-checkpoint') {
      assert.equal(report.tornRecords.length, 1);
    }
  });
}
