'use strict';

const { compileNfa } = require('./nfa');
const { validateEvents } = require('./judge');

function makeProof(dfa, result) {
  return {
    version: 1,
    dfaHash: dfa.hash,
    eventIds: result.consumed.slice(),
    finalState: result.finalState,
    verdict: result.verdict,
  };
}

// Independent verifier: recompiles the minimized DFA from the flow spec and
// replays the claimed event sequence from scratch. It never consults any
// CLI/session cache.
function verifyProof(flowSpec, events, proof) {
  const fail = (reason) => ({ ok: false, reason });
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) {
    return fail('MALFORMED_PROOF');
  }
  let dfa;
  try {
    dfa = compileNfa(flowSpec);
    validateEvents(events);
  } catch (err) {
    return fail(err.code || 'INVALID_INPUT');
  }
  if (proof.dfaHash !== dfa.hash) return fail('DFA_HASH_MISMATCH');
  if (!Array.isArray(proof.eventIds)) return fail('MALFORMED_PROOF');
  const m = proof.eventIds.length;
  if (m > events.length) return fail('EVENT_SEQUENCE_MISMATCH');
  for (let i = 0; i < m; i++) {
    if (events[i].id !== proof.eventIds[i]) return fail('EVENT_SEQUENCE_MISMATCH');
  }
  let state = dfa.start;
  for (let i = 0; i < m; i++) {
    const row = dfa.trans.get(state);
    const next = row ? row.get(events[i].role) : undefined;
    if (next === undefined) return fail('EVENT_SEQUENCE_MISMATCH');
    state = next;
  }
  if (state !== proof.finalState) return fail('FINAL_STATE_MISMATCH');
  let expected;
  if (m === events.length && dfa.accept.has(state)) {
    expected = 'accept';
  } else {
    if (m < events.length) {
      const row = dfa.trans.get(state);
      const next = row ? row.get(events[m].role) : undefined;
      if (next !== undefined) return fail('PREMATURE_REJECT');
    } else if (dfa.accept.has(state)) {
      return fail('PREMATURE_REJECT');
    }
    expected = 'reject';
  }
  if (proof.verdict !== expected) return fail('VERDICT_MISMATCH');
  return { ok: true, verdict: expected, finalState: state, dfaHash: dfa.hash };
}

module.exports = { makeProof, verifyProof };
