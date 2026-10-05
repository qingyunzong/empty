'use strict';

// Acceptance 4: enumerate every crash position (3 fault points x 5 steps)
// for the 5-step protocol; every recovered state must match the reference.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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
const STEPS = ['weigh', 'dilute', 'mix', 'incubate', 'measure'];
const POINTS = ['before-effect', 'after-effect', 'during-checkpoint'];

function freshDir(tag) {
  const dir = makeDir(`lab-enum-${tag}-`);
  const proto = writeProtocol(dir, linearProtocol());
  return { dir, proto, journal: path.join(dir, 'run.jsonl') };
}

const refDir = freshDir('ref');
const refRun = runCli(['run', '--protocol', refDir.proto, '--journal', refDir.journal, '--now', String(NOW)]);
assert.equal(refRun.status, 0, refRun.stderr);
const reference = normalizeResult(readJson(path.join(refDir.dir, 'result.json')));

for (const step of STEPS) {
  for (const point of POINTS) {
    test(`crash ${point}:${step} recovers to reference state`, () => {
      const { dir, proto, journal } = freshDir(`${point}-${step}`);
      const crashed = runCli([
        'run', '--protocol', proto, '--journal', journal,
        '--crash-at', `${point}:${step}`, '--now', String(NOW),
      ]);
      assert.equal(crashed.status, CRASH_EXIT, crashed.stderr);

      const recovered = runCli(['recover', '--journal', journal, '--now', String(NOW + 1000)]);
      assert.equal(recovered.status, 0, recovered.stderr);

      const result = normalizeResult(readJson(path.join(dir, 'result.json')));
      assert.deepEqual(result, reference);
    });
  }
}
