import { BusinessError } from './errors.js';

export function initialState(total) {
  if (!Number.isInteger(total) || total < 0) {
    throw new BusinessError('total must be a non-negative integer');
  }
  return { total, available: total, tickets: {}, ops: {}, nextTicket: 1, nextOp: 1 };
}

function checkAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BusinessError(`invalid amount: ${amount}`);
  }
  return amount;
}

function getOpenTicket(state, ticketId) {
  const ticket = state.tickets[ticketId];
  if (!ticket) throw new BusinessError(`unknown ticket: ${ticketId}`);
  if (ticket.status !== 'open') throw new BusinessError(`ticket closed: ${ticketId}`);
  return ticket;
}

// Applies one operation to state (mutates). Returns { opId, ... } result info.
// Throws BusinessError on rule violations; state may be partially inspected
// but callers must discard state on error (store reloads before each op).
export function applyOp(state, op) {
  const opId = `op${state.nextOp}`;
  switch (op.type) {
    case 'freeze': {
      const amount = checkAmount(op.amount);
      if (amount > state.available) {
        throw new BusinessError(`insufficient available: ${state.available} < ${amount}`);
      }
      const ticketId = `T${state.nextTicket}`;
      state.nextTicket += 1;
      state.available -= amount;
      state.tickets[ticketId] = { amount, remaining: amount, captured: 0, status: 'open' };
      state.ops[opId] = { type: 'freeze', ticketId, amount };
      state.nextOp += 1;
      return { opId, ticketId };
    }
    case 'capture': {
      const ticket = getOpenTicket(state, op.ticketId);
      const amount = checkAmount(op.amount);
      if (amount > ticket.remaining) {
        throw new BusinessError(`capture exceeds remaining: ${ticket.remaining} < ${amount}`);
      }
      ticket.remaining -= amount;
      ticket.captured += amount;
      state.total -= amount;
      state.ops[opId] = { type: 'capture', ticketId: op.ticketId, amount, undone: false };
      state.nextOp += 1;
      return { opId };
    }
    case 'release': {
      const ticket = state.tickets[op.ticketId];
      if (!ticket) throw new BusinessError(`unknown ticket: ${op.ticketId}`);
      if (ticket.status !== 'open') throw new BusinessError(`ticket already released: ${op.ticketId}`);
      state.available += ticket.remaining;
      ticket.remaining = 0;
      ticket.status = 'closed';
      state.ops[opId] = { type: 'release', ticketId: op.ticketId };
      state.nextOp += 1;
      return { opId };
    }
    case 'undo': {
      const target = state.ops[op.opId];
      if (!target) throw new BusinessError(`unknown operation: ${op.opId}`);
      if (target.type !== 'capture') {
        throw new BusinessError(`only captures can be undone: ${op.opId}`);
      }
      if (target.undone) throw new BusinessError(`capture already undone: ${op.opId}`);
      const ticket = getOpenTicket(state, target.ticketId);
      ticket.remaining += target.amount;
      ticket.captured -= target.amount;
      state.total += target.amount;
      target.undone = true;
      state.ops[opId] = { type: 'undo', of: op.opId, amount: target.amount };
      state.nextOp += 1;
      return { opId };
    }
    default:
      throw new BusinessError(`unknown op type: ${op.type}`);
  }
}
