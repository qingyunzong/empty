// Field-wise three-way merge of base/local/remote event maps.
// Produces tentative merged events plus structured conflicts. Resolutions are
// applied later by the repo layer on top of the tentative merge.

import { deepEqual, clone } from './util.js';
import { SCALAR_FIELDS } from './events.js';

function threeWay(bv, lv, rv) {
  if (deepEqual(lv, rv)) return clone(lv);
  if (deepEqual(bv, lv)) return clone(rv);
  if (deepEqual(bv, rv)) return clone(lv);
  return clone(bv); // both changed differently: tentative falls back to base
}

// Standard three-way set merge for dependency edges.
export function mergeEdges(bDeps, lDeps, rDeps) {
  const b = new Set(bDeps), l = new Set(lDeps), r = new Set(rDeps);
  const out = [];
  for (const t of new Set([...b, ...l, ...r])) {
    const inB = b.has(t), inL = l.has(t), inR = r.has(t);
    if ((inL && inR) || (inL && !inB) || (inR && !inB)) out.push(t);
  }
  return out.sort();
}

function versions(bv, lv, rv) {
  return { base: bv === undefined ? null : clone(bv), local: lv === undefined ? null : clone(lv), remote: rv === undefined ? null : clone(rv) };
}

function changedOtherThanDelete(x, b) {
  return SCALAR_FIELDS.some((f) => f !== 'deleted' && !deepEqual(x[f], b[f]))
    || !deepEqual(x.dependsOn, b.dependsOn);
}

export function mergeBranches(base = {}, local = {}, remote = {}) {
  const ids = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
  const events = {};
  const conflicts = new Map();

  for (const id of ids) {
    const b = base[id] ?? null;
    const l = local[id] ?? null;
    const r = remote[id] ?? null;
    const pB = b !== null, pL = l !== null, pR = r !== null;

    if (!pB) {
      // Added after base.
      if (pL && !pR) { events[id] = clone(l); continue; }
      if (pR && !pL) { events[id] = clone(r); continue; }
      if (!pL && !pR) continue;
      // Added on both sides: union of edges, per-field conflicts on divergence.
      const merged = { id, dependsOn: mergeEdges([], l.dependsOn, r.dependsOn) };
      for (const f of SCALAR_FIELDS) {
        if (deepEqual(l[f], r[f])) {
          merged[f] = clone(l[f]);
        } else {
          merged[f] = clone(l[f]); // tentative
          const cid = `field:${id}:${f}`;
          conflicts.set(cid, { id: cid, type: 'FIELD', eventId: id, fields: { [f]: versions(null, l[f], r[f]) } });
        }
      }
      events[id] = merged;
      continue;
    }

    // Present in base: merge presence.
    if (!pL && !pR) continue; // removed on both sides
    if (!pL || !pR) {
      const survivor = pL ? l : r;
      if (deepEqual(survivor, b)) continue; // removed by one side, untouched by other
      const cid = `delete-update:${id}`;
      conflicts.set(cid, {
        id: cid, type: 'DELETE_UPDATE', eventId: id, removal: true,
        deletingSide: pL ? 'remote' : 'local',
        fields: { presence: { base: 'present', local: pL ? 'present' : 'absent', remote: pR ? 'present' : 'absent' } },
      });
      events[id] = clone(survivor); // tentative: survivor's version stays
      continue;
    }

    // Present everywhere.
    const lDeleted = l.deleted === true && b.deleted === false;
    const rDeleted = r.deleted === true && b.deleted === false;
    let duSide = null;
    if (lDeleted && !rDeleted && changedOtherThanDelete(r, b)) duSide = 'local';
    else if (rDeleted && !lDeleted && changedOtherThanDelete(l, b)) duSide = 'remote';

    const merged = { id };
    if (duSide) {
      // DELETE_UPDATE: one side retracted the event while the other side
      // modified fields or dependencies. Every field touched by either side
      // becomes contested and needs an explicit per-field resolution.
      const duFields = {};
      const contested = new Set(['deleted']);
      for (const f of SCALAR_FIELDS) {
        if (f !== 'deleted' && (!deepEqual(l[f], b[f]) || !deepEqual(r[f], b[f]))) contested.add(f);
      }
      for (const f of contested) duFields[f] = versions(b[f], l[f], r[f]);
      for (const f of SCALAR_FIELDS) merged[f] = contested.has(f) ? threeWay(b[f], l[f], r[f]) : clone(b[f]);
      if (!deepEqual(l.dependsOn, b.dependsOn) || !deepEqual(r.dependsOn, b.dependsOn)) {
        duFields.dependsOn = versions(b.dependsOn, l.dependsOn, r.dependsOn);
      }
      merged.dependsOn = mergeEdges(b.dependsOn, l.dependsOn, r.dependsOn);
      const cid = `delete-update:${id}`;
      conflicts.set(cid, { id: cid, type: 'DELETE_UPDATE', eventId: id, deletingSide: duSide, fields: duFields });
    } else {
      for (const f of SCALAR_FIELDS) {
        const bv = b[f], lv = l[f], rv = r[f];
        if (deepEqual(lv, rv) || deepEqual(bv, lv) || deepEqual(bv, rv)) {
          merged[f] = threeWay(bv, lv, rv);
        } else {
          merged[f] = clone(bv); // tentative
          const cid = `field:${id}:${f}`;
          conflicts.set(cid, { id: cid, type: 'FIELD', eventId: id, fields: { [f]: versions(bv, lv, rv) } });
        }
      }
      merged.dependsOn = mergeEdges(b.dependsOn, l.dependsOn, r.dependsOn);
    }
    events[id] = merged;
  }

  return { events, conflicts };
}
