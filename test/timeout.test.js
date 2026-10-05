'use strict';

// Acceptance 3: incubation that exceeded its timeout while crashed is
// discarded on recovery, and the compensation chain is auditable.

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
  readJournal,
  linearProtocol,
} = require('./helpers');

const T0 = 1_000_000;

test('timed-out incubation is discarded on recovery with auditable compensation', () => {
  const dir = makeDir('lab-timeout-');
  const proto = writeProtocol(dir, linearProtocol({ incubate: 5 })); // 5s timeout
  const journal = path.join(dir, 'run.jsonl');

  const crashed = runCli([
    'run', '--protocol', proto, '--journal', journal,
    '--crash-at', 'before-effect:incubate', '--now', String(T0),
  ]);
  assert.equal(crashed.status, CRASH_EXIT);

  // Power comes back 6 seconds later: incubation (timeout 5s) is stale.
  const recovered = runCli(['recover', '--journal', journal, '--now', String(T0 + 6000)]);
  assert.equal(recovered.status, 0, recovered.stderr);

  const report = readJson(path.join(dir, 'recovery_report.json'));
  assert.deepEqual(
    report.discardedSteps.map((d) => [d.step, d.reason]),
    [['incubate', 'timeout']],
  );
  const consumed = report.compensations.filter((c) => c.action === 'mark-consumed').map((c) => c.product).sort();
  assert.deepEqual(consumed, ['s.diluted', 's.mixed', 's.weighed']);
  const released = report.compensations.filter((c) => c.action === 'release').map((c) => c.step);
  assert.deepEqual(released, ['measure']);

  // Auditable in the journal itself.
  const records = readJournal(journal);
  const discard = records.find((r) => r.type === 'discard' && r.step === 'incubate');
  assert.ok(discard, 'discard record in journal');
  assert.equal(discard.reason, 'timeout');
  assert.ok(records.some((r) => r.type === 'compensation' && r.for === 'incubate'));

  // Consumed markers materialized in the state dir.
  for (const p of ['s.weighed', 's.diluted', 's.mixed']) {
    assert.ok(fs.existsSync(path.join(dir, 'state', `${p}.consumed`)), `${p}.consumed marker`);
  }

  const result = readJson(path.join(dir, 'result.json'));
  assert.equal(result.status, 'failed');
  assert.equal(result.steps.incubate.status, 'discarded');
  assert.equal(result.steps.measure.status, 'released');
});
