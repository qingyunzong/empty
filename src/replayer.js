// Replayer: folds the append-only log into a device state.
// Processes records in seq order (injections mutate the event stream as
// encountered), dedups events by id (idempotent under dup injection), then
// folds the canonical candidate interleaving through the state machine.
import { initialState, applyOp, applyEvent } from './machine.js';
import { applyFault } from './inject.js';
import { canonicalOrder, dedupEvents } from './verifier.js';

export function replay(records, seed = 0) {
  let events = [];
  const ops = [];
  const injections = [];
  for (const rec of records) {
    if (rec.type === 'event') events.push(rec.event);
    else if (rec.type === 'op') ops.push(rec.op);
    else if (rec.type === 'inject') {
      injections.push(rec.fault);
      events = applyFault(events, rec.fault);
    }
  }
  const before = events.length;
  events = dedupEvents(events);
  const duplicatesCollapsed = before - events.length;

  const items = canonicalOrder({ ops, events, seed });
  let state = initialState();
  const results = {};
  const trace = [];
  for (const item of items) {
    if (item.type === 'op') {
      const r = applyOp(state, item.ref);
      state = r.state;
      results[item.ref.id] = r.result;
      trace.push({ key: item.key, type: 'op', result: r.result, state: { ...state } });
    } else if (item.ref.kind === 'ack') {
      trace.push({ key: item.key, type: 'event', kind: 'ack', skipped: true, state: { ...state } });
    } else {
      const r = applyEvent(state, item.ref);
      if (r.valid) state = r.state;
      trace.push({ key: item.key, type: 'event', kind: item.ref.kind, applied: r.valid, state: { ...state } });
    }
  }
  return { state, results, trace, injections, duplicatesCollapsed, events, ops };
}
