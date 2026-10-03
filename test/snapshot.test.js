'use strict';

// Acceptance 4: after a crash, the snapshot restores the state and the
// certificate is recomputed identically from the event log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');
const { execute } = require('../cli');

function run(args) {
  try {
    return { code: 0, body: execute(args) };
  } catch (err) {
    if (err instanceof core.AuditError) {
      return { code: err.exitCode, body: { ok: false, error: err.code, message: err.message } };
    }
    throw err;
  }
}

function buildHistory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-snap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state.json');
  run(['open', '--state', state, '--reviewer', 'R1', '--skills', 'mol,ihc']);
  run(['open', '--state', state, '--reviewer', 'R2', '--skills', 'mol', '--unavailable', '2-4']);
  run(['open', '--state', state, '--case', 'C1', '--dept', 'patho', '--risk', '80', '--deadline', '6', '--skill', 'mol', '--now', '0']);
  run(['open', '--state', state, '--case', 'C2', '--dept', 'heme', '--risk', '55', '--deadline', '8', '--skill', 'ihc', '--now', '0']);
  run(['assign', '--state', state, '--now', '0']);
  run(['correct', '--state', state, '--case', 'C2', '--risk', '90', '--now', '1']);
  run(['assign', '--state', state, '--now', '1']);
  run(['close', '--state', state, '--case', 'C1', '--now', '2']);
  run(['appeal', '--state', state, '--case', 'C1', '--level', '2', '--now', '3']);
  run(['close', '--state', state, '--case', 'C1', '--decision', 'uphold', '--now', '4']);
  return { dir, state };
}

test('snapshot restores after crash and certificate recomputes identically', (t) => {
  const { dir, state } = buildHistory(t);
  const snapFile = path.join(dir, 'snap.json');
  const snap = run(['snapshot', '--state', state, '--out', snapFile]);
  assert.equal(snap.code, 0);
  const saved = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  assert.equal(saved.certificate, snap.body.certificate);
  // Crash: the live state file is lost; only the snapshot survives.
  fs.rmSync(state);
  const recovered = path.join(dir, 'recovered.json');
  fs.writeFileSync(recovered, JSON.stringify(saved.state, null, 2));
  const verify = run(['snapshot', '--state', recovered, '--verify']);
  assert.equal(verify.code, 0);
  assert.equal(verify.body.verified, true);
  assert.equal(verify.body.recomputed, snap.body.certificate);
  // Library-level recomputation from the raw event log agrees.
  const fromEvents = core.recomputeCertificate(saved.state.events);
  assert.equal(fromEvents, snap.body.certificate);
  // Recovery is transparent: new events continue the same hash chain.
  const cont = run(['open', '--state', recovered, '--case', 'C3', '--dept', 'heme', '--risk', '40', '--deadline', '9', '--skill', 'mol', '--now', '5']);
  assert.equal(cont.code, 0);
  const verify2 = run(['snapshot', '--state', recovered, '--verify']);
  assert.equal(verify2.body.verified, true);
});

test('tampered event log fails verification', (t) => {
  const { dir, state } = buildHistory(t);
  const snapFile = path.join(dir, 'snap.json');
  run(['snapshot', '--state', state, '--out', snapFile]);
  const saved = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  saved.state.events.find((e) => e.type === 'risk_correct').data.to = 1;
  const tampered = path.join(dir, 'tampered.json');
  fs.writeFileSync(tampered, JSON.stringify(saved.state));
  const verify = run(['snapshot', '--state', tampered, '--verify']);
  assert.equal(verify.body.verified, false);
});
