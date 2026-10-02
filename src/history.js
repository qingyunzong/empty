import { hash } from './canon.js';
import * as VC from './vector.js';
import { DqError, HISTORY_CONFLICT } from './errors.js';

export function computeVersionId(data, domains, vector, historyIds) {
  return hash({ data, domains, vector, history: historyIds });
}

// Deterministic, order-independent per-variable three-way resolution.
//   - equal values                    -> keep
//   - only one side changed vs ancestor -> take the changed side
//   - both changed differently        -> value from the larger version id wins
export function resolveData(leftId, leftData, rightId, rightData, ancestorData = null) {
  const data = {};
  const resolved = {};
  const keys = [...new Set([...Object.keys(leftData), ...Object.keys(rightData)])].sort();
  for (const k of keys) {
    const lv = leftData[k];
    const rv = rightData[k];
    if (lv === rv) {
      data[k] = lv;
      continue;
    }
    let winner;
    if (ancestorData && lv === ancestorData[k]) winner = rv;
    else if (ancestorData && rv === ancestorData[k]) winner = lv;
    else winner = leftId > rightId ? lv : rv;
    data[k] = winner;
    resolved[k] = winner;
  }
  return { data, resolved };
}

// Replay causal events until `targetVersionId` is produced.
// Returns { data, vector } or throws HISTORY_CONFLICT.
export function replayEvents(events, targetVersionId) {
  const produced = new Map();
  let pending = [...events];
  while (pending.length > 0) {
    const next = [];
    let progress = false;
    for (const e of pending) {
      if (e.type === 'genesis') {
        produced.set(e.versionId, { data: e.data, vector: {} });
        progress = true;
      } else if (e.type === 'repair') {
        const parent = produced.get(e.parent);
        if (!parent) { next.push(e); continue; }
        const data = { ...parent.data, ...e.diff };
        const vector = VC.tick(parent.vector, e.node);
        if (hash(vector) !== hash(e.vector)) {
          throw new DqError(HISTORY_CONFLICT, `repair event ${e.id} has a wrong vector clock`);
        }
        produced.set(e.versionId, { data, vector });
        progress = true;
      } else if (e.type === 'merge') {
        const [p1, p2] = e.parents;
        const left = produced.get(p1);
        const right = produced.get(p2);
        if (!left || !right) { next.push(e); continue; }
        const ancestor = latestCommonAncestorData(events, p1, p2);
        const { data, resolved } = resolveData(p1, left.data, p2, right.data, ancestor);
        if (hash(resolved) !== hash(e.resolved)) {
          throw new DqError(HISTORY_CONFLICT, `merge event ${e.id} resolution mismatch`);
        }
        const vector = VC.join(left.vector, right.vector);
        if (hash(vector) !== hash(e.vector)) {
          throw new DqError(HISTORY_CONFLICT, `merge event ${e.id} has a wrong vector clock`);
        }
        produced.set(e.versionId, { data, vector });
        progress = true;
      } else {
        throw new DqError(HISTORY_CONFLICT, `unknown event type: ${e.type}`);
      }
      if (produced.has(targetVersionId)) return produced.get(targetVersionId);
    }
    if (!progress) {
      throw new DqError(HISTORY_CONFLICT, 'history has unresolvable causal dependencies');
    }
    pending = next;
  }
  throw new DqError(HISTORY_CONFLICT, `history does not produce version ${targetVersionId}`);
}

// Find the latest common ancestor of two version ids within an event log and
// replay its data. Returns null when the versions share no ancestor.
export function latestCommonAncestorData(events, idA, idB) {
  const versionsOf = (target) => {
    const seen = new Set();
    const collect = (id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const event = events.find((e) => e.versionId === id);
      if (!event) return;
      if (event.type === 'repair') collect(event.parent);
      else if (event.type === 'merge') for (const p of event.parents) collect(p);
    };
    collect(target);
    return seen;
  };
  const a = versionsOf(idA);
  const b = versionsOf(idB);
  const common = [...a].filter((id) => b.has(id));
  if (common.length === 0) return null;
  const vectorOf = (id) => {
    const event = events.find((e) => e.versionId === id);
    return event.vector || {};
  };
  // Keep only causally maximal ancestors, then pick deterministically.
  const maximal = common.filter((id) =>
    !common.some((other) => other !== id && VC.compare(vectorOf(other), vectorOf(id)) === 1));
  maximal.sort();
  const chosen = maximal[0];
  return replayEvents(events, chosen).data;
}
