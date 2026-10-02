'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'audit.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

function writeJsonl(dir, name, rows) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return p;
}

// NOTE: this sandbox drops stdio pipes of node grandchildren, so we go through
// /bin/sh and capture stdout/stderr/exit-code via files.
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-run-'));
  const outF = path.join(dir, 'stdout');
  const errF = path.join(dir, 'stderr');
  const codeF = path.join(dir, 'code');
  const cmd = [process.execPath, CLI, ...args].map(shq).join(' ');
  spawnSync('/bin/sh', ['-c', `${cmd} >${shq(outF)} 2>${shq(errF)}; printf %s $? >${shq(codeF)}`], {
    encoding: 'utf8',
  });
  return {
    code: Number(fs.readFileSync(codeF, 'utf8')),
    stdout: fs.readFileSync(outF, 'utf8'),
    stderr: fs.readFileSync(errF, 'utf8'),
  };
}

function build(dir, input, out, proof, extra = []) {
  return run(['build', '--in', input, '--out', path.join(dir, out), '--proof', path.join(dir, proof), ...extra]);
}

// ---------- Acceptance A: as-of differs before/after a correction ----------
test('A: as-of query before and after a correction differs', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, 'entries.jsonl', [
    { id: 'e1', account: 'a', amount: 100, category: 'food', valid: true },
    { id: 'e2', account: 'a', amount: 50, category: 'food' },
    { id: 'e3', account: 'b', amount: 20, category: 'travel' },
    { id: 'c1', account: 'a', amount: 150, category: 'food', corrects: 'e1' },
  ]);
  const before = build(dir, input, 'before.json', 'before.proof.json', ['--as-of', '3']);
  assert.equal(before.code, 0, before.stderr);
  const after = build(dir, input, 'after.json', 'after.proof.json');
  assert.equal(after.code, 0, after.stderr);

  const b = JSON.parse(fs.readFileSync(path.join(dir, 'before.json'), 'utf8'));
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'after.json'), 'utf8'));
  assert.deepEqual(b.categories.food, { sum: 150, count: 2 }); // e1 still active
  assert.deepEqual(a.categories.food, { sum: 200, count: 2 }); // e1 superseded by c1(150) + e2(50)
  assert.notEqual(b.rootHash, a.rootHash);

  // superseded row is excluded from aggregation but committed in the proof
  const proof = JSON.parse(fs.readFileSync(path.join(dir, 'after.proof.json'), 'utf8'));
  const e1 = proof.leaves.find((l) => l.id === 'e1');
  assert.equal(e1.status, 'superseded');
  assert.equal(e1.supersededBy, 'c1');
  assert.equal(proof.leaves.length, 4); // all rows, including superseded, are in the certificate
  assert.match(proof.expression, /group_by\[category; sum:=sum\(amount\); count:=count\(\*\)\]/);

  // both proofs verify independently
  assert.equal(run(['verify', path.join(dir, 'before.json'), path.join(dir, 'before.proof.json')]).code, 0);
  assert.equal(run(['verify', path.join(dir, 'after.json'), path.join(dir, 'after.proof.json')]).code, 0);
});

// ---------- Acceptance B: tampering with an unused row breaks verification ----------
test('B: modifying a superseded (unused) row fails verification with E_PROOF', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, 'entries.jsonl', [
    { id: 'e1', account: 'a', amount: 100, category: 'food' },
    { id: 'c1', account: 'a', amount: 150, category: 'food', corrects: 'e1' },
  ]);
  assert.equal(build(dir, input, 'out.json', 'proof.json').code, 0);
  const ok = run(['verify', path.join(dir, 'out.json'), path.join(dir, 'proof.json')]);
  assert.equal(ok.code, 0, ok.stderr);

  // tamper with the superseded row (it never enters the aggregate)
  const tampered = fs.readFileSync(input, 'utf8').replace('"amount":100', '"amount":101');
  fs.writeFileSync(input, tampered);
  const bad = run(['verify', path.join(dir, 'out.json'), path.join(dir, 'proof.json')]);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /E_PROOF/);
});

test('B2: tampering with the output file fails verification', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, 'entries.jsonl', [
    { id: 'e1', amount: 10, category: 'x' },
    { id: 'e2', amount: 5, category: 'x' },
  ]);
  assert.equal(build(dir, input, 'out.json', 'proof.json').code, 0);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  out.categories.x.sum = 999;
  fs.writeFileSync(path.join(dir, 'out.json'), JSON.stringify(out, null, 2) + '\n');
  const bad = run(['verify', path.join(dir, 'out.json'), path.join(dir, 'proof.json')]);
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /E_PROOF/);
});

// ---------- Acceptance C: incremental vs full rebuild on 1000 rows ----------
test('C: incremental correction recomputes only affected categories, matches full rebuild', () => {
  const dir = tmpdir();
  const rows = [];
  for (let i = 1; i <= 1000; i++) {
    rows.push({
      id: `r${i}`,
      account: `a${i % 50}`,
      amount: (i % 97) + 1,
      category: `c${i % 10}`,
      valid: i % 13 !== 0,
    });
  }
  const input = writeJsonl(dir, 'entries.jsonl', rows);
  assert.equal(build(dir, input, 'full1.json', 'proof1.json').code, 0);

  // append 10 corrections touching exactly 3 categories
  const corrections = [];
  const affected = new Set();
  for (let j = 0; j < 10; j++) {
    const target = rows[j * 100]; // r0, r100, ... r900
    const cat = `c${(j % 3) + 1}`; // c1, c2, c3
    corrections.push({ id: `x${j}`, account: 'fix', amount: 7, category: cat, corrects: target.id });
    affected.add(cat);
    if (target.valid) affected.add(target.category); // superseded target's category changes too
  }
  fs.appendFileSync(input, corrections.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const inc = build(dir, input, 'inc.json', 'proof2.json', [
    '--incremental',
    '--prev-proof',
    path.join(dir, 'proof1.json'),
  ]);
  assert.equal(inc.code, 0, inc.stderr);
  const full = build(dir, input, 'full2.json', 'proof3.json');
  assert.equal(full.code, 0, full.stderr);

  // incremental output is byte-identical to a full rebuild
  assert.equal(
    fs.readFileSync(path.join(dir, 'inc.json'), 'utf8'),
    fs.readFileSync(path.join(dir, 'full2.json'), 'utf8')
  );
  const p2 = JSON.parse(fs.readFileSync(path.join(dir, 'proof2.json'), 'utf8'));
  const p3 = JSON.parse(fs.readFileSync(path.join(dir, 'proof3.json'), 'utf8'));
  assert.equal(p2.rootHash, p3.rootHash);
  assert.deepEqual(p2.categories, p3.categories);

  // only affected categories were recomputed
  const incMeta = p2.meta.incremental;
  assert.equal(incMeta.fallback, false);
  assert.deepEqual(incMeta.affectedCategories, [...affected].sort());
  assert.ok(incMeta.affectedCategories.length <= 4);
  assert.equal(incMeta.reusedCategories.length, 10 - incMeta.affectedCategories.length);

  // the new proof verifies; the stale pre-correction proof is rejected
  assert.equal(run(['verify', path.join(dir, 'inc.json'), path.join(dir, 'proof2.json')]).code, 0);
  const stale = run(['verify', path.join(dir, 'full1.json'), path.join(dir, 'proof1.json')]);
  assert.equal(stale.code, 3);
  assert.match(stale.stderr, /E_PROOF/);
  assert.match(stale.stderr, /stale|inputHash/);
});

// ---------- Acceptance D: all-NULL / empty category edge cases ----------
test('D: all NULL/empty categories aggregate under "(null)"; empty input works', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, 'entries.jsonl', [
    { id: 'n1', account: 'a', amount: 10, category: null },
    { id: 'n2', account: 'b', amount: 20, category: '' },
    { id: 'n3', account: 'c', amount: 5 }, // missing category
    { id: 'n4', account: 'd', amount: 7, category: null, valid: false }, // invalid: excluded
  ]);
  assert.equal(build(dir, input, 'out.json', 'proof.json').code, 0);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  assert.deepEqual(Object.keys(out.categories), ['(null)']);
  assert.deepEqual(out.categories['(null)'], { sum: 35, count: 3 });
  assert.equal(run(['verify', path.join(dir, 'out.json'), path.join(dir, 'proof.json')]).code, 0);

  // empty input file
  const empty = writeJsonl(dir, 'empty.jsonl', []);
  assert.equal(build(dir, empty, 'eout.json', 'eproof.json').code, 0);
  const eout = JSON.parse(fs.readFileSync(path.join(dir, 'eout.json'), 'utf8'));
  assert.deepEqual(eout.categories, {});
  assert.equal(eout.asOf, 0);
  assert.equal(run(['verify', path.join(dir, 'eout.json'), path.join(dir, 'eproof.json')]).code, 0);
});

// ---------- Error handling ----------
test('E_FUTURE_CORRECTION: forward reference and unknown target exit non-zero', () => {
  const dir = tmpdir();
  const fwd = writeJsonl(dir, 'fwd.jsonl', [
    { id: 'c1', amount: 1, category: 'x', corrects: 'e1' }, // e1 not seen yet
    { id: 'e1', amount: 2, category: 'x' },
  ]);
  const r1 = run(['build', '--in', fwd, '--out', path.join(dir, 'o1.json'), '--proof', path.join(dir, 'p1.json')]);
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /E_FUTURE_CORRECTION/);

  const unknown = writeJsonl(dir, 'unknown.jsonl', [
    { id: 'e1', amount: 2, category: 'x' },
    { id: 'c1', amount: 1, category: 'x', corrects: 'nope' },
  ]);
  const r2 = run(['build', '--in', unknown, '--out', path.join(dir, 'o2.json'), '--proof', path.join(dir, 'p2.json')]);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /E_FUTURE_CORRECTION/);
});

test('invalid rows are excluded from aggregation but committed to the proof', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, 'entries.jsonl', [
    { id: 'e1', amount: 10, category: 'x', valid: true },
    { id: 'e2', amount: 99, category: 'x', valid: false },
    { id: 'bad', amount: 'oops', category: 'x' }, // non-numeric amount -> invalid
    { id: 'c1', amount: 1, category: 'x', corrects: 'e1', valid: false }, // invalid correction does NOT supersede
  ]);
  assert.equal(build(dir, input, 'out.json', 'proof.json').code, 0);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  assert.deepEqual(out.categories.x, { sum: 10, count: 1 }); // only e1
  const proof = JSON.parse(fs.readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  assert.equal(proof.leaves.length, 4);
  assert.equal(proof.leaves.find((l) => l.id === 'e2').status, 'invalid');
  assert.equal(proof.leaves.find((l) => l.id === 'bad').status, 'invalid');
  assert.equal(proof.leaves.find((l) => l.id === 'e1').status, 'active');
  assert.equal(run(['verify', path.join(dir, 'out.json'), path.join(dir, 'proof.json')]).code, 0);
});

test('duplicate ids are rejected', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, 'entries.jsonl', [
    { id: 'e1', amount: 1, category: 'x' },
    { id: 'e1', amount: 2, category: 'x' },
  ]);
  const r = run(['build', '--in', input, '--out', path.join(dir, 'o.json'), '--proof', path.join(dir, 'p.json')]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /E_DUPLICATE_ID/);
});

test('correction chains: only the final correction stays active', () => {
  const dir = tmpdir();
  const input = writeJsonl(dir, 'entries.jsonl', [
    { id: 'e1', amount: 100, category: 'x' },
    { id: 'c1', amount: 200, category: 'x', corrects: 'e1' },
    { id: 'c2', amount: 300, category: 'x', corrects: 'c1' },
  ]);
  assert.equal(build(dir, input, 'out.json', 'proof.json').code, 0);
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  assert.deepEqual(out.categories.x, { sum: 300, count: 1 });
  const proof = JSON.parse(fs.readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  assert.equal(proof.leaves.find((l) => l.id === 'e1').status, 'superseded');
  assert.equal(proof.leaves.find((l) => l.id === 'c1').status, 'superseded');
  assert.equal(proof.leaves.find((l) => l.id === 'c2').status, 'active');
  assert.equal(run(['verify', path.join(dir, 'out.json'), path.join(dir, 'proof.json')]).code, 0);
});
