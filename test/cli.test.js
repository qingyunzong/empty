'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../cli');

function fixture(dir) {
  const aRe = path.join(dir, 'a.re');
  const bRe = path.join(dir, 'b.re');
  const tx = path.join(dir, 'tx.jsonl');
  fs.writeFileSync(aRe, 'r = [a3***h0]|[a3***h1]\n');
  fs.writeFileSync(bRe, 'r = [a3****]\n');
  fs.writeFileSync(
    tx,
    [
      JSON.stringify({ id: 't1', account: 'a1', amount: 20, hour: 9, region: 'domestic', channel: 'pos', history: 'clean' }),
      JSON.stringify({ id: 't2', account: 'a1', amount: 50000, hour: 14, region: 'domestic', channel: 'atm', history: 'clean' }),
    ].join('\n') + '\n'
  );
  return { aRe, bRe, tx };
}

test('cli equiv prints equivalence and certificates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-cli-'));
  const { aRe, bRe } = fixture(dir);
  const out = main(['equiv', aRe, bRe]);
  assert.equal(out.equiv, true);
  assert.equal(out.witness, null);
  assert.equal(out.certA.hash, out.certB.hash);
  assert.equal(out.certA.states, out.certB.states);
});

test('cli run dry-run decides without writing state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-cli-'));
  const { bRe, tx } = fixture(dir);
  const stateDir = path.join(dir, 'state');
  const out = main(['run', bRe, tx, '--mode', 'dry-run', '--state', stateDir]);
  assert.equal(out.mode, 'dry-run');
  assert.deepEqual(out.decisions.map((d) => d.decision), ['APPROVE', 'REJECT']);
  assert.equal(fs.existsSync(path.join(stateDir, 'state.json')), false);
});

test('cli run apply then undo round-trips state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-cli-'));
  const { bRe, tx } = fixture(dir);
  const stateDir = path.join(dir, 'state');
  const applied = main(['run', bRe, tx, '--mode', 'apply', '--state', stateDir, '--batch', 'b1']);
  assert.equal(applied.mode, 'apply');
  const undone = main(['run', bRe, tx, '--mode', 'undo', '--state', stateDir]);
  assert.equal(undone.undone, 'b1');
});

test('cli surfaces error codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-cli-'));
  const { bRe, tx } = fixture(dir);
  const stateDir = path.join(dir, 'state');
  assert.throws(
    () => main(['run', bRe, tx, '--mode', 'undo', '--state', stateDir]),
    (err) => err.code === 'UNDO_EMPTY'
  );
});
