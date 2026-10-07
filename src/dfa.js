'use strict';
const crypto = require('node:crypto');

// Fixed alphabet of genealogy operations.
const ALPHABET = ['merge', 'split', 'test', 'ship'];

// Determinize an NFA via subset construction.
// nfa: { startIds: [id], trans: Map<id, Map<sym, Set<id>>>, output: Map<id, [defect]> }
// A split yields several successors on the same symbol; the subset construction
// models the traceability view as the *set* of current batches. Pending states
// are kept as ordinary states (never treated as unsatisfiable / dropped).
// Returns a total DFA: { start, states: Map<key, { members, output, trans }> }.
function determinize(nfa) {
  const states = new Map();
  const queue = [];
  const add = (members) => {
    const key = JSON.stringify(members);
    if (!states.has(key)) {
      const output = [...new Set(members.flatMap((id) => nfa.output.get(id) || []))].sort();
      states.set(key, { members, output, trans: {} });
      queue.push(key);
    }
    return key;
  };
  const start = add([...nfa.startIds].sort());
  for (let head = 0; head < queue.length; head++) {
    const st = states.get(queue[head]);
    for (const sym of ALPHABET) {
      const next = new Set();
      for (const id of st.members) {
        const bySym = nfa.trans.get(id);
        if (bySym && bySym.has(sym)) {
          for (const target of bySym.get(sym)) next.add(target);
        }
      }
      st.trans[sym] = add([...next].sort());
    }
  }
  return { start, states };
}

// Moore-machine minimization by partition refinement.
// Two states are equivalent iff their defect outputs agree and their
// transitions land in equivalent classes, for every symbol.
function minimize(dfa) {
  const keys = [...dfa.states.keys()];
  let cls = new Map();
  const byOutput = new Map();
  for (const key of keys) {
    const sig = JSON.stringify(dfa.states.get(key).output);
    if (!byOutput.has(sig)) byOutput.set(sig, byOutput.size);
    cls.set(key, byOutput.get(sig));
  }
  for (;;) {
    const sigs = new Map();
    const next = new Map();
    for (const key of keys) {
      const st = dfa.states.get(key);
      const sig = cls.get(key) + '|' + ALPHABET.map((a) => cls.get(st.trans[a])).join(',');
      if (!sigs.has(sig)) sigs.set(sig, sigs.size);
      next.set(key, sigs.get(sig));
    }
    if (new Set(next.values()).size === new Set(cls.values()).size) {
      cls = next;
      break;
    }
    cls = next;
  }
  const states = new Map();
  for (const key of keys) {
    const c = cls.get(key);
    if (!states.has(c)) states.set(c, { output: dfa.states.get(key).output, trans: {} });
  }
  for (const key of keys) {
    const c = cls.get(key);
    for (const a of ALPHABET) states.get(c).trans[a] = cls.get(dfa.states.get(key).trans[a]);
  }
  return { start: cls.get(dfa.start), states };
}

// Canonical form of a minimized, total, deterministic Moore machine:
// BFS from the start state with symbols in fixed alphabetical order,
// relabelling states in first-visit order. Two minimized machines are
// equivalent iff their canonical forms are identical.
function canonical(min) {
  const order = new Map([[min.start, 0]]);
  const queue = [min.start];
  const lines = [];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const st = min.states.get(id);
    const trans = ALPHABET.map((a) => {
      const t = st.trans[a];
      if (!order.has(t)) {
        order.set(t, order.size);
        queue.push(t);
      }
      return order.get(t);
    });
    lines.push(JSON.stringify([order.get(id), st.output, trans]));
  }
  return lines.join('\n');
}

function certificate(min) {
  return crypto.createHash('sha256').update(canonical(min)).digest('hex');
}

// Equivalence check between two minimized machines.
// Equal  -> { equal: true, certificate } (canonical-form hash is the proof).
// Unequal -> { equal: false, witness } where witness is a shortest symbol
// string after which the reachable defect sets differ (BFS on the product).
function equivalent(minA, minB) {
  const outA = (id) => JSON.stringify(minA.states.get(id).output);
  const outB = (id) => JSON.stringify(minB.states.get(id).output);
  if (outA(minA.start) !== outB(minB.start)) return { equal: false, witness: [] };
  const seen = new Set([minA.start + ',' + minB.start]);
  const queue = [[minA.start, minB.start, []]];
  for (let head = 0; head < queue.length; head++) {
    const [sa, sb, path] = queue[head];
    for (const a of ALPHABET) {
      const ta = minA.states.get(sa).trans[a];
      const tb = minB.states.get(sb).trans[a];
      const nextPath = [...path, a];
      if (outA(ta) !== outB(tb)) return { equal: false, witness: nextPath };
      const key = ta + ',' + tb;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push([ta, tb, nextPath]);
      }
    }
  }
  return { equal: true, certificate: certificate(minA) };
}

// Union of defect ids reachable from the NFA start states.
function reachableClosureNFA(nfa) {
  const seen = new Set(nfa.startIds);
  const queue = [...nfa.startIds];
  const out = new Set();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const d of nfa.output.get(id) || []) out.add(d);
    const bySym = nfa.trans.get(id);
    if (!bySym) continue;
    for (const targets of bySym.values()) {
      for (const t of targets) {
        if (!seen.has(t)) {
          seen.add(t);
          queue.push(t);
        }
      }
    }
  }
  return [...out].sort();
}

// Union of defect outputs over all (reachable) DFA states.
function reachableClosureDFA(dfa) {
  const out = new Set();
  for (const st of dfa.states.values()) for (const d of st.output) out.add(d);
  return [...out].sort();
}

module.exports = {
  ALPHABET,
  determinize,
  minimize,
  canonical,
  certificate,
  equivalent,
  reachableClosureNFA,
  reachableClosureDFA,
};
