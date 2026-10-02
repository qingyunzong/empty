import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cli, readJson, stateFiles, journalRecords, effectsOf,
  branchyProtocol, linear5Protocol, setupRun,
} from './helpers.js';

const POINTS = ['before-effect', 'after-effect', 'during-checkpoint'];

function runReference(protocol) {
  const ref = setupRun(protocol);
  const r = cli(['run', '--protocol', ref.protocolPath, '--journal', ref.journalPath, '--now', '1000']);
  assert.equal(r.code, 0, r.stderr);
  return {
    result: readJson(ref.resultPath),
    state: stateFiles(ref.stateDir),
    effects: effectsOf(journalRecords(ref.journalPath)),
  };
}

function crashAndRecover(protocol, crashAt, { runNow = '1000', recoverNow = '1000' } = {}) {
  const run = setupRun(protocol);
  const crash = cli(['run', '--protocol', run.protocolPath, '--journal', run.journalPath, '--crash-at', crashAt, '--now', runNow]);
  const recover = cli(['recover', '--journal', run.journalPath, '--now', recoverNow]);
  return { run, crash, recover };
}

test('acceptance 1: crash at each of the 3 fault points recovers to the continuous-run reference', () => {
  const protocol = branchyProtocol();
  const ref = runReference(protocol);
  for (const point of POINTS) {
    const { run, crash, recover } = crashAndRecover(protocol, `mix:${point}`);
    assert.equal(crash.code, 70, `crash at mix:${point} should exit 70, got ${crash.code}: ${crash.stderr}`);
    assert.equal(recover.code, 0, `recover after mix:${point} failed: ${recover.stderr}`);
    assert.deepEqual(readJson(run.resultPath), ref.result, `result.json mismatch after crash at mix:${point}`);
    assert.deepEqual(stateFiles(run.stateDir), ref.state, `state dir mismatch after crash at mix:${point}`);
    assert.deepEqual(effectsOf(journalRecords(run.journalPath)), ref.effects, `effects mismatch after crash at mix:${point}`);
  }
});

test('acceptance 2: abort of one parallel branch never triggers the join', () => {
  const run = setupRun(branchyProtocol());
  const r = cli(['run', '--protocol', run.protocolPath, '--journal', run.journalPath, '--abort-at', 'mix', '--now', '1000']);
  assert.equal(r.code, 1, `aborted run should exit 1, got ${r.code}: ${r.stderr}`);

  const result = readJson(run.resultPath);
  assert.equal(result.status, 'aborted');
  const status = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
  assert.deepEqual(status, { weigh: 'done', dilute: 'done', mix: 'released', incubate: 'released' });

  const records = journalRecords(run.journalPath);
  const joinRecords = records.filter((x) => x.step === 'incubate' && (x.type === 'effect' || x.type === 'checkpoint'));
  assert.equal(joinRecords.length, 0, 'join step must not produce any effect/checkpoint');
  assert.ok(records.some((x) => x.type === 'abort' && x.step === 'mix'));

  // compensation chain: consumed inputs marked, unstarted steps released, waste discarded
  const comps = records.filter((x) => x.type === 'compensate').map((x) => ({ step: x.step, action: x.action, artifacts: x.artifacts }));
  assert.ok(comps.some((c) => c.step === 'weigh' && c.action === 'mark_consumed' && c.artifacts.includes('sample')));
  assert.ok(comps.some((c) => c.step === 'dilute' && c.action === 'discard' && c.artifacts.includes('diluted')));
  assert.ok(comps.some((c) => c.step === 'mix' && c.action === 'release'));
  assert.ok(comps.some((c) => c.step === 'incubate' && c.action === 'release'));

  // a later recover must not silently complete the join either
  const again = cli(['recover', '--journal', run.journalPath, '--now', '2000']);
  assert.equal(again.code, 1);
  assert.equal(journalRecords(run.journalPath).filter((x) => x.step === 'incubate' && x.type === 'effect').length, 0);
});

test('acceptance 3: timed-out incubation is discarded on recovery and compensation is auditable', () => {
  const protocol = branchyProtocol(50); // incubate timeout: 50ms
  const { run, crash, recover } = crashAndRecover(protocol, 'incubate:before-effect', { runNow: '1000', recoverNow: '9000' });
  assert.equal(crash.code, 70, crash.stderr);
  assert.equal(recover.code, 1, `timeout discard should end aborted (exit 1): ${recover.stderr}`);

  const report = readJson(run.reportPath);
  assert.equal(report.status, 'aborted');
  assert.ok(report.actions.some((a) => a.step === 'incubate' && a.action === 'discard' && a.reason === 'timeout'));

  const result = readJson(run.resultPath);
  const status = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
  assert.equal(status.incubate, 'discarded');
  assert.ok(!stateIncludes(run.stateDir, 'incubated.json'), 'half-finished product must be removed');

  // auditable compensation chain persisted in the journal
  const comps = journalRecords(run.journalPath).filter((x) => x.type === 'compensate');
  assert.ok(comps.some((c) => c.step === 'incubate' && c.action === 'discard' && c.reason === 'timeout' && c.artifacts.includes('incubated')));
  assert.ok(comps.some((c) => c.step === 'incubate' && c.action === 'mark_consumed' && c.artifacts.includes('diluted') && c.artifacts.includes('mixed')));
  assert.ok(comps.some((c) => c.step === 'weigh' && c.action === 'mark_consumed' && c.artifacts.includes('sample')));
});

function stateIncludes(dir, file) {
  return stateFiles(dir).includes(file);
}

test('acceptance 4: enumerate all crash positions of a 5-step protocol and compare states', async (t) => {
  const protocol = linear5Protocol();
  const ref = runReference(protocol);
  const steps = protocol.steps.map((s) => s.id);
  assert.equal(steps.length, 5);

  for (const step of steps) {
    for (const point of POINTS) {
      await t.test(`crash at ${step}:${point}`, () => {
        const { run, crash, recover } = crashAndRecover(protocol, `${step}:${point}`);
        assert.equal(crash.code, 70, crash.stderr);
        assert.equal(recover.code, 0, recover.stderr);
        assert.deepEqual(readJson(run.resultPath), ref.result);
        assert.deepEqual(stateFiles(run.stateDir), ref.state);
        assert.deepEqual(effectsOf(journalRecords(run.journalPath)), ref.effects);
      });
    }
  }
});
