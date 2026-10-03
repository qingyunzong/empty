'use strict';

// Acceptance 2: overlapping local times resolve reproducibly under
// strict / earlier / later, and every non-unique resolution is recorded
// in the evidence trail. Nonexistent (gap) times behave analogously.

const test = require('node:test');
const assert = require('node:assert/strict');
const { localToUtc, ReconError } = require('../src/index');
const { formatUtc } = require('../src/time');
const { ZONE, tableDst, registryWith } = require('../testlib/helpers');

const reg = registryWith({ txn: [tableDst] });
const table = reg.get('txn', 'dst1');
const OVERLAP_LOCAL = '2024-10-27T02:30:00'; // happens twice
const GAP_LOCAL = '2024-03-31T02:30:00';     // never happens

test('ambiguous local time: strict raises E_AMBIG', () => {
  assert.throws(() => localToUtc(table, ZONE, OVERLAP_LOCAL, 'strict'),
    (e) => e instanceof ReconError && e.code === 'E_AMBIG');
});

test('ambiguous local time: earlier/later are deterministic and reproducible', () => {
  const run = (policy) => {
    const evidence = [];
    const r = localToUtc(table, ZONE, OVERLAP_LOCAL, policy, evidence);
    return { utc: formatUtc(r.utcMs), resolution: r.resolution, evidence };
  };
  const earlier1 = run('earlier');
  const earlier2 = run('earlier');
  const later1 = run('later');
  const later2 = run('later');

  assert.equal(earlier1.utc, '2024-10-27T00:30:00Z'); // first occurrence (offset +2)
  assert.equal(later1.utc, '2024-10-27T01:30:00Z');   // second occurrence (offset +1)

  // reproducible: identical inputs -> identical outputs and evidence
  assert.deepEqual(earlier1, earlier2);
  assert.deepEqual(later1, later2);

  // evidence records the ambiguity, the policy and the resolution
  assert.equal(earlier1.evidence.length, 1);
  assert.equal(earlier1.evidence[0].type, 'ambiguous-local');
  assert.equal(earlier1.evidence[0].policy, 'earlier');
  assert.deepEqual(earlier1.evidence[0].candidatesUtc,
    ['2024-10-27T00:30:00Z', '2024-10-27T01:30:00Z']);
  assert.equal(earlier1.evidence[0].resolvedUtc, '2024-10-27T00:30:00Z');
  assert.equal(later1.evidence[0].resolvedUtc, '2024-10-27T01:30:00Z');
});

test('nonexistent local time: strict raises E_AMBIG, earlier/later clamp to gap edges', () => {
  assert.throws(() => localToUtc(table, ZONE, GAP_LOCAL, 'strict'), (e) => e.code === 'E_AMBIG');

  const ev = [];
  const earlier = localToUtc(table, ZONE, GAP_LOCAL, 'earlier', ev);
  const later = localToUtc(table, ZONE, GAP_LOCAL, 'later', ev);

  assert.equal(formatUtc(earlier.utcMs), '2024-03-31T00:59:59.999Z'); // last valid before gap
  assert.equal(formatUtc(later.utcMs), '2024-03-31T01:00:00Z');       // first valid after gap
  assert.equal(ev[0].type, 'nonexistent-local');
  assert.deepEqual(ev[0].gap, {
    lastValidUtc: '2024-03-31T00:59:59.999Z',
    firstValidUtc: '2024-03-31T01:00:00Z',
  });
});

test('unknown policy raises E_POLICY', () => {
  assert.throws(() => localToUtc(table, ZONE, OVERLAP_LOCAL, 'middle'),
    (e) => e.code === 'E_POLICY');
});

test('unique local time resolves without evidence under any policy', () => {
  for (const policy of ['strict', 'earlier', 'later']) {
    const evidence = [];
    const r = localToUtc(table, ZONE, '2024-06-15T12:00:00', policy, evidence);
    assert.equal(r.resolution, 'unique');
    assert.equal(formatUtc(r.utcMs), '2024-06-15T10:00:00Z'); // offset +2 in summer
    assert.equal(evidence.length, 0);
  }
});
