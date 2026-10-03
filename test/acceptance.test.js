'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse, matches } = require('../lib/regex');
const A = require('../lib/automata');
const { Engine, AuditError } = require('../lib/audit');
const { PackStore } = require('../lib/packstore');

const ALPHABET = ['a', 'b'];

function* allStrings(alphabet, maxLen) {
  yield '';
  const queue = [''];
  while (queue.length > 0) {
    const s = queue.shift();
    if (s.length === maxLen) continue;
    for (const c of alphabet) {
      queue.push(s + c);
      yield s + c;
    }
  }
}

function comboDfa(src) {
  return A.determinize(A.toNFA(parse(src), ALPHABET), ALPHABET);
}

// Acceptance 1: intersection/complement combinations agree with full
// enumeration of all strings up to length 7 (independent oracle matcher).
test('inter/compl combos consistent with enumeration <= 7', () => {
  const combos = [
    '(a|b)*abb',
    '~((a|b)*bb(a|b)*)',
    '(a|b)*abb & ~((a|b)*bb(a|b)*)',
    '(a|b)*abb & (a|b)*bb(a|b)*',
    '(a(a|b)*a | b(a|b)*b) & ~((a|b)*bb(a|b)*)',
    '~((a|b)*abb) & ~((a|b)*bab)',
    '((a|b)*abb | a(a|b)*a) & ~((a|b)*bb(a|b)*)',
    'a* & ~(a*)',                 // empty
    '(a|b)* & ~((a|b)*)',         // empty
    '~0 & (a|b)(a|b)(a|b)',       // Sigma^3
    '~~(ab(a|b)*) & ~(ba(a|b)*)', // double complement
  ];

  for (const src of combos) {
    const ast = parse(src);
    const dfa = comboDfa(src);
    const witness = A.shortestWitness(dfa);

    // Collect oracle results by enumeration.
    const accepted = [];
    for (const s of allStrings(ALPHABET, 7)) {
      if (matches(ast, s)) accepted.push(s);
    }

    if (witness === null) {
      assert.equal(
        accepted.length, 0,
        `${src}: DFA says UNSAT but enumeration found ${JSON.stringify(accepted[0])}`,
      );
      const min = A.minimize(dfa);
      assert.equal(min.accepts.size, 0, `${src}: certificate must have zero accepting states`);
    } else {
      assert.ok(matches(ast, witness), `${src}: witness ${JSON.stringify(witness)} must match`);
      const shortest = accepted.length ? accepted[0].length : Infinity;
      assert.equal(
        witness.length, shortest,
        `${src}: witness length ${witness.length} != enumerated shortest ${shortest}`,
      );
    }
  }
});

// Acceptance 2: different regexes with the same semantics give UNSAT
// (identical certificate) or the same shortest witness length.
test('equivalent regexes give UNSAT or same shortest length', () => {
  const pairs = [
    ['(a|b)*abb(a|b)*', '~(~((a|b)*abb(a|b)*))'],
    ['a(a|b)*', 'a(~0)'],
    ['a*b*', '~(~(a*b*))'],
    ['(a|b)* & ~(b(a|b)*ab)', '~(b(a|b)*ab)'],
  ];
  const dangers = ['(a|b)*ab(a|b)*', 'b(a|b)*', 'a*bb*'];

  for (const [r1, r2] of pairs) {
    for (const danger of dangers) {
      const run = (filterSrc) => {
        const d1 = A.determinize(A.toNFA(parse(danger), ALPHABET), ALPHABET);
        const d2 = A.determinize(A.toNFA(parse(filterSrc), ALPHABET), ALPHABET);
        const prod = A.productDFA(d1, d2, 'inter');
        const w = A.shortestWitness(prod);
        if (w !== null) return { sat: true, len: w.length };
        const min = A.minimize(prod);
        return { sat: false, certHash: A.certHash(min) };
      };
      const res1 = run(r1);
      const res2 = run(r2);
      assert.equal(res1.sat, res2.sat, `${r1} vs ${r2} (danger ${danger})`);
      if (res1.sat) {
        assert.equal(res1.len, res2.len, `${r1} vs ${r2}: shortest length`);
      } else {
        assert.equal(res1.certHash, res2.certHash, `${r1} vs ${r2}: UNSAT certificate`);
      }
    }
  }
});

// Acceptance 3: truncating the last half-written record and restarting
// recovers the previous complete pack state.
test('torn tail truncated on restart, previous complete pack recovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packstore-'));
  const storePath = path.join(dir, 'packs.log');

  const s1 = new PackStore(storePath);
  s1.loadPack({ name: 'plc', version: 1, alphabet: ['a', 'b'], danger: 'a*b' });
  s1.loadPack({ name: 'plc', version: 2, alphabet: ['a', 'b'], danger: '(a|b)*a' });
  const goodSize = fs.statSync(storePath).size;

  // Simulate a crash mid-append: half of a third record.
  const half = JSON.stringify({ crc: 'deadbeef', data: { type: 'loadPack', name: 'plc', version: 3 } });
  fs.appendFileSync(storePath, half.slice(0, half.length / 2));

  const s2 = new PackStore(storePath);
  const current = s2.currentPack('plc');
  assert.equal(current.version, 2, 'must recover the last complete pack version');
  assert.equal(current.danger, '(a|b)*a');
  assert.equal(fs.statSync(storePath).size, goodSize, 'bad tail must be truncated');

  // Store keeps working after recovery.
  s2.loadPack({ name: 'plc', version: 3, alphabet: ['a', 'b'], danger: 'b*' });
  const s3 = new PackStore(storePath);
  assert.equal(s3.currentPack('plc').version, 3);
});

// Acceptance 4: rollback to a nonexistent version errors and state is unchanged.
test('rollback to nonexistent version fails, state unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packstore-'));
  const storePath = path.join(dir, 'packs.log');

  const engine = new Engine(storePath);
  engine.run({ cmd: 'loadPack', name: 'plc', version: 1, alphabet: ['a', 'b'], danger: 'a*b' });
  engine.run({ cmd: 'loadPack', name: 'plc', version: 2, alphabet: ['a', 'b'], danger: '(a|b)*a' });

  assert.throws(
    () => engine.run({ cmd: 'rollback', name: 'plc', version: 99 }),
    (err) => err instanceof AuditError && err.code === 'UNKNOWN_VERSION' && err.exitCode === 5,
  );
  assert.throws(
    () => engine.run({ cmd: 'rollback', name: 'ghost', version: 1 }),
    (err) => err instanceof AuditError && err.code === 'UNKNOWN_PACK' && err.exitCode === 5,
  );

  const current = engine.store.currentPack('plc');
  assert.equal(current.version, 2, 'current version must be unchanged');
  assert.equal(current.danger, '(a|b)*a');

  // A valid rollback still works afterwards.
  engine.run({ cmd: 'rollback', name: 'plc', version: 1 });
  assert.equal(engine.store.currentPack('plc').version, 1);
});

// Complement without an explicit alphabet is rejected with exit code 5.
test('complement without alphabet rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packstore-'));
  const engine = new Engine(path.join(dir, 'packs.log'));
  engine.run({ cmd: 'loadPack', name: 'p', version: 1, danger: 'a*' });
  engine.run({ cmd: 'setFilter', regex: '~(a)' });
  assert.throws(
    () => engine.run({ cmd: 'check' }),
    (err) => err.code === 'COMPLEMENT_NO_ALPHABET' && err.exitCode === 5,
  );
});

// Engine end-to-end: SAT gives the shortest witness, UNSAT gives a
// certificate with zero accepting states.
test('engine check SAT/UNSAT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packstore-'));
  const engine = new Engine(path.join(dir, 'packs.log'));
  engine.run({ cmd: 'loadPack', name: 'plc', version: 1, alphabet: ['a', 'b'], danger: '(a|b)*abb' });
  engine.run({ cmd: 'setFilter', regex: '~((a|b)*aa(a|b)*)' });
  const sat = engine.run({ cmd: 'check' });
  assert.equal(sat.result, 'SAT');
  assert.equal(sat.witness, 'abb');
  assert.equal(sat.len, 3);

  engine.run({ cmd: 'setFilter', regex: '(a|b)* & ~((a|b)*abb)' });
  const unsat = engine.run({ cmd: 'check' });
  assert.equal(unsat.result, 'UNSAT');
  assert.equal(unsat.acceptCount, 0);
  assert.equal(typeof unsat.certHash, 'string');
  assert.ok(unsat.states >= 1);
});

// Projection filter: symbols outside the kept set are erased from the
// danger pattern before intersecting with the filter.
test('projection filter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packstore-'));
  const engine = new Engine(path.join(dir, 'packs.log'));
  engine.run({ cmd: 'loadPack', name: 'plc', version: 1, alphabet: ['a', 'b'], danger: 'ab' });
  // Project away 'b': danger "ab" becomes "a", which the filter matches.
  engine.run({ cmd: 'setFilter', regex: 'a', project: ['a'] });
  const sat = engine.run({ cmd: 'check' });
  assert.equal(sat.result, 'SAT');
  assert.equal(sat.witness, 'a');
  // Without projection the filter "a" cannot match "ab".
  engine.run({ cmd: 'setFilter', regex: 'a' });
  const unsat = engine.run({ cmd: 'check' });
  assert.equal(unsat.result, 'UNSAT');
});
