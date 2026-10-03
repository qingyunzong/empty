'use strict';

const { RejectError } = require('./errors');

function initialState(total) {
  return {
    total,
    available: total,
    capturedTotal: 0,
    tickets: {},
    captures: {},
    ticketSeq: 0,
    captureSeq: 0,
  };
}

function checkAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RejectError(`invalid amount: ${amount}`);
  }
}

// Applies one delta op to a state object (mutates it). Returns op result ids.
function applyOp(state, op) {
  switch (op.op) {
    case 'freeze': {
      checkAmount(op.amount);
      if (op.amount > state.available) {
        throw new RejectError(`insufficient available quota: have ${state.available}, need ${op.amount}`);
      }
      state.ticketSeq += 1;
      const id = `T${state.ticketSeq}`;
      state.tickets[id] = { id, amount: op.amount, remaining: op.amount, status: 'open' };
      state.available -= op.amount;
      return { ticketId: id };
    }
    case 'capture': {
      checkAmount(op.amount);
      const ticket = state.tickets[op.ticketId];
      if (!ticket) throw new RejectError(`unknown ticket: ${op.ticketId}`);
      if (ticket.status !== 'open') throw new RejectError(`ticket ${op.ticketId} is not open`);
      if (op.amount > ticket.remaining) {
        throw new RejectError(`over-capture on ${op.ticketId}: remaining ${ticket.remaining}, want ${op.amount}`);
      }
      state.captureSeq += 1;
      const id = `C${state.captureSeq}`;
      state.captures[id] = { id, ticketId: op.ticketId, amount: op.amount, undone: false };
      ticket.remaining -= op.amount;
      state.total -= op.amount;
      state.capturedTotal += op.amount;
      return { captureId: id };
    }
    case 'release': {
      const ticket = state.tickets[op.ticketId];
      if (!ticket) throw new RejectError(`unknown ticket: ${op.ticketId}`);
      if (ticket.status !== 'open') throw new RejectError(`ticket ${op.ticketId} already released`);
      state.available += ticket.remaining;
      ticket.remaining = 0;
      ticket.status = 'released';
      return { ticketId: ticket.id };
    }
    case 'undo': {
      const capture = state.captures[op.captureId];
      if (!capture) throw new RejectError(`unknown capture: ${op.captureId}`);
      if (capture.undone) throw new RejectError(`capture ${op.captureId} already undone`);
      capture.undone = true;
      state.total += capture.amount;
      state.capturedTotal -= capture.amount;
      const ticket = state.tickets[capture.ticketId];
      if (ticket && ticket.status === 'open') {
        ticket.remaining += capture.amount;
      } else {
        state.available += capture.amount;
      }
      return { captureId: capture.id };
    }
    default:
      throw new RejectError(`unknown op: ${op.op}`);
  }
}

module.exports = { initialState, applyOp };
