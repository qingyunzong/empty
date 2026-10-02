'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli.js');

function run(args) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let status;
  try {
    status = main(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { status, stdout: out.join(''), stderr: err.join('') };
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cli-'));
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const OLD = [
  { id: 'a', account: 'alice', debit: 10, credit: 4, freeze: 2, state: 'PENDING', currency: 'USD' },
  { id: 'b', account: 'alice', debit: 3, credit: 1, freeze: 0, state: 'PENDING', currency: 'USD' },
  { id: 'c', account: 'bob', debit: 7, credit: 7, freeze: 5, state: 'SETTLED', currency: 'USD' },
];

const PATCH = {
  ops: [
    { op: 'split', id: 'a', parts: [
      { id: 'a1', debit: 6, credit: 4, freeze: 2 },
      { id: 'a2', debit: 4, credit: 0, freeze: 0 },
    ] },
    { op: 'merge', ids: ['a1', 'b'], newId: 'ab' },
    { op: 'restate', id: 'c', fields: { memo: 'reg-filing-7' } },
  ],
};

test('CLI migrate then verify round-trip exits 0', () => {
  const dir = workspace();
  const oldFile = writeJson(dir, 'old.json', OLD);
  const patchFile = writeJson(dir, 'patch.json', PATCH);
  const outFile = path.join(dir, 'new.json');
  const proofFile = path.join(dir, 'proof.json');

  const mig = run(['migrate', oldFile, patchFile, '--out', outFile, '--proof', proofFile]);
  assert.equal(mig.status, 0, mig.stderr);
  assert.match(mig.stdout, /migrated: 3 -> 3 instructions \(3 ops\)/);
  assert.ok(fs.existsSync(outFile));
  assert.ok(fs.existsSync(proofFile));

  const ver = run(['verify', oldFile, outFile, proofFile]);
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /OK: all invariants hold/);
});

test('CLI migrate conservation failure exits 25 and names the account', () => {
  const dir = workspace();
  const oldFile = writeJson(dir, 'old.json', OLD);
  const patchFile = writeJson(dir, 'patch.json', [
    { op: 'split', id: 'a', parts: [
      { id: 'a1', debit: 6, credit: 4, freeze: 2 },
      { id: 'a2', debit: 99, credit: 0, freeze: 0 },
    ] },
  ]);
  const res = run(['migrate', oldFile, patchFile, '--out', path.join(dir, 'n.json'), '--proof', path.join(dir, 'p.json')]);
  assert.equal(res.status, 25);
  assert.match(res.stderr, /account=alice/);
  assert.equal(fs.existsSync(path.join(dir, 'n.json')), false);
});

test('CLI migrate SETTLED amount change exits 26', () => {
  const dir = workspace();
  const oldFile = writeJson(dir, 'old.json', OLD);
  const patchFile = writeJson(dir, 'patch.json', [{ op: 'restate', id: 'c', fields: { debit: 8 } }]);
  const res = run(['migrate', oldFile, patchFile]);
  assert.equal(res.status, 26);
  assert.match(res.stderr, /SETTLED/);
});

test('CLI migrate cross-account merge exits 27', () => {
  const dir = workspace();
  const oldFile = writeJson(dir, 'old.json', OLD);
  const patchFile = writeJson(dir, 'patch.json', [{ op: 'merge', ids: ['a', 'c'], newId: 'ac' }]);
  const res = run(['migrate', oldFile, patchFile]);
  assert.equal(res.status, 27);
  assert.match(res.stderr, /merge across accounts/);
});

test('CLI verify rejects forged proof with first failing invariant', () => {
  const dir = workspace();
  const oldFile = writeJson(dir, 'old.json', OLD);
  const patchFile = writeJson(dir, 'patch.json', PATCH);
  const outFile = path.join(dir, 'new.json');
  const proofFile = path.join(dir, 'proof.json');
  assert.equal(run(['migrate', oldFile, patchFile, '--out', outFile, '--proof', proofFile]).status, 0);

  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  proof.perAccountDelta.alice = { net: 1, freeze: 0 };
  writeJson(dir, 'proof.json', proof);

  const res = run(['verify', oldFile, outFile, proofFile]);
  assert.equal(res.status, 25);
  assert.match(res.stderr, /FAIL invariant=conservation/);
  assert.match(res.stderr, /account=alice/);
});

test('CLI verify detects tampered SETTLED amounts with exit 26', () => {
  const dir = workspace();
  const oldFile = writeJson(dir, 'old.json', OLD);
  const patchFile = writeJson(dir, 'patch.json', PATCH);
  const outFile = path.join(dir, 'new.json');
  const proofFile = path.join(dir, 'proof.json');
  assert.equal(run(['migrate', oldFile, patchFile, '--out', outFile, '--proof', proofFile]).status, 0);

  const fresh = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const settled = fresh.find((i) => i.id === 'c');
  settled.debit += 1;
  settled.credit += 1;
  writeJson(dir, 'new.json', fresh);

  const res = run(['verify', oldFile, outFile, proofFile]);
  assert.equal(res.status, 26);
  assert.match(res.stderr, /FAIL invariant=settledProtection/);
});

test('CLI usage errors exit 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['migrate', 'only-one.json']).status, 2);
  assert.equal(run(['verify', 'a', 'b']).status, 2);
  const dir = workspace();
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(run(['migrate', bad, bad]).status, 2);
});
