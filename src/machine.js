// Packaging-line device state machine (the sequential spec used by the verifier
// and the event fold used by the replayer).
export const INITIAL_STATE = 'READY';

export const COMMANDS = {
  press_estop: {
    ack: 'estop',
    enabled: () => true,
    next: () => 'ESTOPPED',
  },
  reset: {
    ack: 'reset_ack',
    enabled: (s) => s === 'ESTOPPED',
    next: () => 'READY',
  },
  extend_cylinder: {
    ack: 'cyl_done',
    enabled: (s) => s === 'READY',
    next: () => 'CYL_OUT',
  },
  retract_cylinder: {
    ack: 'cyl_done',
    enabled: (s) => s === 'CYL_OUT',
    next: () => 'READY',
  },
  start_cycle: {
    ack: 'photo',
    enabled: (s) => s === 'READY',
    next: () => 'READY',
  },
};

// Replayer fold: raw device events applied to the state machine.
// Duplicate e-stop is idempotent (ESTOPPED stays ESTOPPED), which is what makes
// injected duplicates replay to the same final state.
export function applyEvent(state, kind) {
  switch (kind) {
    case 'estop':
      return 'ESTOPPED';
    case 'reset_ack':
      return state === 'ESTOPPED' ? 'READY' : state;
    case 'cyl_done':
      if (state === 'READY') return 'CYL_OUT';
      if (state === 'CYL_OUT') return 'READY';
      return state;
    case 'photo':
      return state;
    default:
      return state;
  }
}
