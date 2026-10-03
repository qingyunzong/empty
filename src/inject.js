// Fault injection: drop / dup / delay. Injections are themselves log records
// ({type:'inject', fault}), so a replay that processes the log in seq order
// reproduces the exact same mutated event stream.

// Pure transform over an event list.
export function applyFault(events, fault) {
  switch (fault.type) {
    case 'drop':
      return events.filter((e) => e.id !== fault.eventId);
    case 'dup': {
      // True duplicate: same id, like a repeated network frame. The replayer
      // dedups by id, so replay stays idempotent.
      const idx = events.findIndex((e) => e.id === fault.eventId);
      if (idx < 0) return events;
      return [...events.slice(0, idx + 1), { ...events[idx] }, ...events.slice(idx + 1)];
    }
    case 'delay':
      return events.map((e) => (e.id === fault.eventId ? { ...e, ts: e.ts + fault.delta } : e));
    default:
      throw new Error(`unknown fault type: ${fault.type}`);
  }
}
