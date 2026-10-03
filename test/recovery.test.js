'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ev, close, writeFrames, runCli, runVerify, tmpdir } = require('./helpers');

// Two closes so the events.log log, balance snapshot and a certificate all
// exist mid-stream; every crash point has real state to lose.
function fixture() {
  return [
    ev('e1', 'A', 100, 1, 10),
    ev('e2', 'B', 200, 1, 20),
    close('P1', 100),
    ev('e3', 'A', -30, 2, 110),
    ev('e4', 'B', 50, 2, 120, { causes: ['e3'] }),
    ev('e5', 'A', 70, 3, 130, { replaces: 'e1' }),
    close('P2', 200),
    ev('e6', 'C', 5, 1, 150), // late for P2, settles in auto-final P3
  ];
}

const CRASH_POINTS = ['after-receive', 'after-log', 'after-balance', 'before-cert'];

// Acceptance 4: crash at each persistence point recovers idempotently.
for (const point of CRASH_POINTS) {
  test(`acceptance 4: crash at ${point} recovers to identical output`, () => {
    const { file } = writeFrames(fixture());
    const cleanDir = tmpdir();
    const cleanState = path.join(cleanDir, 's');
    const clean = runCli(file, { state: cleanState });
    assert.equal(clean.status, 0, clean.stderr);
    const norm = (stdout, state) => stdout.split(state).join('<STATE>');
    const expected = norm(clean.stdout, cleanState);

    let lastState;
    for (const at of [1, 2]) {
      const state = path.join(tmpdir(), 's');
      lastState = state;
      const crashed = runCli(file, { state, env: { LEDGER_CRASH_POINT: point, LEDGER_CRASH_AT: String(at) } });
      assert.equal(crashed.status, 42, `expected crash at ${point}#${at}`);
      const recovered = runCli(file, { state });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(norm(recovered.stdout, state), expected, `output after crash at ${point}#${at} differs`);
      // Restarting again on the recovered state is a no-op (idempotent).
      const again = runCli(file, { state });
      assert.equal(again.status, 0, again.stderr);
      assert.equal(norm(again.stdout, state), expected);
    }
    // Every certificate verifies after recovery.
    for (const p of JSON.parse(clean.stdout).periods) {
      const v = runVerify(p.cert.replace(cleanState, lastState));
      assert.equal(v.status, 0, v.stdout);
      assert.equal(JSON.parse(v.stdout).ok, true);
    }
  });
}

test('recovery does not duplicate journal entries', () => {
  const { file } = writeFrames(fixture());
  const state = path.join(tmpdir(), 's');
  assert.equal(runCli(file, { state, env: { LEDGER_CRASH_POINT: 'after-log', LEDGER_CRASH_AT: '1' } }).status, 42);
  assert.equal(runCli(file, { state }).status, 0);
  assert.equal(runCli(file, { state }).status, 0);
  const lines = fs.readFileSync(path.join(state, 'events.log'), 'utf8').trim().split('\n');
  const seqs = lines.map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length, 'duplicate seq in events.log');
});
