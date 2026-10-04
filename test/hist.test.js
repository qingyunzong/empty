'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, query, HistError, E_FORK, E_TIME } = require('../lib');

function hist(events) {
  return createHistory(events.map((e) => JSON.stringify(e)).join('\n'));
}

function decide(events, ts, seq, branch) {
  return query(hist(events), { ts, seq, branch });
}

// Acceptance 1: same ts, different seq boundary.
test('same-ts seq boundary: asOf includes exactly the events up to ts:seq', () => {
  const events = [
    { ts: 1, seq: 0, op: 'rule', id: 'R1', when: { key: 'marginRatio', op: 'lt', value: 1.3 } },
    { ts: 10, seq: 2, op: 'set', key: 'marginRatio', value: 1.5 },
    { ts: 10, seq: 3, op: 'set', key: 'marginRatio', value: 1.2 },
    { ts: 10, seq: 4, op: 'set', key: 'marginRatio', value: 1.6 },
  ];
  assert.equal(decide(events, 10, 1).frozen, false); // no set visible
  assert.equal(decide(events, 10, 2).frozen, false); // 1.5 visible
  const at3 = decide(events, 10, 3);
  assert.equal(at3.frozen, true);                    // 1.2 visible
  assert.equal(at3.rule, 'R1');
  assert.equal(decide(events, 10, 4).frozen, false); // 1.6 overrides
  assert.equal(decide(events, 9, 99).frozen, false); // whole ts=10 invisible
  assert.equal(decide(events, 11, 0).frozen, false); // later ts sees all
});

// Acceptance 2: revoke only affects evaluation after it.
test('revoke changes asOf before/after the revocation point', () => {
  const events = [
    { ts: 1, seq: 0, op: 'rule', id: 'R1', when: { key: 'marginRatio', op: 'lt', value: 1.3 } },
    { ts: 5, seq: 1, op: 'set', key: 'marginRatio', value: 1.2 },
    { ts: 10, seq: 6, op: 'revoke', id: 'R1' },
  ];
  const before = decide(events, 10, 5);
  assert.equal(before.frozen, true);
  assert.equal(before.rule, 'R1');
  const at = decide(events, 10, 6);
  assert.equal(at.frozen, false);
  assert.equal(at.rule, null);
  // minimal explanation for the negative decision is the revoke event
  assert.deepEqual(at.explain.map((e) => [e.op, e.id, e.ts, e.seq]), [['revoke', 'R1', 10, 6]]);
  assert.equal(decide(events, 11, 0).frozen, false);
  // a rule defined after the revoke is unaffected by it
  const events2 = [
    { ts: 1, seq: 0, op: 'revoke', id: 'R1' },
    { ts: 2, seq: 0, op: 'rule', id: 'R1', when: { key: 'x', op: 'gt', value: 3 } },
    { ts: 3, seq: 0, op: 'set', key: 'x', value: 5 },
  ];
  assert.equal(decide(events2, 3, 0).frozen, true);
});

// Rule inheritance through trading groups.
test('rules inherit down the trading-group chain', () => {
  const events = [
    { ts: 1, seq: 0, op: 'group', id: 'G0' },
    { ts: 1, seq: 1, op: 'group', id: 'G1', parent: 'G0' },
    { ts: 1, seq: 2, op: 'account', group: 'G1' },
    { ts: 2, seq: 0, op: 'rule', id: 'R1', group: 'G0', when: { key: 'exposure', op: 'gte', value: 100 } },
    { ts: 2, seq: 1, op: 'rule', id: 'R2', group: 'G2', when: { key: 'exposure', op: 'gte', value: 100 } },
    { ts: 3, seq: 0, op: 'set', key: 'exposure', value: 150 },
  ];
  const r = decide(events, 3, 0);
  assert.equal(r.frozen, true);
  assert.equal(r.rule, 'R1'); // inherited from parent group G0; R2's group G2 does not apply
  // minimal explanation: rule + fact + account + the chain link G1->G0
  const ops = r.explain.map((e) => e.op).sort();
  assert.deepEqual(ops, ['account', 'group', 'rule', 'set']);
});

// Acceptance 3: fork, one branch freezes, the other does not; merge is deny-first.
test('fork/merge: branch-local freeze, merge takes union with deny-first conflicts', () => {
  const events = [
    { ts: 1, seq: 1, op: 'rule', id: 'R1', when: { key: 'marginRatio', op: 'lt', value: 1.3 } },
    { ts: 5, seq: 1, op: 'fork', name: 'B' },
    { ts: 6, seq: 1, op: 'set', key: 'marginRatio', value: 1.5 },                 // main: safe
    { ts: 6, seq: 1, op: 'set', key: 'marginRatio', value: 1.2, branch: 'B' },    // B: breach
    { ts: 8, seq: 1, op: 'merge', name: 'B' },
  ];
  assert.equal(decide(events, 7, 0).frozen, false);          // main before merge
  assert.equal(decide(events, 7, 0, 'B').frozen, true);      // B sees its own breach
  const merged = decide(events, 8, 1);                       // union, conflict at 6:1
  assert.equal(merged.frozen, true);                         // deny-first picks 1.2
  assert.equal(merged.rule, 'R1');
  // the winning fact in the explanation is the denying value from branch B
  const fact = merged.explain.find((e) => e.op === 'set');
  assert.equal(fact.branch, 'B');
  assert.equal(fact.value, 1.2);
});

test('merge union is limited to events visible at the merge position', () => {
  const events = [
    { ts: 1, seq: 0, op: 'rule', id: 'R1', when: { key: 'x', op: 'eq', value: 1 } },
    { ts: 2, seq: 0, op: 'fork', name: 'B' },
    { ts: 3, seq: 0, op: 'set', key: 'x', value: 1, branch: 'B' },
    { ts: 4, seq: 0, op: 'merge', name: 'B' },
    { ts: 5, seq: 0, op: 'set', key: 'x', value: 0, branch: 'B' }, // after merge point
  ];
  assert.equal(decide(events, 4, 0).frozen, true);  // merged x=1
  assert.equal(decide(events, 9, 0).frozen, true);  // post-merge B event stays on B
  assert.equal(decide(events, 9, 0, 'B').frozen, false);
});

test('E_TIME: events must be non-decreasing in (ts, seq) within a branch', () => {
  assert.throws(
    () => hist([{ ts: 10, seq: 1, op: 'set', key: 'x', value: 1 }, { ts: 9, seq: 0, op: 'set', key: 'x', value: 2 }]),
    (err) => err instanceof HistError && err.code === E_TIME,
  );
  assert.throws(
    () => hist([{ ts: 10, seq: 2, op: 'set', key: 'x', value: 1 }, { ts: 10, seq: 1, op: 'set', key: 'x', value: 2 }]),
    (err) => err.code === E_TIME,
  );
  // same (ts, seq) twice on one branch is allowed (stable order)
  assert.equal(decide([{ ts: 1, seq: 1, op: 'set', key: 'x', value: 1 }, { ts: 1, seq: 1, op: 'set', key: 'x', value: 2 }], 1, 1).frozen, false);
});

test('E_FORK: structural branch errors', () => {
  const cases = [
    [{ ts: 1, seq: 0, op: 'set', key: 'x', value: 1, branch: 'nope' }],                 // unknown branch
    [{ ts: 1, seq: 0, op: 'fork', name: 'B' }, { ts: 2, seq: 0, op: 'fork', name: 'B' }], // duplicate fork
    [{ ts: 1, seq: 0, op: 'merge', name: 'B' }],                                       // merge unknown
    [{ ts: 1, seq: 0, op: 'merge', name: 'main' }],                                    // merge self
    [                                                                                  // event before fork point
      { ts: 5, seq: 0, op: 'fork', name: 'B' },
      { ts: 5, seq: 0, op: 'set', key: 'x', value: 1, branch: 'B' },
    ],
    [                                                                                  // double merge
      { ts: 1, seq: 0, op: 'fork', name: 'B' },
      { ts: 2, seq: 0, op: 'merge', name: 'B' },
      { ts: 3, seq: 0, op: 'merge', name: 'B' },
    ],
  ];
  for (const events of cases) {
    assert.throws(() => hist(events), (err) => err instanceof HistError && err.code === E_FORK);
  }
  // querying an unknown branch is also E_FORK
  assert.throws(() => decide([], 0, 0, 'ghost'), (err) => err.code === E_FORK);
});

test('explanation is minimal: only the events that justify the decision', () => {
  const events = [
    { ts: 1, seq: 0, op: 'rule', id: 'R1', when: { key: 'x', op: 'lt', value: 2 } },
    { ts: 1, seq: 1, op: 'set', key: 'noise', value: 9 },
    { ts: 2, seq: 0, op: 'set', key: 'x', value: 1 },
  ];
  const r = decide(events, 2, 0);
  assert.equal(r.frozen, true);
  assert.deepEqual(r.explain.map((e) => e.op).sort(), ['rule', 'set']);
  assert.equal(decide(events, 1, 1).explain.length, 0); // nothing to explain when no rule is close
});
