// State machine for the payment hold lifecycle.
// State per hold: { amount, captured, active, deadline }.
//   frozen    = active ? amount - captured : 0   (still locked)
//   captured  = cumulative captured total
//   available = active ? amount - captured : 0   (still capturable)

export function createState() {
  return { holds: new Map() };
}

export function cloneState(state) {
  const holds = new Map();
  for (const [key, value] of state.holds) holds.set(key, { ...value });
  return { holds };
}

export function stateKey(state) {
  return JSON.stringify([...state.holds.entries()].sort());
}

export function auditValues(hold) {
  const frozen = hold.active ? hold.amount - hold.captured : 0;
  return { frozen, captured: hold.captured, available: frozen };
}

// Attempt to apply `op` at linearization point `point` to `state`.
// Returns { state, effect } when the observed response is reproducible,
// or null when this transition cannot produce the recorded response.
export function step(state, op, point) {
  const res = op.response;
  switch (op.op) {
    case 'hold': {
      if (!res.ok) return null;
      if (state.holds.has(res.holdId)) return null;
      const next = cloneState(state);
      next.holds.set(res.holdId, {
        amount: op.amount,
        captured: 0,
        active: true,
        deadline: op.deadline,
      });
      return { state: next, effect: { holdId: res.holdId } };
    }
    case 'capture': {
      const hold = state.holds.get(op.holdId);
      if (!res.ok) {
        if (res.error === 'not_found' && !hold) return { state, effect: {} };
        if (!hold) return null;
        if (res.error === 'cancelled' && !hold.active) return { state, effect: {} };
        if (res.error === 'expired' && hold.active && point > hold.deadline) {
          return { state, effect: {} };
        }
        if (
          res.error === 'insufficient' &&
          hold.active &&
          point <= hold.deadline &&
          op.amount > hold.amount - hold.captured
        ) {
          return { state, effect: {} };
        }
        return null;
      }
      if (!hold || !hold.active) return null;
      if (point > hold.deadline) return null;
      // Choose the capture allocation implied by the reported cumulative total.
      const total = res.totalCaptured;
      const delta = total - hold.captured;
      if (delta < 0 || delta > op.amount) return null;
      if (total > hold.amount) return null;
      const next = cloneState(state);
      next.holds.get(op.holdId).captured = total;
      return { state: next, effect: { allocation: delta } };
    }
    case 'cancel': {
      const hold = state.holds.get(op.holdId);
      if (!res.ok) {
        if (res.error === 'not_found' && !hold) return { state, effect: {} };
        if (res.error === 'cancelled' && hold && !hold.active) return { state, effect: {} };
        return null;
      }
      if (!hold || !hold.active) return null;
      // Cancel releases exactly the remaining (uncaptured) hold.
      if (res.released !== hold.amount - hold.captured) return null;
      const next = cloneState(state);
      next.holds.get(op.holdId).active = false;
      return { state: next, effect: { released: res.released } };
    }
    case 'audit': {
      const hold = state.holds.get(op.holdId);
      if (!res.ok) {
        return res.error === 'not_found' && !hold ? { state, effect: {} } : null;
      }
      if (!hold) return null;
      const observed = auditValues(hold);
      if (
        observed.frozen !== res.frozen ||
        observed.captured !== res.captured ||
        observed.available !== res.available
      ) {
        return null;
      }
      return { state, effect: { observed } };
    }
    default:
      return null;
  }
}
