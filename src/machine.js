// Reference automaton for the autoclave (食品灭菌釜) safety interlock.
//
// Domain state:
//   door:     OPEN | CLOSED | LOCKED      (actuator state, set by commands)
//   heat:     OFF | ON                    (actuator state)
//   vent:     CLOSED | OPEN               (exhaust valve 排汽阀)
//   pressure: UNKNOWN | LOW | HIGH        (sensor knowledge, set ONLY by acks)
//
// Events:
//   { type: 'cmd', name }                 operator command
//   { type: 'ack', sensor, value }        sensor acknowledgement
//
// Violation kinds:
//   INTERLOCK  command guard not satisfied by current state
//   CAUSALITY  ack has no causal antecedent command (linearization failure)

export const INITIAL_STATE = Object.freeze({
  door: 'OPEN',
  heat: 'OFF',
  vent: 'CLOSED',
  pressure: 'UNKNOWN',
});

function ok(state) {
  return { state, violation: null };
}

function viol(state, kind, reason) {
  return { state, violation: { kind, reason } };
}

function stepCmd(s, name) {
  switch (name) {
    case 'close_door':
      if (s.door !== 'OPEN') return viol(s, 'INTERLOCK', `close_door requires door OPEN, got ${s.door}`);
      return ok({ ...s, door: 'CLOSED' });
    case 'lock_door':
      if (s.door !== 'CLOSED') return viol(s, 'INTERLOCK', `lock_door requires door CLOSED, got ${s.door}`);
      return ok({ ...s, door: 'LOCKED' });
    case 'unlock_door':
      if (s.door !== 'LOCKED') return viol(s, 'INTERLOCK', `unlock_door requires door LOCKED, got ${s.door}`);
      if (s.heat !== 'OFF') return viol(s, 'INTERLOCK', 'unlock_door requires heat OFF');
      if (s.pressure !== 'LOW') return viol(s, 'INTERLOCK', `unlock_door requires pressure LOW, got ${s.pressure}`);
      return ok({ ...s, door: 'CLOSED' });
    case 'open_door':
      if (s.door !== 'CLOSED') return viol(s, 'INTERLOCK', `open_door requires door CLOSED, got ${s.door}`);
      if (s.heat !== 'OFF') return viol(s, 'INTERLOCK', 'open_door requires heat OFF');
      if (s.pressure !== 'LOW') return viol(s, 'INTERLOCK', `open_door requires pressure LOW, got ${s.pressure}`);
      return ok({ ...s, door: 'OPEN' });
    case 'heat_on':
      if (s.door !== 'LOCKED') return viol(s, 'INTERLOCK', `heat_on requires door LOCKED, got ${s.door}`);
      if (s.vent !== 'CLOSED') return viol(s, 'INTERLOCK', `heat_on requires vent CLOSED, got ${s.vent}`);
      if (s.heat !== 'OFF') return viol(s, 'INTERLOCK', 'heat_on requires heat OFF');
      // New heating cycle: previously confirmed pressure no longer trusted.
      return ok({ ...s, heat: 'ON', pressure: 'UNKNOWN' });
    case 'heat_off':
      if (s.heat !== 'ON') return viol(s, 'INTERLOCK', 'heat_off requires heat ON');
      return ok({ ...s, heat: 'OFF' });
    case 'open_vent':
      if (s.vent !== 'CLOSED') return viol(s, 'INTERLOCK', `open_vent requires vent CLOSED, got ${s.vent}`);
      if (s.pressure !== 'HIGH') {
        return viol(s, 'INTERLOCK', `open_vent requires pressure HIGH (sensor-confirmed), got ${s.pressure}`);
      }
      return ok({ ...s, vent: 'OPEN' });
    case 'close_vent':
      if (s.vent !== 'OPEN') return viol(s, 'INTERLOCK', 'close_vent requires vent OPEN');
      return ok({ ...s, vent: 'CLOSED' });
    default:
      return viol(s, 'INTERLOCK', `unknown command ${name}`);
  }
}

function stepAck(s, sensor, value) {
  if (sensor === 'pressure' && value === 'HIGH') {
    // Causal antecedent: heat_on with no intervening heat_off.
    if (s.heat !== 'ON') return viol(s, 'CAUSALITY', 'ack pressure HIGH without active heating');
    return ok({ ...s, pressure: 'HIGH' });
  }
  if (sensor === 'pressure' && value === 'LOW') {
    // Causal antecedent: open_vent (venting drops pressure).
    if (s.vent !== 'OPEN') return viol(s, 'CAUSALITY', 'ack pressure LOW without open vent');
    return ok({ ...s, pressure: 'LOW' });
  }
  if (sensor === 'door' && value === 'LOCKED') {
    // Causal antecedent: lock_door.
    if (s.door !== 'LOCKED') return viol(s, 'CAUSALITY', 'ack door LOCKED without lock_door');
    return ok(s);
  }
  // Unknown ack: ignored. Sensor knowledge stays UNKNOWN; never judged safe.
  return ok(s);
}

// One transition of the reference automaton.
export function step(state, event) {
  if (event.type === 'cmd') return stepCmd(state, event.name);
  if (event.type === 'ack') return stepAck(state, event.sensor, event.value);
  return viol(state, 'INTERLOCK', `unknown event type ${event.type}`);
}

// Run a whole history. Stops at the first violation.
export function run(events) {
  let state = INITIAL_STATE;
  for (let i = 0; i < events.length; i += 1) {
    const r = step(state, events[i]);
    if (r.violation) return { verdict: 'VIOLATION', violationIndex: i, state };
    state = r.state;
  }
  return { verdict: 'OK', violationIndex: -1, state };
}
