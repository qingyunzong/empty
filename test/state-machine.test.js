import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  applyEvent,
  planCommand,
  ticketView,
  BusinessError,
} from '../src/state.js';

const TICKET_ID = 'T000001';

const OPS = [
  { type: 'capture', amount: 10 },
  { type: 'capture', amount: 30 },
  { type: 'release', amount: 10 },
  { type: 'release', amount: 30 },
  { type: 'expire' },
  { type: 'cancel' },
];

// Independent reference model of the ticket state machine.
function modelApply(ticket, op) {
  const next = { ...ticket };
  switch (op.type) {
    case 'capture': {
      if (ticket.status !== 'OPEN' || op.amount > ticket.frozen) return null;
      next.frozen -= op.amount;
      next.captured += op.amount;
      if (next.frozen === 0) next.status = 'SETTLED';
      return next;
    }
    case 'release': {
      if (ticket.status !== 'OPEN' || op.amount > ticket.frozen) return null;
      next.frozen -= op.amount;
      next.released += op.amount;
      if (next.frozen === 0) next.status = 'RELEASED';
      return next;
    }
    case 'expire': {
      if (ticket.status !== 'OPEN') return null;
      next.released += next.frozen;
      next.frozen = 0;
      next.status = 'EXPIRED';
      return next;
    }
    case 'cancel': {
      if (ticket.status !== 'OPEN') return null;
      if (next.captured > 0) next.compensated += next.frozen;
      next.released += next.frozen;
      next.frozen = 0;
      next.status = 'CANCELLED';
      return next;
    }
    default:
      return null;
  }
}

test('ticket state machine matches reference model for all op sequences up to length 12', () => {
  const base = initialState(1000);
  applyEvent(base, { seq: 1, type: 'freeze', ticketId: TICKET_ID, ticketSeq: 1, amount: 30 });

  const clone = (s) => JSON.parse(JSON.stringify(s));
  const keyOf = (state) => JSON.stringify(state.tickets[TICKET_ID]);
  const visited = new Set([keyOf(base)]);
  let frontier = [base];
  let transitions = 0;
  const MAX_DEPTH = 12;

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const nextFrontier = [];
    for (const state of frontier) {
      for (const op of OPS) {
        const realState = clone(state);
        let realTicket = null;
        let realError = null;
        try {
          const plan = planCommand(realState, { ...op, ticketId: TICKET_ID });
          for (const ev of plan.events) {
            applyEvent(realState, { ...ev, seq: realState.nextEventSeq });
          }
          realTicket = ticketView(realState.tickets[TICKET_ID]);
        } catch (err) {
          assert.ok(err instanceof BusinessError, `unexpected error: ${err}`);
          realError = err;
        }
        const model = modelApply(ticketView(state.tickets[TICKET_ID]), op);
        assert.equal(
          realError === null,
          model !== null,
          `accept/reject mismatch for ${JSON.stringify(op)} on ${keyOf(state)}`,
        );
        transitions += 1;
        if (realError === null) {
          assert.deepEqual(
            realTicket,
            model,
            `state mismatch for ${JSON.stringify(op)} on ${keyOf(state)}`,
          );
          const key = keyOf(realState);
          if (!visited.has(key)) {
            visited.add(key);
            nextFrontier.push(realState);
          }
        }
      }
    }
    frontier = nextFrontier;
  }

  assert.ok(transitions > 100, `expected many checked transitions, got ${transitions}`);
  assert.ok(visited.size >= 8, `expected a rich state space, got ${visited.size} states`);
});
