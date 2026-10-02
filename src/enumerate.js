'use strict';

const { Interpreter, TEACH_SPEED_LIMIT } = require('./interpreter');

// Yields every sequence over `alphabet` of length 0..maxLen, ordered by
// (length, lexicographic). Because every prefix of a sequence is itself
// yielded earlier, checking the final state of each yielded sequence covers
// every prefix of every sequence up to maxLen.
function* sequences(alphabet, maxLen) {
  for (let len = 0; len <= maxLen; len++) yield* ofLength(alphabet, len);
}

function* ofLength(alphabet, len) {
  if (len === 0) { yield []; return; }
  const idx = new Array(len).fill(0);
  for (;;) {
    yield idx.map((i) => alphabet[i]);
    let p = len - 1;
    while (p >= 0 && idx[p] === alphabet.length - 1) { idx[p] = 0; p--; }
    if (p < 0) return;
    idx[p]++;
  }
}

// Safety invariants checked against the interpreter state. Returns a
// description of the first violated invariant, or null when all hold.
function invariantFailure(interp) {
  if (interp.running) {
    if (interp.mode !== 'auto') return 'automatic cycle running outside auto mode';
    if (interp.door !== 'closed') return 'automatic cycle running with door open';
    if (interp.curtain !== 'clear') return 'automatic cycle running with light curtain blocked';
    if (!interp.hasPermission('robot')) return 'automatic cycle running without robot-scope key permission';
    if (interp.decel) return 'automatic cycle running during deceleration window';
  }
  if (interp.decel && interp.running) return 'deceleration window active while running';
  if (interp.mode === 'teach' && interp.speedLimit > TEACH_SPEED_LIMIT) {
    return `teach speed ${interp.speedLimit} exceeds safety limit ${TEACH_SPEED_LIMIT}`;
  }
  if (interp.mode === 'maintenance' && interp.speedLimit !== 0) {
    return 'maintenance mode with nonzero speed limit';
  }
  return null;
}

function toEvents(seq) {
  return seq.map((e, i) => ({ ...e, clock: i + 1, seq: i + 1 }));
}

// Acceptance D: enumerate every event sequence of length <= maxLen and
// cross-check the interpreter against the safety invariants.
function crossCheck({ alphabet, maxLen, makeInterpreter }) {
  const make = makeInterpreter || (() => new Interpreter({ trace: false }));
  let checked = 0;
  const failures = [];
  for (const seq of sequences(alphabet, maxLen)) {
    const interp = make();
    interp.run(toEvents(seq));
    checked++;
    const failure = invariantFailure(interp);
    if (failure) failures.push({ sequence: toEvents(seq), failure });
  }
  return { checked, failures };
}

module.exports = { sequences, invariantFailure, toEvents, crossCheck };
