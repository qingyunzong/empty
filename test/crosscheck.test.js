'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { search, enumerateMinimalCounterexamples, canonicalAction } = require('../lib');
const { loadSpec, independentAnalyze } = require('../testlib/helpers');

const SPECS = [
  'self-approval.json',
  'self-approval-deny.json',
  'self-approval-revoke.json',
  'self-approval-revoked.json',
];

for (const name of SPECS) {
  test(`acceptance 4: independent enumerator agrees on ${name}`, () => {
    const spec = loadSpec(name);
    const independent = independentAnalyze(spec);
    const result = search(spec);
    if (independent.status === 'proof') {
      assert.equal(result.result, 'proof');
      assert.deepEqual(enumerateMinimalCounterexamples(spec), []);
      return;
    }
    assert.equal(result.result, 'counterexample');
    assert.equal(result.length, independent.length);
    assert.deepEqual(result.canonical, independent.counterexamples[0]);
    const libraryAll = enumerateMinimalCounterexamples(spec)
      .map((seq) => seq.map(canonicalAction))
      .sort();
    const independentAll = [...independent.counterexamples].sort();
    assert.deepEqual(libraryAll, independentAll);
  });
}
