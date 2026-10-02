'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyPatch } = require('../src/migrate');
const { verifyProof } = require('../src/verify');
const { run } = require('../cli.js');

function sampleOld() {
  return [
    { id: 'i1', account: 'A', currency: 'USD', debit: 100, credit: 40, freeze: 10, state: 'PENDING' },
    { id: 'i2', account: 'A', currency: 'USD', debit: 50, credit: 0, freeze: 5, state: 'PENDING' },
    { id: 'i3', account: 'B', currency: 'EUR', debit: 200, credit: 200, freeze: 0, state: 'SETTLED', memo: 'done' },
  ];
}

function samplePatch() {
  return [
    { op: 'split', id: 'i1', parts: [
      { id: 'i1a', debit: 60, credit: 40, freeze: 4 },
      { id: 'i1b', debit: 40, credit: 0, freeze: 6 },
    ] },
    { op: 'restate', id: 'i2', fields: { debit: 70 } },
  ];
}

function freshMigration() {
  const old = sampleOld();
  const { instructions, proof } = applyPatch(old, samplePatch());
  return { old, instructions, proof };
}

test('honest proof verifies', () => {
  const { old, instructions, proof } = freshMigration();
  assert.deepEqual(verifyProof(old, instructions, proof), { ok: true });
});

test('forged perAccountDelta is the first failure reported', () => {
  const { old, instructions, proof } = freshMigration();
  proof.perAccountDelta = {};
  const verdict = verifyProof(old, instructions, proof);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.invariant, 'perAccountDelta');
});

test('dropping an op from the proof breaks conservation lineage', () => {
  const { old, instructions, proof } = freshMigration();
  proof.ops = proof.ops.filter((op) => op.op !== 'split');
  proof.conservation = [];
  const verdict = verifyProof(old, instructions, proof);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.invariant, 'conservation');
});

test('tampered conservation section is detected', () => {
  const { old, instructions, proof } = freshMigration();
  proof.conservation[0].accounts = { A: { net: 1, freeze: 0 } };
  const verdict = verifyProof(old, instructions, proof);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.invariant, 'conservation');
});

test('non-empty forbiddenOps in proof is rejected', () => {
  const { old, instructions, proof } = freshMigration();
  proof.forbiddenOps = [{ op: 'restate', id: 'i3' }];
  const verdict = verifyProof(old, instructions, proof);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.invariant, 'forbiddenOps');
});

test('forged proof cannot hide a SETTLED amount change', () => {
  const { old, instructions, proof } = freshMigration();
  // Attacker modifies a SETTLED instruction in the new table and rebuilds a
  // plausible proof: a fake restate op plus a corrected perAccountDelta.
  const tampered = instructions.map((inst) => (inst.id === 'i3' ? { ...inst, debit: 250 } : inst));
  const forgedProof = {
    version: 1,
    ops: [
      ...proof.ops,
      {
        index: proof.ops.length,
        op: 'restate',
        id: 'i3',
        inputs: [old.find((inst) => inst.id === 'i3')],
        outputs: [tampered.find((inst) => inst.id === 'i3')],
        contributions: { B: { net: 50, freeze: 0 } },
      },
    ],
    perAccountDelta: { A: { net: 20, freeze: 0 }, B: { net: 50, freeze: 0 } },
    conservation: proof.conservation,
    forbiddenOps: [],
  };
  const verdict = verifyProof(old, tampered, forgedProof);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.invariant, 'forbiddenOps');
  assert.match(verdict.message, /i3/);
});

test('CLI verify reports the first failing invariant and exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-verify-'));
  try {
    const { old, instructions, proof } = freshMigration();
    const oldPath = path.join(dir, 'old.json');
    const newPath = path.join(dir, 'new.json');
    const proofPath = path.join(dir, 'proof.json');
    fs.writeFileSync(oldPath, JSON.stringify(old));
    fs.writeFileSync(newPath, JSON.stringify({ instructions }));
    proof.perAccountDelta = { A: { net: 999, freeze: 0 } };
    fs.writeFileSync(proofPath, JSON.stringify(proof));

    const err = [];
    const status = run(['verify', oldPath, newPath, proofPath], { stdout: () => {}, stderr: (line) => err.push(line) });
    assert.equal(status, 1);
    assert.match(err.join('\n'), /FAIL perAccountDelta/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
