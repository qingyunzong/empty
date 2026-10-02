'use strict';

const { Interpreter } = require('./interpreter');
const { sequences, invariantFailure, toEvents } = require('./enumerate');

// Default event alphabet for welding-cell experiments:
//   g = grant team key, o = open door, m = request auto mode, a = auto start.
const DEFAULT_ALPHABET = [
  { type: 'key_grant', key: 'K1', level: 'team', source: 'hmi' },
  { type: 'door', state: 'open', source: 'door' },
  { type: 'mode_request', mode: 'auto', source: 'hmi' },
  { type: 'auto_start', source: 'plc' },
];

function isIllegalAutoStart(interp) {
  return interp.running && invariantFailure(interp) !== null;
}

// Searches for the minimal event prefix that drives the interpreter into an
// illegal automatic start. Sequences are enumerated in (length, lex) order,
// so the first hit is a shortest counterexample. Returns { found, ... }.
function findIllegalAutoStart({ alphabet = DEFAULT_ALPHABET, maxDepth = 9, makeInterpreter } = {}) {
  const make = makeInterpreter || (() => new Interpreter({ trace: false }));
  let checked = 0;
  for (const seq of sequences(alphabet, maxDepth)) {
    if (seq.length === 0) continue;
    const interp = make();
    const events = toEvents(seq);
    interp.run(events);
    checked++;
    if (isIllegalAutoStart(interp)) {
      return { found: true, prefix: events, state: interp.snapshot(), checked };
    }
  }
  return { found: false, checked, maxDepth };
}

// Minimal prefix of a concrete event log that satisfies `predicate`.
function minimalPrefix(events, predicate) {
  const interp = new Interpreter();
  for (let i = 0; i < events.length; i++) {
    interp.run([events[i]]);
    if (predicate(interp)) return events.slice(0, i + 1);
  }
  return null;
}

module.exports = { DEFAULT_ALPHABET, isIllegalAutoStart, findIllegalAutoStart, minimalPrefix };
