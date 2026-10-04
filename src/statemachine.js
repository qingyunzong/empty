// Lot state machine:   normal --hold--> held --release--> normal
// Device state machine: ok --alarm--> alarmed --clear--> ok
// Illegal transitions are rejected with VALIDATION and leave state unchanged.
// quality.scan never fails; payload.result === 'fail' acts as an auto-hold
// (a no-op record when the lot is already held).

export function createLot() {
  return { status: 'normal', total: 0, scans: 0, transitions: 0, history: [] };
}

export function createDevice() {
  return { status: 'ok', transitions: 0, history: [] };
}

function lotOf(state, lot) {
  return (state.lots[lot] ??= createLot());
}

function deviceOf(state, device) {
  return (state.devices[device] ??= createDevice());
}

// Apply one event to in-memory state.
// Returns { applied: true } or { applied: false, error: {code,message} }.
export function applyEvent(state, event) {
  const { kind } = event;
  if (kind === 'device.alarm' || kind === 'device.clear') {
    const dev = deviceOf(state, event.device);
    if (kind === 'device.alarm') {
      if (dev.status !== 'ok') return reject(`device ${event.device}: alarm while ${dev.status}`, event);
      dev.status = 'alarmed';
    } else {
      if (dev.status !== 'alarmed') return reject(`device ${event.device}: clear while ${dev.status}`, event);
      dev.status = 'ok';
    }
    dev.transitions++;
    dev.history.push(event.id);
    return { applied: true };
  }

  const lot = lotOf(state, event.lot);
  if (kind === 'quality.scan') {
    lot.scans++;
    lot.total += typeof event.payload?.qty === 'number' ? event.payload.qty : 1;
    lot.history.push(event.id);
    if (event.payload?.result === 'fail') {
      if (lot.status === 'normal') {
        lot.status = 'held';
        lot.transitions++;
      }
      // auto-hold on an already held lot is a recorded no-op, not an error
    }
    return { applied: true };
  }
  if (kind === 'quality.hold') {
    if (lot.status !== 'normal') return reject(`lot ${event.lot}: hold while ${lot.status}`, event);
    lot.status = 'held';
  } else if (kind === 'quality.release') {
    if (lot.status !== 'held') return reject(`lot ${event.lot}: release while ${lot.status}`, event);
    lot.status = 'normal';
  }
  lot.transitions++;
  lot.history.push(event.id);
  return { applied: true };
}

function reject(message, event) {
  return { applied: false, error: { code: 'VALIDATION', message, eventId: event.id } };
}

// ---------------------------------------------------------------------------
// Happens-before over payload.deps (causal ancestors).
// ---------------------------------------------------------------------------

// Build id -> event map and validate the causal shape of a set of events.
export function indexById(events) {
  const map = new Map();
  for (const e of events) map.set(e.id, e);
  return map;
}

export function depsOf(event) {
  return event.payload?.deps ?? [];
}

// True iff `a` happens-before `b` within the given event map (a in deps*(b)).
export function happensBefore(map, aId, bId) {
  const seen = new Set();
  const stack = [bId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === aId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const e = map.get(id);
    if (!e) continue; // unknown ancestor: cannot establish the edge
    for (const d of depsOf(e)) stack.push(d);
  }
  return false;
}

export function unknownAncestors(map, events) {
  const unknown = new Set();
  for (const e of events) {
    for (const d of depsOf(e)) if (!map.has(d)) unknown.add(d);
  }
  return [...unknown];
}

// Kahn's algorithm; returns null when a cycle exists.
export function topoSort(map, events) {
  const ids = events.map((e) => e.id);
  const inScope = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const edges = new Map(ids.map((id) => [id, []]));
  for (const e of events) {
    for (const d of depsOf(e)) {
      if (!inScope.has(d)) continue; // out-of-scope deps handled by caller
      indeg.set(e.id, indeg.get(e.id) + 1);
      edges.get(d).push(e.id);
    }
  }
  const queue = ids.filter((id) => indeg.get(id) === 0).sort();
  const out = [];
  while (queue.length > 0) {
    const id = queue.shift();
    out.push(map.get(id));
    for (const next of edges.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  return out.length === ids.length ? out : null;
}

// Maximal elements under happens-before (events no other event depends on).
export function maximalEvents(map, events) {
  const hasSuccessor = new Set();
  const ids = new Set(events.map((e) => e.id));
  for (const e of events) {
    for (const d of depsOf(e)) if (ids.has(d)) hasSuccessor.add(d);
  }
  return events.filter((e) => !hasSuccessor.has(e.id));
}

// Maximal elements under the transitive happens-before closure: an event is
// maximal iff no other event in the set causally follows it.
export function causalMaxima(map, events) {
  return events.filter((e) => !events.some((o) => o.id !== e.id && happensBefore(map, e.id, o.id)));
}
