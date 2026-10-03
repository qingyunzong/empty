// Event model and per-branch validation.

export const SCALAR_FIELDS = ['ts', 'source', 'type', 'ackBy', 'note', 'deleted'];

export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('event must be an object');
  }
  const {
    id, ts, source, type,
    ackBy = null, note = null, deleted = false, dependsOn = [],
  } = raw;
  if (typeof id !== 'string' || id.length === 0) throw new Error('event.id must be a non-empty string');
  if (!Number.isInteger(ts)) throw new Error(`event ${id}: ts must be an integer`);
  if (typeof source !== 'string') throw new Error(`event ${id}: source must be a string`);
  if (typeof type !== 'string') throw new Error(`event ${id}: type must be a string`);
  if (ackBy !== null && typeof ackBy !== 'string') throw new Error(`event ${id}: ackBy must be null or string`);
  if (note !== null && typeof note !== 'string') throw new Error(`event ${id}: note must be null or string`);
  if (typeof deleted !== 'boolean') throw new Error(`event ${id}: deleted must be a boolean`);
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
    throw new Error(`event ${id}: dependsOn must be an array of strings`);
  }
  return { id, ts, source, type, ackBy, note, deleted, dependsOn: [...new Set(dependsOn)].sort() };
}

// Validates one input branch: every dependency reference must exist and the
// dependency graph must be acyclic. Returns a normalized {id: event} map.
export function validateBranch(rawEvents, name = 'branch') {
  if (!Array.isArray(rawEvents)) throw new Error(`${name}: events must be an array`);
  const events = {};
  for (const raw of rawEvents) {
    const e = normalizeEvent(raw);
    if (events[e.id]) throw new Error(`${name}: duplicate event id ${e.id}`);
    events[e.id] = e;
  }
  for (const e of Object.values(events)) {
    for (const t of e.dependsOn) {
      if (!events[t]) throw new Error(`${name}: event ${e.id} depends on missing event ${t}`);
    }
  }
  // Acyclicity via Kahn.
  const indeg = new Map(Object.keys(events).map((id) => [id, 0]));
  for (const e of Object.values(events)) for (const t of e.dependsOn) indeg.set(e.id, indeg.get(e.id) + 1);
  const ready = Object.keys(events).filter((id) => indeg.get(id) === 0);
  let placed = 0;
  while (ready.length) {
    const u = ready.pop();
    placed += 1;
    for (const e of Object.values(events)) {
      if (e.dependsOn.includes(u)) {
        indeg.set(e.id, indeg.get(e.id) - 1);
        if (indeg.get(e.id) === 0) ready.push(e.id);
      }
    }
  }
  if (placed !== Object.keys(events).length) {
    throw new Error(`${name}: dependency graph contains a cycle`);
  }
  return events;
}
