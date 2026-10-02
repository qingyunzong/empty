'use strict';

const flowLinear = {
  states: ['s0', 's1', 's2', 's3', 's4'],
  alphabet: ['经办', '复核', '清算', '归档'],
  start: 's0',
  accept: ['s4'],
  transitions: [
    ['s0', '经办', 's1'],
    ['s1', '复核', 's2'],
    ['s2', '清算', 's3'],
    ['s3', '归档', 's4'],
  ],
};

// nondeterministic, with branches, a loop and a dead-end branch
const flowLoop = {
  states: ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
  alphabet: ['经办', '复核', '清算', '归档'],
  start: 'q0',
  accept: ['q6'],
  transitions: [
    ['q0', '经办', 'q1'],
    ['q0', '经办', 'q2'],
    ['q1', '复核', 'q3'],
    ['q2', '复核', 'q3'],
    ['q3', '清算', 'q4'],
    ['q3', '归档', 'q5'],
    ['q5', '归档', 'q5'],
    ['q4', '归档', 'q6'],
    ['q6', '经办', 'q1'],
  ],
};

// equivalent states q1/q2 must be merged by minimization
const flowMerge = {
  states: ['q0', 'q1', 'q2', 'q3'],
  alphabet: ['经办', '复核'],
  start: 'q0',
  accept: ['q3'],
  transitions: [
    ['q0', '经办', 'q1'],
    ['q0', '复核', 'q2'],
    ['q1', '清算', 'q3'],
    ['q2', '清算', 'q3'],
  ],
};

let counter = 0;
function ev(role, ts, id) {
  counter++;
  return { id: id || `e${counter}`, ts, role };
}

function logFromRoles(roles, startTs) {
  return roles.map((role, i) => ({ id: `g${i}`, ts: (startTs || 0) + i, role }));
}

// reference: simulate directly on the NFA (no subset construction)
function nfaSimulate(nfa, events) {
  let cur = new Set([nfa.start]);
  let consumed = 0;
  for (const e of events) {
    const next = new Set();
    for (const s of cur) {
      const m = nfa.trans.get(s);
      const dst = m && m.get(e.role);
      if (dst) for (const d of dst) next.add(d);
    }
    if (next.size === 0) break;
    cur = next;
    consumed++;
  }
  const accepted = consumed === events.length && [...cur].some((s) => nfa.accept.has(s));
  const cont = new Set();
  for (const s of cur) {
    const m = nfa.trans.get(s);
    if (m) for (const role of m.keys()) cont.add(role);
  }
  return { consumed, accepted, continuations: [...cont].sort() };
}

// deterministic PRNG (LCG) for reproducible fuzzing
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

module.exports = { flowLinear, flowLoop, flowMerge, ev, logFromRoles, nfaSimulate, lcg };
