'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFlow, judgeEvents, Session, parseFlow } = require('../lib');
const { flowLinear, flowLoop, flowMerge, nfaSimulate } = require('./helpers');

const ROLES = ['经办', '复核', '清算', '归档'];
const MAX_LEN = 6;

function* allSequences(maxLen) {
  yield [];
  const seq = [];
  function* rec(depth) {
    if (depth === maxLen) return;
    for (const role of ROLES) {
      seq.push(role);
      yield [...seq];
      yield* rec(depth + 1);
      seq.pop();
    }
  }
  yield* rec(0);
}

function toEvents(roles) {
  return roles.map((role, i) => ({ id: `e${i}`, ts: i, role }));
}

test('D: exhaustive logs (<=6 events, 4 roles) — DFA matches NFA simulation and incremental replay', () => {
  for (const flow of [flowLinear, flowLoop, flowMerge]) {
    const compiled = compileFlow(flow);
    const nfa = parseFlow(flow);
    let checked = 0;
    for (const roles of allSequences(MAX_LEN)) {
      const events = toEvents(roles);
      // 1) minimized DFA vs direct NFA simulation
      const dfa = judgeEvents(compiled, events);
      const ref = nfaSimulate(nfa, events);
      assert.equal(dfa.consumed, ref.consumed, `consumed mismatch for ${roles}`);
      assert.equal(dfa.verdict === 'accept', ref.accepted, `verdict mismatch for ${roles}`);
      assert.deepEqual(dfa.continuations, ref.continuations, `continuations mismatch for ${roles}`);
      // 2) incremental session (append one by one) vs full replay
      const s = new Session(compiled);
      for (let i = 0; i < events.length; i++) {
        s.append(events[i]);
        const inc = s.judge();
        const full = judgeEvents(compiled, events.slice(0, i + 1));
        assert.equal(inc.verdict, full.verdict);
        assert.equal(inc.consumed, full.consumed);
        assert.equal(inc.finalState, full.finalState);
        assert.deepEqual(inc.continuations, full.continuations);
      }
      checked++;
    }
    assert.equal(checked, 5461); // 4^0 + ... + 4^6
  }
});
