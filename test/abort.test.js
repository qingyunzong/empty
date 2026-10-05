'use strict';

// Acceptance 2: one parallel branch aborts -> the join must never trigger.
// Also: aborting an already-completed join exits with code 2.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  makeDir,
  runCli,
  writeProtocol,
  readJson,
  readJournal,
  branchingProtocol,
} = require('./helpers');

test('abort of parallel branch prevents join and writes compensation chain', () => {
  const dir = makeDir('lab-abort-');
  const proto = writeProtocol(dir, branchingProtocol());
  const journal = path.join(dir, 'run.jsonl');

  const r = runCli(['run', '--protocol', proto, '--journal', journal, '--abort-step', 'heat', '--now', '1000000']);
  assert.equal(r.status, 0, r.stderr);

  const result = readJson(path.join(dir, 'result.json'));
  assert.equal(result.status, 'aborted');
  assert.equal(result.steps.heat.status, 'aborted');
  assert.equal(result.steps.cool.status, 'done');
  assert.equal(result.steps.combine.status, 'released');

  const records = readJournal(journal);
  const combineEffect = records.find((rec) => rec.type === 'effect' && rec.step === 'combine');
  assert.equal(combineEffect, undefined, 'join must not trigger');

  const comp = records.filter((rec) => rec.type === 'compensation');
  const consumed = comp.filter((c) => c.action === 'mark-consumed').map((c) => c.product).sort();
  assert.deepEqual(consumed, ['s.diluted', 's.weighed']);
  const released = comp.filter((c) => c.action === 'release').map((c) => c.step);
  assert.deepEqual(released, ['combine']);
});

test('abort of completed join exits with code 2', () => {
  const dir = makeDir('lab-abort2-');
  const proto = writeProtocol(dir, branchingProtocol());
  const journal = path.join(dir, 'run.jsonl');

  const r = runCli(['run', '--protocol', proto, '--journal', journal, '--now', '1000000']);
  assert.equal(r.status, 0, r.stderr);

  const a = runCli(['abort', '--journal', journal, '--step', 'combine']);
  assert.equal(a.status, 2);
  assert.match(a.stderr, /ABORT_COMPLETED/);
});
