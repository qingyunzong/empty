// Core state machine for the packaging-line vision event stream.
//
// Inventories: good (accepted), defective (rejected, awaiting action),
// rework (currently on the rework bench).
//
// Per-inspect lifecycle:
//   pending --accept--> accepted --void_inspect--> voided
//   pending --reject--> rejected --rework_start--> reworking --rework_done--> done
//   rejected --void_inspect--> voided
//   reworking --void_inspect--> voided (emits reverse_rework, history kept)
//
// shutdown queues every subsequent event except restart; restart drains the
// queue in arrival order (FIFO, never reordered across restarts).

const ID_EVENTS = new Set([
  'inspect',
  'accept',
  'reject',
  'rework_start',
  'rework_done',
  'void_inspect',
]);
const CONTROL_EVENTS = new Set(['shutdown', 'restart']);
const KNOWN_EVENTS = new Set([...ID_EVENTS, ...CONTROL_EVENTS]);

export function createEngine() {
  const state = { good: 0, defective: 0, rework: 0 };
  const inspections = new Map(); // id -> status
  const moves = [];
  const errors = [];
  const queue = [];
  let shutdown = false;
  let applySeq = 0;

  function fail(seq, event, code, message) {
    errors.push({
      seq,
      event: event && event.type ? event.type : null,
      id: event && event.id !== undefined ? event.id : null,
      error: code,
      message,
    });
  }

  function record(seq, event, kind, delta) {
    moves.push({
      applySeq: ++applySeq,
      seq,
      id: event && event.id !== undefined ? event.id : null,
      kind,
      delta,
      state: { ...state },
    });
  }

  function applyEvent(ev) {
    const { seq, type, id } = ev;
    switch (type) {
      case 'inspect': {
        if (inspections.has(id)) {
          fail(seq, ev, 'duplicate_inspect', `inspect id "${id}" already exists`);
          return;
        }
        inspections.set(id, 'pending');
        return;
      }
      case 'accept':
      case 'reject': {
        const status = inspections.get(id);
        const target = type === 'accept' ? 'accepted' : 'rejected';
        if (status === undefined || status === 'voided') {
          fail(seq, ev, `orphan_${type}`, `${type} for unknown/voided inspect "${id}"`);
          return;
        }
        if (status === target) return; // idempotent duplicate result
        if (status !== 'pending') {
          fail(seq, ev, 'conflicting_result', `${type} conflicts with existing result for "${id}"`);
          return;
        }
        inspections.set(id, target);
        if (type === 'accept') {
          state.good += 1;
          record(seq, ev, 'accept', { good: +1 });
        } else {
          state.defective += 1;
          record(seq, ev, 'reject', { defective: +1 });
        }
        return;
      }
      case 'rework_start': {
        const status = inspections.get(id);
        if (status === undefined || status === 'voided') {
          fail(seq, ev, 'orphan_rework', `rework_start for unknown/voided inspect "${id}"`);
          return;
        }
        if (status === 'reworking' || status === 'done') {
          fail(seq, ev, 'double_consume', `judgment for "${id}" already consumed by rework`);
          return;
        }
        if (status !== 'rejected') {
          fail(seq, ev, 'invalid_state', `rework_start requires a rejected inspect, "${id}" is ${status}`);
          return;
        }
        inspections.set(id, 'reworking');
        state.defective -= 1;
        state.rework += 1;
        record(seq, ev, 'rework_start', { defective: -1, rework: +1 });
        return;
      }
      case 'rework_done': {
        const status = inspections.get(id);
        if (status === undefined || status === 'voided') {
          fail(seq, ev, 'orphan_rework', `rework_done for unknown/voided inspect "${id}"`);
          return;
        }
        if (status === 'done') {
          fail(seq, ev, 'double_consume', `rework_done for "${id}" already completed`);
          return;
        }
        if (status !== 'reworking') {
          fail(seq, ev, 'invalid_state', `rework_done requires an active rework, "${id}" is ${status}`);
          return;
        }
        inspections.set(id, 'done');
        state.rework -= 1;
        state.good += 1;
        record(seq, ev, 'rework_done', { rework: -1, good: +1 });
        return;
      }
      case 'void_inspect': {
        const status = inspections.get(id);
        if (status === undefined) {
          fail(seq, ev, 'orphan_void', `void_inspect for unknown inspect "${id}"`);
          return;
        }
        switch (status) {
          case 'pending':
            inspections.set(id, 'voided');
            record(seq, ev, 'void_pending', {});
            return;
          case 'accepted':
            inspections.set(id, 'voided');
            state.good -= 1;
            record(seq, ev, 'void_accept', { good: -1 });
            return;
          case 'rejected':
            inspections.set(id, 'voided');
            state.defective -= 1;
            record(seq, ev, 'void_reject', { defective: -1 });
            return;
          case 'reworking':
            // History cannot be erased: emit a compensating reverse_rework
            // instead of deleting the rework_start/rework moves.
            inspections.set(id, 'voided');
            state.rework -= 1;
            record(seq, ev, 'reverse_rework', { rework: -1 });
            return;
          case 'done':
            fail(seq, ev, 'already_consumed', `judgment for "${id}" fully consumed by rework_done`);
            return;
          case 'voided':
            fail(seq, ev, 'double_void', `inspect "${id}" already voided`);
            return;
          default:
            return;
        }
      }
      case 'shutdown': {
        if (shutdown) {
          fail(seq, ev, 'invalid_transition', 'shutdown while already shut down');
          return;
        }
        shutdown = true;
        record(seq, ev, 'shutdown', {});
        return;
      }
      case 'restart': {
        if (!shutdown) {
          fail(seq, ev, 'invalid_transition', 'restart while running');
          return;
        }
        shutdown = false;
        record(seq, ev, 'restart', {});
        // Merge pending events in original arrival order; a shutdown event
        // encountered mid-drain stops the merge until the next restart.
        while (queue.length > 0 && !shutdown) {
          applyEvent(queue.shift());
        }
        return;
      }
      default:
        return;
    }
  }

  function handle(ev) {
    if (!KNOWN_EVENTS.has(ev.type)) {
      fail(ev.seq, ev, 'unknown_event', `unknown event type "${ev.type}"`);
      return;
    }
    if (ID_EVENTS.has(ev.type) && (typeof ev.id !== 'string' || ev.id.length === 0)) {
      fail(ev.seq, ev, 'invalid_event', `event "${ev.type}" requires a non-empty string id`);
      return;
    }
    if (shutdown && ev.type !== 'restart') {
      queue.push(ev);
      return;
    }
    applyEvent(ev);
  }

  return {
    handle,
    result() {
      return {
        state: { ...state, pending: queue.length },
        moves,
        errors,
      };
    },
  };
}
