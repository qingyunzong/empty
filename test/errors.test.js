'use strict';

// Error contract: missing product, timeout-but-joined -> exit code 2.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {
  CRASH_EXIT,
  makeDir,
  runCli,
  writeProtocol,
  linearProtocol,
} = require('./helpers');

const T0 = 1_000_000;

test('protocol requiring a product nobody produces exits 2', () => {
  const dir = makeDir('lab-err-');
  const bad = linearProtocol();
  bad.steps[1].requires = ['s.nonexistent'];
  const proto = writeProtocol(dir, bad);
  const r = runCli(['run', '--protocol', proto, '--journal', path.join(dir, 'run.jsonl')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /MISSING_PRODUCT/);
});

test('product file deleted after durable effect exits 2 on recovery', () => {
  const dir = makeDir('lab-err2-');
  const proto = writeProtocol(dir, linearProtocol());
  const journal = path.join(dir, 'run.jsonl');
  const crashed = runCli([
    'run', '--protocol', proto, '--journal', journal,
    '--crash-at', 'after-effect:mix', '--now', String(T0),
  ]);
  assert.equal(crashed.status, CRASH_EXIT);
  fs.unlinkSync(path.join(dir, 'state', 's.mixed'));
  const recovered = runCli(['recover', '--journal', journal, '--now', String(T0 + 1000)]);
  assert.equal(recovered.status, 2);
  assert.match(recovered.stderr, /MISSING_PRODUCT/);
});

test('downstream joined despite timed-out upstream exits 2', () => {
  const dir = makeDir('lab-err3-');
  const proto = writeProtocol(dir, linearProtocol({ incubate: 5 }));
  const journal = path.join(dir, 'run.jsonl');
  const crashed = runCli([
    'run', '--protocol', proto, '--journal', journal,
    '--crash-at', 'before-effect:incubate', '--now', String(T0),
  ]);
  assert.equal(crashed.status, CRASH_EXIT);

  // Hand-craft an inconsistent journal: measure completed without incubate.
  const fake = [
    { v: 1, ts: T0 + 100, type: 'intent', step: 'measure', attempt: 1, requires: ['s.incubated'], produces: ['s.result'] },
    { v: 1, ts: T0 + 101, type: 'effect', step: 'measure', attempt: 1, produces: ['s.result'] },
    { v: 1, ts: T0 + 102, type: 'checkpoint', step: 'measure', attempt: 1, status: 'done' },
  ];
  fs.appendFileSync(journal, fake.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const recovered = runCli(['recover', '--journal', journal, '--now', String(T0 + 6000)]);
  assert.equal(recovered.status, 2);
  assert.match(recovered.stderr, /TIMEOUT_JOINED/);
});
