'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpec, SpecError } = require('../spec');
const { baseSpec } = require('../helpers/fixtures');

function expectParseError(raw, pattern) {
  assert.throws(
    () => parseSpec(raw),
    (err) => err instanceof SpecError && err.code === 'E_PARSE' && pattern.test(err.message)
  );
}

test('accepts a well-formed spec and applies defaults', () => {
  const spec = parseSpec(baseSpec());
  assert.deepEqual(spec.amounts, [0, 1, 50, 100, 101]);
  assert.equal(spec.maxLength, 6);
  assert.deepEqual(spec.actions, ['approve', 'submit']);
  assert.deepEqual(spec.subjects, ['alice', 'bob', 'carol', 'dave']);
  assert.deepEqual(spec.invariant, { role: 'clerk', first: 'submit', second: 'approve' });
});

test('rejects non-object specs', () => {
  expectParseError(null, /object/);
  expectParseError([1, 2], /object/);
  expectParseError('spec', /object/);
});

test('rejects a missing or non-numeric threshold', () => {
  const raw = baseSpec();
  delete raw.threshold;
  expectParseError(raw, /threshold/);
  expectParseError({ ...baseSpec(), threshold: '100' }, /threshold/);
});

test('rejects amounts outside the fixed domain', () => {
  expectParseError({ ...baseSpec(), amounts: [0, 7] }, /domain/);
  expectParseError({ ...baseSpec(), amounts: [] }, /non-empty/);
});

test('rejects more than 4 subjects', () => {
  const raw = { ...baseSpec(), subjects: ['a', 'b', 'c', 'd', 'e'] };
  expectParseError(raw, /at most 4/);
});

test('rejects maxLength outside 1..6', () => {
  expectParseError({ ...baseSpec(), maxLength: 7 }, /maxLength/);
  expectParseError({ ...baseSpec(), maxLength: 0 }, /maxLength/);
});

test('rejects unknown roles, role cycles and bad rules', () => {
  expectParseError({ ...baseSpec(), roles: { clerk: ['ghost'] } }, /unknown role/);
  expectParseError({ ...baseSpec(), roles: { a: ['b'], b: ['a'] } }, /cycle/);
  expectParseError(
    { ...baseSpec(), rules: [{ effect: 'maybe', role: 'clerk', action: 'submit' }] },
    /effect/
  );
  expectParseError(
    { ...baseSpec(), rules: [{ effect: 'allow', role: 'ghost', action: 'submit' }] },
    /role/
  );
  expectParseError(
    { ...baseSpec(), rules: [{ effect: 'allow', role: 'clerk', action: 'fly' }] },
    /action/
  );
});

test('rejects duplicate rule ids and unknown revocations', () => {
  const raw = baseSpec();
  raw.rules.push({ id: 'allow-submit', effect: 'deny', role: 'clerk', action: 'submit' });
  expectParseError(raw, /unique/);
  expectParseError(
    { ...baseSpec(), revocations: [{ rule: 'nope', at: 1 }] },
    /unknown rule/
  );
  expectParseError(
    { ...baseSpec(), revocations: [{ rule: 'allow-submit', at: -1 }] },
    /non-negative/
  );
});

test('rejects unknown invariant role', () => {
  expectParseError({ ...baseSpec(), invariant: { role: 'ghost' } }, /invariant/);
});
