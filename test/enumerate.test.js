'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileNfa, validateNfa, simulateNfa } = require('../src/nfa');
const { judgeEvents, IncrementalSession } = require('../src/judge');

const ROLES = ['经办', '复核', '清算', '归档'];
const MAX_LEN = 6;

const FLOWS = {
  linear: {
    states: ['draft', 'reviewed', 'cleared', 'archived'],
    roles: ROLES,
    start: 'draft',
    accept: ['archived'],
    transitions: [
      { from: 'draft', role: '经办', to: 'reviewed' },
      { from: 'reviewed', role: '复核', to: 'cleared' },
      { from: 'cleared', role: '清算', to: 'archived' },
      { from: 'archived', role: '归档', to: 'archived' },
    ],
  },
  nondet: {
    states: ['a', 'b', 'c', 'd'],
    roles: ROLES,
    start: 'a',
    accept: ['d'],
    transitions: [
      { from: 'a', role: '经办', to: 'b' },
      { from: 'a', role: '经办', to: 'c' },
      { from: 'b', to: 'c', epsilon: true },
      { from: 'b', role: '复核', to: 'd' },
      { from: 'c', role: '清算', to: 'd' },
      { from: 'c', role: '复核', to: 'd' },
      { from: 'd', role: '归档', to: 'd' },
    ],
  },
};

function* enumerateRoleSequences(roles, maxLen) {
  yield [];
  const indices = [];
  for (let len = 1; len <= maxLen; len++) {
    indices.length = 0;
    for (let i = 0; i < len; i++) indices.push(0);
    while (true) {
      yield indices.map((i) => roles[i]);
      let pos = len - 1;
      while (pos >= 0) {
        indices[pos] += 1;
        if (indices[pos] < roles.length) break;
        indices[pos] = 0;
        pos -= 1;
      }
      if (pos < 0) break;
    }
  }
}

test('D: exhaustive logs (<=6 events, 4 roles) — DFA matches NFA simulation and incremental matches full replay', () => {
  for (const [name, spec] of Object.entries(FLOWS)) {
    const dfa = compileNfa(spec);
    const nfa = validateNfa(spec);
    let checked = 0;
    for (const roles of enumerateRoleSequences(ROLES, MAX_LEN)) {
      const events = roles.map((role, i) => ({ id: `e${i}`, ts: i, role }));

      // 1) Compiled (subset-constructed + minimized) DFA vs reference NFA simulation.
      const full = judgeEvents(dfa, events);
      const sim = simulateNfa(nfa, roles);
      assert.equal(full.verdict === 'accept', sim.accepted, `${name} accept ${roles}`);
      assert.equal(full.consumed.length, sim.consumed, `${name} consumed ${roles}`);
      assert.deepEqual(full.continuations, sim.continuations, `${name} continuations ${roles}`);
      const expectedPrefixLen = sim.consumed < roles.length ? sim.consumed + 1 : roles.length;
      assert.equal(full.prefix.length, expectedPrefixLen, `${name} prefix ${roles}`);
      if (full.verdict === 'accept') {
        assert.equal(full.path.length, roles.length + 1, `${name} path ${roles}`);
      }

      // 2) Incremental append-by-append judging vs full replay at every step.
      const session = new IncrementalSession(dfa);
      for (let i = 0; i < events.length; i++) {
        const inc = session.append(events[i]);
        const ref = judgeEvents(dfa, events.slice(0, i + 1));
        const strip = ({ cache, ...rest }) => rest;
        assert.deepEqual(strip(inc), strip(ref), `${name} incremental ${roles.slice(0, i + 1)}`);
      }
      checked += 1;
    }
    assert.equal(checked, 5461, `${name} enumeration count`);
  }
});
