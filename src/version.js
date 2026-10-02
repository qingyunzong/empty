import { hash } from './canon.js';
import * as VC from './vector.js';
import { DqError, HISTORY_CONFLICT, BAD_INPUT } from './errors.js';
import { computeVersionId, resolveData, latestCommonAncestorData } from './history.js';

// A version is a content-addressed, causally-tracked dataset snapshot:
//   { id, vector, data, domains, history: [event, ...] }
// id = sha256 of canonical { data, domains, vector, history event ids }.
// history is the deduplicated causal event log, sorted by event id.

export { resolveData } from './history.js';

function sortEvents(events) {
  return [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function genesis(data, domains) {
  const event = { type: 'genesis', data, domains };
  event.id = hash({ type: 'genesis', data, domains });
  const id = computeVersionId(data, domains, {}, [event.id]);
  event.versionId = id;
  return { id, vector: {}, data, domains, history: [event] };
}

// Create a causal successor of `version` by applying a repair assignment.
export function applyRepair(version, assignment, cost, node) {
  const diff = {};
  for (const [k, v] of Object.entries(assignment)) {
    if (version.data[k] !== v) diff[k] = v;
  }
  const data = { ...version.data, ...diff };
  const vector = VC.tick(version.vector, node);
  const event = { type: 'repair', node, parent: version.id, diff, cost, vector };
  event.id = hash({ type: 'repair', node, parent: version.id, diff, cost, vector });
  const historyIds = [...version.history.map((e) => e.id), event.id].sort();
  const id = computeVersionId(data, version.domains, vector, historyIds);
  event.versionId = id;
  return { id, vector, data, domains: version.domains, history: sortEvents([...version.history, event]) };
}

// Merge two versions. Commutative: merge(a, b) deep-equals merge(b, a).
//   - identical vectors + identical data  -> idempotent
//   - identical vectors + divergent data  -> HISTORY_CONFLICT
//   - one vector dominates                -> the later version wins
//   - concurrent                          -> deterministic three-way merge
//     against the latest common ancestor, joined vector clock
export function mergeVersions(a, b) {
  if (hash(a.domains) !== hash(b.domains)) {
    throw new DqError(HISTORY_CONFLICT, 'cannot merge versions with different domains');
  }
  const cmp = VC.compare(a.vector, b.vector);
  if (cmp === 0) {
    if (hash(a.data) === hash(b.data)) return a;
    throw new DqError(HISTORY_CONFLICT,
      'identical vector clocks with divergent data (same causal point, different content)');
  }
  if (cmp === 1) return a;
  if (cmp === -1) return b;

  const parents = [a.id, b.id].sort();
  const first = parents[0] === a.id ? a : b;
  const second = parents[0] === a.id ? b : a;
  const events = [...a.history, ...b.history];
  const ancestor = latestCommonAncestorData(events, a.id, b.id);
  const { data, resolved } = resolveData(first.id, first.data, second.id, second.data, ancestor);
  const vector = VC.join(a.vector, b.vector);
  const event = { type: 'merge', parents, resolved, vector };
  event.id = hash({ type: 'merge', parents, resolved, vector });
  const byId = new Map();
  for (const e of events) byId.set(e.id, e);
  byId.set(event.id, event);
  const historyIds = [...byId.keys()].sort();
  const id = computeVersionId(data, a.domains, vector, historyIds);
  event.versionId = id;
  return { id, vector, data, domains: a.domains, history: sortEvents([...byId.values()]) };
}

export function isVersion(v) {
  return v && typeof v === 'object' && typeof v.id === 'string'
    && v.vector && typeof v.vector === 'object'
    && v.data && typeof v.data === 'object'
    && Array.isArray(v.history);
}

export function assertVersion(v) {
  if (!isVersion(v)) throw new DqError(BAD_INPUT, 'not a version object');
}
