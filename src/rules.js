// Safety rules for device event sequences.
//
// 1. Causal chain rule ("STOP 后必须 RESET 才能 RUN"): each device runs a
//    finite state machine; an event type is only legal in specific states.
// 2. Mutual exclusion ("同设备互斥事件不能并列"): all events of one device
//    must be strictly ordered in the linearization — the solver never leaves
//    same-device events unordered, and the machine decides which order is legal.

export const MACHINE = {
  initial: 'ready',
  transitions: {
    RUN: { from: ['ready'], to: 'running' },
    STOP: { from: ['running'], to: 'stopped' },
    RESET: { from: ['stopped'], to: 'ready' },
  },
};

// Rule identifiers used in conflict chains.
export function sequenceRule(type, neededStates) {
  return `sequence:${type}:requires-${neededStates.join('|')}`;
}

// Check whether an event of `type` may fire on a device currently in `state`.
// Unknown types are pass-through (no constraint).
export function checkTransition(state, type) {
  const t = MACHINE.transitions[type];
  if (!t) return { ok: true, to: state, rule: null };
  if (t.from.includes(state)) {
    return { ok: true, to: t.to, rule: sequenceRule(type, t.from) };
  }
  return { ok: false, to: state, rule: sequenceRule(type, t.from), need: t.from };
}
