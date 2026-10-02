import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cli, readJson, writeJson, journalRecords, branchyProtocol, setupRun,
} from './helpers.js';

test('error: missing product in state dir exits 2 (MISSING_PRODUCT)', () => {
  const run = setupRun(branchyProtocol());
  const crash = cli(['run', '--protocol', run.protocolPath, '--journal', run.journalPath, '--crash-at', 'dilute:before-effect', '--now', '1000']);
  assert.equal(crash.code, 70, crash.stderr);
  // weigh committed its effect, but its product file disappears before recovery
  fs.unlinkSync(path.join(run.stateDir, 'weighed.json'));
  const recover = cli(['recover', '--journal', run.journalPath, '--now', '1000']);
  assert.equal(recover.code, 2, recover.stderr);
  assert.match(recover.stderr, /MISSING_PRODUCT/);
  const report = readJson(run.reportPath);
  assert.equal(report.status, 'failed');
  assert.equal(report.errors[0].code, 'MISSING_PRODUCT');
});

test('error: join committed despite upstream timeout exits 2 (TIMEOUT_JOIN)', () => {
  const protocol = {
    name: 'tjoin',
    inputs: ['sample'],
    steps: [
      { id: 'a', op: 'weigh', requires: ['sample'], produces: ['A'] },
      { id: 'b', op: 'incubate', requires: ['A'], produces: ['B'], timeout: 10 },
      { id: 'c', op: 'mix', requires: ['sample'], produces: ['C'] },
      { id: 'j', op: 'mix', requires: ['B', 'C'], produces: ['J'] },
    ],
  };
  const run = setupRun(protocol);
  // hand-crafted journal: b is half-done (intent only, old ts) yet the join j
  // already committed its effect/checkpoint -> inconsistent
  const recs = [
    { type: 'run_start', runId: 'run', protocol, ts: 100 },
    { type: 'intent', step: 'a', requires: ['sample'], produces: ['A'], ts: 100 },
    { type: 'effect', step: 'a', consumed: ['sample'], produced: ['A'], ts: 100 },
    { type: 'checkpoint', step: 'a', status: 'done', ts: 100 },
    { type: 'intent', step: 'c', requires: ['sample'], produces: ['C'], ts: 100 },
    { type: 'effect', step: 'c', consumed: ['sample'], produced: ['C'], ts: 100 },
    { type: 'checkpoint', step: 'c', status: 'done', ts: 100 },
    { type: 'intent', step: 'b', requires: ['A'], produces: ['B'], ts: 100 },
    { type: 'intent', step: 'j', requires: ['B', 'C'], produces: ['J'], ts: 100 },
    { type: 'effect', step: 'j', consumed: ['B', 'C'], produced: ['J'], ts: 100 },
    { type: 'checkpoint', step: 'j', status: 'done', ts: 100 },
  ];
  const lines = recs.map((r, i) => JSON.stringify({ v: 1, seq: i + 1, ...r }));
  fs.writeFileSync(run.journalPath, lines.join('\n') + '\n');
  // state files backing the committed effects
  for (const [artifact, by] of [['A', 'a'], ['C', 'c'], ['J', 'j']]) {
    writeJson(path.join(run.stateDir, `${artifact}.json`), { artifact, producedBy: by });
  }
  const recover = cli(['recover', '--journal', run.journalPath, '--now', '100000']);
  assert.equal(recover.code, 2, recover.stderr);
  assert.match(recover.stderr, /TIMEOUT_JOIN/);
});

test('error: aborting an already completed join exits 2 (ABORT_COMPLETED_JOIN)', () => {
  const run = setupRun(branchyProtocol());
  const r = cli(['run', '--protocol', run.protocolPath, '--journal', run.journalPath, '--now', '1000']);
  assert.equal(r.code, 0, r.stderr);
  const recover = cli(['recover', '--journal', run.journalPath, '--abort-at', 'incubate', '--now', '2000']);
  assert.equal(recover.code, 2, recover.stderr);
  assert.match(recover.stderr, /ABORT_COMPLETED_JOIN/);
});

test('journal: torn final line is truncated and reported on recovery', () => {
  const run = setupRun(branchyProtocol());
  const crash = cli(['run', '--protocol', run.protocolPath, '--journal', run.journalPath, '--crash-at', 'incubate:during-checkpoint', '--now', '1000']);
  assert.equal(crash.code, 70, crash.stderr);
  const tail = fs.readFileSync(run.journalPath, 'utf8').trim().split('\n').at(-1);
  assert.throws(() => JSON.parse(tail), 'last journal line should be a torn checkpoint');
  const recover = cli(['recover', '--journal', run.journalPath, '--now', '1000']);
  assert.equal(recover.code, 0, recover.stderr);
  const report = readJson(run.reportPath);
  assert.equal(report.tornLineTruncated, true);
  // every remaining journal line is valid JSON
  for (const line of fs.readFileSync(run.journalPath, 'utf8').trim().split('\n')) JSON.parse(line);
});

test('cli: usage and protocol validation errors exit 2', () => {
  assert.equal(cli([]).code, 2);
  const run = setupRun(branchyProtocol());
  assert.equal(cli(['run', '--journal', run.journalPath]).code, 2); // missing --protocol
  const bad = setupRun({ name: 'bad', steps: [{ id: 'x', op: 'weigh', requires: ['ghost'], produces: [] }] });
  const r = cli(['run', '--protocol', bad.protocolPath, '--journal', bad.journalPath]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PROTOCOL_INVALID/);
});

test('cli: run on a non-empty journal exits 2, recover continues it', () => {
  const run = setupRun(branchyProtocol());
  const crash = cli(['run', '--protocol', run.protocolPath, '--journal', run.journalPath, '--crash-at', 'mix:after-effect', '--now', '1000']);
  assert.equal(crash.code, 70, crash.stderr);
  const again = cli(['run', '--protocol', run.protocolPath, '--journal', run.journalPath, '--now', '1000']);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /JOURNAL_EXISTS/);
  const recover = cli(['recover', '--journal', run.journalPath, '--now', '1000']);
  assert.equal(recover.code, 0, recover.stderr);
  const records = journalRecords(run.journalPath);
  // effect of mix was committed before the crash and must not be repeated
  assert.equal(records.filter((x) => x.type === 'effect' && x.step === 'mix').length, 1);
});
