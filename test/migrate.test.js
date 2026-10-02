'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyPatch } = require('../src/migrate');
const { verifyProof } = require('../src/verify');
const { MigrateError } = require('../src/model');
const { run } = require('../cli.js');

function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to throw');
}

function sampleOld() {
  return [
    { id: 'i1', account: 'A', currency: 'USD', debit: 100, credit: 40, freeze: 10, state: 'PENDING', memo: 'leg-1' },
    { id: 'i2', account: 'A', currency: 'USD', debit: 50, credit: 0, freeze: 5, state: 'PENDING' },
    { id: 'i3', account: 'A', currency: 'USD', debit: 25, credit: 5, freeze: 0, state: 'PENDING' },
    { id: 'i4', account: 'B', currency: 'EUR', debit: 200, credit: 200, freeze: 0, state: 'SETTLED', memo: 'done' },
  ];
}

function comboPatch() {
  return [
    { op: 'split', id: 'i1', parts: [
      { id: 'i1a', debit: 60, credit: 40, freeze: 4 },
      { id: 'i1b', debit: 40, credit: 0, freeze: 6, memo: 'leg-1b' },
    ] },
    { op: 'merge', ids: ['i2', 'i3'], newId: 'm1', memo: 'merged' },
    { op: 'restate', id: 'i4', fields: { memo: 'done (restated)' } },
    { op: 'restate', id: 'm1', fields: { debit: 80, freeze: 9 } },
  ];
}

test('split/merge/restate combo produces expected table and a self-consistent proof', () => {
  const { instructions, proof } = applyPatch(sampleOld(), comboPatch());
  const byId = new Map(instructions.map((inst) => [inst.id, inst]));

  assert.deepEqual(byId.get('i1a'), { id: 'i1a', account: 'A', currency: 'USD', debit: 60, credit: 40, freeze: 4, state: 'PENDING', memo: 'leg-1' });
  assert.deepEqual(byId.get('i1b'), { id: 'i1b', account: 'A', currency: 'USD', debit: 40, credit: 0, freeze: 6, state: 'PENDING', memo: 'leg-1b' });
  assert.deepEqual(byId.get('m1'), { id: 'm1', account: 'A', currency: 'USD', debit: 80, credit: 5, freeze: 9, state: 'PENDING', memo: 'merged' });
  assert.deepEqual(byId.get('i4'), { id: 'i4', account: 'B', currency: 'EUR', debit: 200, credit: 200, freeze: 0, state: 'SETTLED', memo: 'done (restated)' });
  assert.equal(instructions.length, 4);

  // restate on m1 moved net by +5 and freeze by +4 on account A; everything else conserves.
  assert.deepEqual(proof.perAccountDelta, { A: { net: 5, freeze: 4 } });
  assert.equal(proof.conservation.length, 2);
  assert.ok(proof.conservation.every((entry) => entry.ok));
  assert.deepEqual(proof.forbiddenOps, []);

  const verdict = verifyProof(sampleOld(), instructions, proof);
  assert.deepEqual(verdict, { ok: true });
});

test('split conservation failure exits 25 and names the account', () => {
  const err = catchError(() =>
    applyPatch(sampleOld(), [{ op: 'split', id: 'i1', parts: [{ id: 'x', debit: 100, credit: 0, freeze: 10 }] }])
  );
  assert.ok(err instanceof MigrateError);
  assert.equal(err.exitCode, 25);
  assert.match(err.message, /account A/);
  assert.match(err.message, /net delta 40/);
});

test('split conservation failure on freeze is detected per account', () => {
  const err = catchError(() =>
    applyPatch(sampleOld(), [
      { op: 'split', id: 'i1', parts: [
        { id: 'x', debit: 100, credit: 40, freeze: 3 },
        { id: 'y', debit: 0, credit: 0, freeze: 3 },
      ] },
    ])
  );
  assert.equal(err.exitCode, 25);
  assert.match(err.message, /account A/);
  assert.match(err.message, /freeze delta -4/);
});

test('restate on SETTLED amounts exits 26; memo-only restate is allowed', () => {
  const err = catchError(() => applyPatch(sampleOld(), [{ op: 'restate', id: 'i4', fields: { debit: 199 } }]));
  assert.equal(err.exitCode, 26);
  assert.match(err.message, /SETTLED/);

  const ok = applyPatch(sampleOld(), [{ op: 'restate', id: 'i4', fields: { memo: 'annotated', debit: 200 } }]);
  assert.equal(ok.instructions.find((i) => i.id === 'i4').memo, 'annotated');
});

test('merge across accounts exits 27', () => {
  const old = sampleOld();
  old[3].state = 'PENDING';
  const err = catchError(() => applyPatch(old, [{ op: 'merge', ids: ['i2', 'i4'], newId: 'm9' }]));
  assert.equal(err.exitCode, 27);
  assert.match(err.message, /accounts A and B/);
});

test('merge across currencies exits 27', () => {
  const old = sampleOld();
  old[3].account = 'A';
  old[3].state = 'PENDING';
  const err = catchError(() => applyPatch(old, [{ op: 'merge', ids: ['i2', 'i4'], newId: 'm9' }]));
  assert.equal(err.exitCode, 27);
  assert.match(err.message, /currencies USD and EUR/);
});

function runCli(args) {
  const out = [];
  const err = [];
  const status = run(args, { stdout: (line) => out.push(line), stderr: (line) => err.push(line) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-migrate-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI migrate then verify roundtrip exits 0', () => {
  withTempDir((dir) => {
    const oldPath = path.join(dir, 'old.json');
    const patchPath = path.join(dir, 'patch.json');
    const newPath = path.join(dir, 'new.json');
    const proofPath = path.join(dir, 'proof.json');
    fs.writeFileSync(oldPath, JSON.stringify(sampleOld()));
    fs.writeFileSync(patchPath, JSON.stringify({ ops: comboPatch() }));

    const migrated = runCli(['migrate', oldPath, patchPath, '--out', newPath, '--proof', proofPath]);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.ok(fs.existsSync(newPath));
    assert.ok(fs.existsSync(proofPath));

    const verified = runCli(['verify', oldPath, newPath, proofPath]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /OK/);
  });
});

test('CLI maps rule violations to exit codes 25/26/27', () => {
  withTempDir((dir) => {
    const oldPath = path.join(dir, 'old.json');
    const patchPath = path.join(dir, 'patch.json');
    fs.writeFileSync(oldPath, JSON.stringify(sampleOld()));

    const cases = [
      { patch: [{ op: 'split', id: 'i1', parts: [{ id: 'x', debit: 1, credit: 0, freeze: 0 }] }], code: 25 },
      { patch: [{ op: 'restate', id: 'i4', fields: { freeze: 1 } }], code: 26 },
      { patch: [{ op: 'merge', ids: ['i2', 'i4'], newId: 'm9' }], code: 27 },
    ];
    for (const [i, { patch, code }] of cases.entries()) {
      fs.writeFileSync(patchPath, JSON.stringify(patch));
      const res = runCli(['migrate', oldPath, patchPath, '--out', path.join(dir, `n${i}.json`), '--proof', path.join(dir, `p${i}.json`)]);
      assert.equal(res.status, code, `case ${i}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`error\\[exit${code}\\]`));
    }
  });
});
