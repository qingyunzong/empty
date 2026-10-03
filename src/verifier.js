// Linearization verifier: replays a recovered/observed history and checks
// safety interlocks plus cmd/ack causality. Implemented as an explicit rule
// table, independent of the reference automaton in machine.js; randomized
// tests cross-check the two against each other.
//
// verify(events) -> {
//   verdict: 'OK' | 'VIOLATION',
//   safeState,                 // deterministic state after last valid event
//   violation: { index, event, kind, reason } | null,
//   minimalViolation: events[0..index] | null,   // minimal violating prefix
// }

import { INITIAL_STATE } from './machine.js';

const CMD_RULES = [
  {
    name: 'close_door',
    guard: (s) => (s.door === 'OPEN' ? true : `close_door requires door OPEN, got ${s.door}`),
    apply: (s) => ({ ...s, door: 'CLOSED' }),
  },
  {
    name: 'lock_door',
    guard: (s) => (s.door === 'CLOSED' ? true : `lock_door requires door CLOSED, got ${s.door}`),
    apply: (s) => ({ ...s, door: 'LOCKED' }),
  },
  {
    name: 'unlock_door',
    guard: (s) => {
      if (s.door !== 'LOCKED') return `unlock_door requires door LOCKED, got ${s.door}`;
      if (s.heat !== 'OFF') return 'unlock_door requires heat OFF';
      if (s.pressure !== 'LOW') return `unlock_door requires pressure LOW, got ${s.pressure}`;
      return true;
    },
    apply: (s) => ({ ...s, door: 'CLOSED' }),
  },
  {
    name: 'open_door',
    guard: (s) => {
      if (s.door !== 'CLOSED') return `open_door requires door CLOSED, got ${s.door}`;
      if (s.heat !== 'OFF') return 'open_door requires heat OFF';
      if (s.pressure !== 'LOW') return `open_door requires pressure LOW, got ${s.pressure}`;
      return true;
    },
    apply: (s) => ({ ...s, door: 'OPEN' }),
  },
  {
    name: 'heat_on',
    guard: (s) => {
      if (s.door !== 'LOCKED') return `heat_on requires door LOCKED, got ${s.door}`;
      if (s.vent !== 'CLOSED') return `heat_on requires vent CLOSED, got ${s.vent}`;
      if (s.heat !== 'OFF') return 'heat_on requires heat OFF';
      return true;
    },
    apply: (s) => ({ ...s, heat: 'ON', pressure: 'UNKNOWN' }),
  },
  {
    name: 'heat_off',
    guard: (s) => (s.heat === 'ON' ? true : 'heat_off requires heat ON'),
    apply: (s) => ({ ...s, heat: 'OFF' }),
  },
  {
    name: 'open_vent',
    guard: (s) => {
      if (s.vent !== 'CLOSED') return `open_vent requires vent CLOSED, got ${s.vent}`;
      if (s.pressure !== 'HIGH') {
        return `open_vent requires pressure HIGH (sensor-confirmed), got ${s.pressure}`;
      }
      return true;
    },
    apply: (s) => ({ ...s, vent: 'OPEN' }),
  },
  {
    name: 'close_vent',
    guard: (s) => (s.vent === 'OPEN' ? true : 'close_vent requires vent OPEN'),
    apply: (s) => ({ ...s, vent: 'CLOSED' }),
  },
];

// Causality rules: an ack linearizes only if its causal command is in effect.
const ACK_RULES = [
  {
    match: (e) => e.sensor === 'pressure' && e.value === 'HIGH',
    causal: (s) => (s.heat === 'ON' ? true : 'ack pressure HIGH without active heating'),
    apply: (s) => ({ ...s, pressure: 'HIGH' }),
  },
  {
    match: (e) => e.sensor === 'pressure' && e.value === 'LOW',
    causal: (s) => (s.vent === 'OPEN' ? true : 'ack pressure LOW without open vent'),
    apply: (s) => ({ ...s, pressure: 'LOW' }),
  },
  {
    match: (e) => e.sensor === 'door' && e.value === 'LOCKED',
    causal: (s) => (s.door === 'LOCKED' ? true : 'ack door LOCKED without lock_door'),
    apply: (s) => s,
  },
];

function applyEvent(state, event) {
  if (event.type === 'cmd') {
    const rule = CMD_RULES.find((r) => r.name === event.name);
    if (!rule) return { state, violation: { kind: 'INTERLOCK', reason: `unknown command ${event.name}` } };
    const check = rule.guard(state);
    if (check !== true) return { state, violation: { kind: 'INTERLOCK', reason: check } };
    return { state: rule.apply(state), violation: null };
  }
  if (event.type === 'ack') {
    const rule = ACK_RULES.find((r) => r.match(event));
    if (!rule) return { state, violation: null }; // unknown ack: no effect, stays UNKNOWN
    const check = rule.causal(state);
    if (check !== true) return { state, violation: { kind: 'CAUSALITY', reason: check } };
    return { state: rule.apply(state), violation: null };
  }
  return { state, violation: { kind: 'INTERLOCK', reason: `unknown event type ${event.type}` } };
}

export function verify(events) {
  let state = INITIAL_STATE;
  for (let i = 0; i < events.length; i += 1) {
    const { state: next, violation } = applyEvent(state, events[i]);
    if (violation) {
      return {
        verdict: 'VIOLATION',
        safeState: state,
        violation: { index: i, event: events[i], ...violation },
        minimalViolation: events.slice(0, i + 1),
      };
    }
    state = next;
  }
  return { verdict: 'OK', safeState: state, violation: null, minimalViolation: null };
}
