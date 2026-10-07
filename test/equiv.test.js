'use strict';

// Acceptance 2: semantically equal but syntactically different regexes yield
// UNSAT for both, or SAT with the same shortest witness length.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../lib/engine');

function check(engine, pattern, extra = {}) {
  const [line] = engine.exec({ op: 'check', pattern, ...extra });
  return line.replace(/^adhoc /, '');
}

test('equal SAT regexes give the same shortest length', () => {
  const pairs = [
    ['aa*', 'a*a'],
    ['a(ba)*', '(ab)*a'],
    ['(a|b)*abb', '(a|b)*a(bb|bb(b|a)*)'.replace('(b|a)*', '(a|b)*')],
    ['(a|b)(a|b)', '(aa|ab|ba|bb)'],
    ['a+', 'aa*'],
    ['(a|b)*a(a|b)(a|b)', '(a|b)*a((aa|ab)|(ba|bb))'],
  ];
  for (const [p1, p2] of pairs) {
    const engine = new Engine();
    const r1 = check(engine, p1, { alphabet: ['a', 'b'] });
    const r2 = check(engine, p2, { alphabet: ['a', 'b'] });
    assert.match(r1, /^SAT/);
    assert.match(r2, /^SAT/);
    const len1 = JSON.parse(r1.slice(3)).len;
    const len2 = JSON.parse(r2.slice(3)).len;
    assert.equal(len1, len2, `${p1} vs ${p2}`);
  }
});

test('equal UNSAT regexes give UNSAT with identical certificates', () => {
  const engine = new Engine();
  // Both filters denote the empty language over {a,b}.
  const r1 = check(engine, '(a|b)*', { filter: '~((a|b)*)', alphabet: ['a', 'b'] });
  const r2 = check(engine, '(a|b)*', { filter: '~(EPS|(a|b)(a|b)*)', alphabet: ['a', 'b'] });
  assert.match(r1, /^UNSAT/);
  assert.match(r2, /^UNSAT/);
  assert.equal(r1, r2);
  const cert = JSON.parse(r1.slice(5));
  assert.match(cert.certHash, /^[0-9a-f]{64}$/);
  assert.ok(cert.states >= 1);
});

test('session filter participates in the intersection', () => {
  const engine = new Engine();
  engine.exec({ op: 'setFilter', regex: 'b(a|b)*', alphabet: ['a', 'b'] });
  const r = check(engine, 'a(a|b)*');
  assert.match(r, /^UNSAT/);
  engine.exec({ op: 'setFilter' });
  const r2 = check(engine, 'a(a|b)*');
  assert.match(r2, /^SAT/);
});
