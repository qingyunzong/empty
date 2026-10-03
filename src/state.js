export class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

export function initialState(quota) {
  return {
    quota,
    available: quota,
    nextTicketSeq: 1,
    nextEventSeq: 1,
    tickets: {},
    idempotency: {},
  };
}

export function formatTicketId(seq) {
  return `T${String(seq).padStart(6, '0')}`;
}

export function applyEvent(state, ev) {
  const ticket = ev.ticketId ? state.tickets[ev.ticketId] : undefined;
  switch (ev.type) {
    case 'freeze':
      state.tickets[ev.ticketId] = {
        ticketId: ev.ticketId,
        ticketSeq: ev.ticketSeq,
        amount: ev.amount,
        frozen: ev.amount,
        captured: 0,
        released: 0,
        compensated: 0,
        status: 'OPEN',
      };
      state.available -= ev.amount;
      state.nextTicketSeq += 1;
      break;
    case 'capture':
      ticket.frozen -= ev.amount;
      ticket.captured += ev.amount;
      if (ticket.frozen === 0) ticket.status = 'SETTLED';
      break;
    case 'release':
      ticket.frozen -= ev.amount;
      ticket.released += ev.amount;
      state.available += ev.amount;
      if (ticket.frozen === 0) ticket.status = 'RELEASED';
      break;
    case 'expire':
      state.available += ticket.frozen;
      ticket.released += ticket.frozen;
      ticket.frozen = 0;
      ticket.status = 'EXPIRED';
      break;
    case 'compensate':
      ticket.frozen -= ev.amount;
      ticket.released += ev.amount;
      ticket.compensated += ev.amount;
      state.available += ev.amount;
      break;
    case 'cancel':
      if (ev.releasedRemaining > 0) {
        ticket.released += ev.releasedRemaining;
        state.available += ev.releasedRemaining;
      }
      ticket.frozen = 0;
      ticket.status = 'CANCELLED';
      break;
    default:
      throw new Error(`unknown event type: ${ev.type}`);
  }
  if (ev.key) state.idempotency[ev.key] = ev.result;
  state.nextEventSeq += 1;
}

function mustGet(state, ticketId) {
  const ticket = state.tickets[ticketId];
  if (!ticket) {
    throw new BusinessError('TICKET_NOT_FOUND', `ticket not found: ${ticketId}`);
  }
  return ticket;
}

function mustGetOpen(state, ticketId) {
  const ticket = mustGet(state, ticketId);
  if (ticket.status !== 'OPEN') {
    throw new BusinessError('TICKET_NOT_OPEN', `ticket ${ticketId} is ${ticket.status}`);
  }
  return ticket;
}

export function planCommand(state, cmd) {
  switch (cmd.type) {
    case 'freeze': {
      if (cmd.amount > state.available) {
        throw new BusinessError(
          'INSUFFICIENT_QUOTA',
          `insufficient quota: requested ${cmd.amount}, available ${state.available}`,
        );
      }
      const ticketSeq = state.nextTicketSeq;
      const ticketId = formatTicketId(ticketSeq);
      const result = {
        ticketId,
        ticketSeq,
        amount: cmd.amount,
        status: 'OPEN',
        available: state.available - cmd.amount,
      };
      return { events: [{ type: 'freeze', ticketId, ticketSeq, amount: cmd.amount }], result };
    }
    case 'capture': {
      const ticket = mustGetOpen(state, cmd.ticketId);
      if (cmd.amount > ticket.frozen) {
        throw new BusinessError(
          'CAPTURE_EXCEEDS_FROZEN',
          `capture ${cmd.amount} exceeds remaining frozen ${ticket.frozen}`,
        );
      }
      const remaining = ticket.frozen - cmd.amount;
      const result = {
        ticketId: ticket.ticketId,
        captured: cmd.amount,
        totalCaptured: ticket.captured + cmd.amount,
        remainingFrozen: remaining,
        status: remaining === 0 ? 'SETTLED' : 'OPEN',
      };
      return { events: [{ type: 'capture', ticketId: ticket.ticketId, amount: cmd.amount }], result };
    }
    case 'release': {
      const ticket = mustGetOpen(state, cmd.ticketId);
      if (cmd.amount > ticket.frozen) {
        throw new BusinessError(
          'RELEASE_EXCEEDS_FROZEN',
          `release ${cmd.amount} exceeds remaining frozen ${ticket.frozen}`,
        );
      }
      const remaining = ticket.frozen - cmd.amount;
      const result = {
        ticketId: ticket.ticketId,
        released: cmd.amount,
        remainingFrozen: remaining,
        status: remaining === 0 ? 'RELEASED' : 'OPEN',
      };
      return { events: [{ type: 'release', ticketId: ticket.ticketId, amount: cmd.amount }], result };
    }
    case 'expire': {
      const ticket = mustGetOpen(state, cmd.ticketId);
      const result = { ticketId: ticket.ticketId, released: ticket.frozen, status: 'EXPIRED' };
      return { events: [{ type: 'expire', ticketId: ticket.ticketId }], result };
    }
    case 'cancel': {
      const ticket = mustGetOpen(state, cmd.ticketId);
      if (ticket.captured === 0) {
        const result = {
          ticketId: ticket.ticketId,
          released: ticket.frozen,
          compensated: 0,
          status: 'CANCELLED',
        };
        return {
          events: [{ type: 'cancel', ticketId: ticket.ticketId, releasedRemaining: ticket.frozen }],
          result,
        };
      }
      const result = {
        ticketId: ticket.ticketId,
        released: ticket.frozen,
        compensated: ticket.frozen,
        status: 'CANCELLED',
      };
      return {
        events: [
          { type: 'compensate', ticketId: ticket.ticketId, amount: ticket.frozen },
          { type: 'cancel', ticketId: ticket.ticketId, releasedRemaining: 0 },
        ],
        result,
      };
    }
    default:
      throw new BusinessError('UNKNOWN_COMMAND', `unknown command: ${cmd.type}`);
  }
}

export function ticketView(ticket) {
  if (!ticket) return null;
  return {
    ticketId: ticket.ticketId,
    ticketSeq: ticket.ticketSeq,
    amount: ticket.amount,
    frozen: ticket.frozen,
    captured: ticket.captured,
    released: ticket.released,
    compensated: ticket.compensated,
    status: ticket.status,
  };
}
