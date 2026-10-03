// Packaging-line device state machine.
//
// State: { estop, photo, cyl }
//   estop: emergency stop latched
//   photo: photoelectric sensor (workpiece present); initially true
//   cyl:   cylinder position IDLE -> MOVING_OUT -> EXTENDED -> MOVING_IN -> IDLE
//
// Commands (ops): extend / retract / reset.
// Events: estop, estop_clear, photo, photo_clear, cyl_done, ack.

export const CYL = Object.freeze({
  IDLE: 'IDLE',
  MOVING_OUT: 'MOVING_OUT',
  EXTENDED: 'EXTENDED',
  MOVING_IN: 'MOVING_IN',
});

export function initialState() {
  return { estop: false, photo: true, cyl: CYL.IDLE };
}

// Apply a command at its linearization point.
// Returns { state, result } with result 'ok' | 'fail' (fail => no state change).
export function applyOp(state, op) {
  const next = { ...state };
  let ok = false;
  switch (op.cmd) {
    case 'extend':
      ok = !next.estop && next.photo && next.cyl === CYL.IDLE;
      if (ok) next.cyl = CYL.MOVING_OUT;
      break;
    case 'retract':
      ok = !next.estop && next.cyl === CYL.EXTENDED;
      if (ok) next.cyl = CYL.MOVING_IN;
      break;
    case 'reset':
      ok = next.estop;
      if (ok) next.estop = false;
      break;
    default:
      ok = false;
  }
  return { state: next, result: ok ? 'ok' : 'fail' };
}

// Apply a device event. Returns { state, valid }.
// 'ack' is handled by the verifier (needs command results); here it is a no-op.
export function applyEvent(state, event) {
  const next = { ...state };
  switch (event.kind) {
    case 'estop':
      next.estop = true;
      return { state: next, valid: true };
    case 'estop_clear':
      next.estop = false;
      return { state: next, valid: true };
    case 'photo':
      next.photo = true;
      return { state: next, valid: true };
    case 'photo_clear':
      next.photo = false;
      return { state: next, valid: true };
    case 'cyl_done':
      if (next.cyl === CYL.MOVING_OUT) {
        next.cyl = CYL.EXTENDED;
        return { state: next, valid: true };
      }
      if (next.cyl === CYL.MOVING_IN) {
        next.cyl = CYL.IDLE;
        return { state: next, valid: true };
      }
      return { state, valid: false };
    case 'ack':
      return { state: next, valid: true };
    default:
      return { state, valid: false };
  }
}
