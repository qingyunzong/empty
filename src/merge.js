import { SCALAR_FIELDS } from './event.js';
import { deepEqual, hashValue } from './canonical.js';
import { findCycle, kahnCertificate, computeBlocked } from './graph.js';

export function edgeKey(eventId, dep) {
  return eventId + '→' + dep;
}

export function conflictId(c) {
  return hashValue({
    type: c.type,
    eventId: c.eventId,
    field: c.field ?? null,
    base: c.base,
    local: c.local,
    remote: c.remote,
  }).slice(0, 16);
}

function copyEvent(e) {
  return { ...e, dependsOn: [...e.dependsOn] };
}

function mergeScalar(b, l, r) {
  if (deepEqual(l, r)) return { value: l };
  if (deepEqual(l, b)) return { value: r };
  if (deepEqual(r, b)) return { value: l };
  return { conflict: true };
}

function otherFieldsChanged(side, base) {
  return (
    SCALAR_FIELDS.some((f) => f !== 'deleted' && !deepEqual(side[f], base[f])) ||
    !deepEqual(side.dependsOn, base.dependsOn)
  );
}

function recordProvenance(edgeProvenance, id, b, l, r) {
  const deps = new Set([
    ...(b ? b.dependsOn : []),
    ...(l ? l.dependsOn : []),
    ...(r ? r.dependsOn : []),
  ]);
  for (const dep of [...deps].sort()) {
    edgeProvenance.set(edgeKey(id, dep), {
      eventId: id,
      dependsOn: dep,
      base: b ? b.dependsOn.includes(dep) : false,
      local: l ? l.dependsOn.includes(dep) : false,
      remote: r ? r.dependsOn.includes(dep) : false,
      merged: false,
    });
  }
}

export function applyResolution(events, conflict, pick) {
  const ev = events.get(conflict.eventId);
  if (!ev) return;
  const side = pick === 'local' ? conflict.local : conflict.remote;
  if (conflict.type === 'FIELD') {
    ev[conflict.field] = side;
  } else if (conflict.type === 'DELETE_UPDATE') {
    for (const f of conflict.coveredFields) {
      if (f === 'dependsOn') ev.dependsOn = [...side.dependsOn];
      else ev[f] = side[f];
    }
  }
}

function provenanceBranches(prov) {
  if (!prov) return [];
  return ['base', 'local', 'remote'].filter((k) => prov[k]);
}

// Recomputes derived state after events changed. When regionIds is given,
// only blocked entries inside that region are refreshed (incremental path);
// pass null for a full recompute.
export function refreshDerived(result, regionIds = null) {
  const { events, edgeProvenance } = result;
  for (const prov of edgeProvenance.values()) prov.merged = false;
  for (const e of events.values()) {
    for (const d of e.dependsOn) {
      const k = edgeKey(e.id, d);
      const prov = edgeProvenance.get(k);
      if (prov) prov.merged = true;
      else {
        edgeProvenance.set(k, { eventId: e.id, dependsOn: d, base: false, local: false, remote: false, merged: true });
      }
    }
  }
  result.missingRefs = [];
  for (const e of events.values()) {
    for (const d of e.dependsOn) {
      if (!events.has(d)) result.missingRefs.push({ eventId: e.id, dependsOn: d });
    }
  }
  const cyc = findCycle(events);
  result.cycle = cyc
    ? {
        nodes: cyc.nodes,
        edges: cyc.edges.map((e) => ({
          ...e,
          branches: provenanceBranches(edgeProvenance.get(edgeKey(e.event, e.dependsOn))),
        })),
      }
    : null;
  if (!regionIds) {
    result.blocked = computeBlocked(events);
  } else {
    const map = new Map(result.blocked.map((b) => [b.id, b]));
    for (const id of regionIds) {
      const e = events.get(id);
      const bad = e && !e.deleted ? e.dependsOn.filter((d) => events.get(d)?.deleted).sort() : [];
      if (bad.length) map.set(id, { id, blockedBy: bad });
      else map.delete(id);
    }
    result.blocked = [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  result.certificate = result.cycle || result.missingRefs.length ? null : kahnCertificate(events);
  return result;
}

// Three-way merge by event id and field. `resolutions` is a list of
// { conflictId, pick } with pick in {'local','remote'} applied on top of the
// tentative merge. Returns the merged events plus conflicts, cycle report,
// blocked report, topo certificate and per-edge provenance.
export function mergeBranches(base, local, remote, resolutions = []) {
  const conflicts = [];
  const merged = new Map();
  const edgeProvenance = new Map();
  const ids = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort();

  for (const id of ids) {
    const b = base.get(id) ?? null;
    const lraw = local.get(id) ?? null;
    const rraw = remote.get(id) ?? null;
    const l = lraw ?? b;
    const r = rraw ?? b;

    if (!b) {
      // Event added on one or both sides.
      if (lraw && rraw && !deepEqual(lraw, rraw)) {
        const ev = { id, dependsOn: [] };
        for (const f of SCALAR_FIELDS) {
          if (deepEqual(lraw[f], rraw[f])) {
            ev[f] = lraw[f];
          } else {
            const c = { type: 'FIELD', eventId: id, field: f, base: null, local: lraw[f], remote: rraw[f] };
            c.conflictId = conflictId(c);
            conflicts.push(c);
            ev[f] = lraw[f];
          }
        }
        ev.dependsOn = [...new Set([...lraw.dependsOn, ...rraw.dependsOn])].sort();
        merged.set(id, ev);
      } else {
        merged.set(id, copyEvent(lraw ?? rraw));
      }
      recordProvenance(edgeProvenance, id, null, lraw, rraw);
      continue;
    }

    const localDeleted = l.deleted !== b.deleted;
    const remoteDeleted = r.deleted !== b.deleted;
    const deleteUpdate =
      localDeleted !== remoteDeleted && (localDeleted ? otherFieldsChanged(r, b) : otherFieldsChanged(l, b));

    if (deleteUpdate) {
      const deleteSide = localDeleted ? 'local' : 'remote';
      const covered = new Set(['deleted']);
      for (const f of SCALAR_FIELDS) {
        if (f !== 'deleted' && (!deepEqual(l[f], b[f]) || !deepEqual(r[f], b[f]))) covered.add(f);
      }
      if (!deepEqual(l.dependsOn, b.dependsOn) || !deepEqual(r.dependsOn, b.dependsOn)) covered.add('dependsOn');
      const c = {
        type: 'DELETE_UPDATE',
        eventId: id,
        deleteSide,
        coveredFields: [...covered].sort(),
        base: b,
        local: l,
        remote: r,
      };
      c.conflictId = conflictId(c);
      conflicts.push(c);
      // Tentative: keep the withdrawal (deleted events retain metadata and edges).
      merged.set(id, copyEvent(deleteSide === 'local' ? l : r));
      recordProvenance(edgeProvenance, id, b, l, r);
      continue;
    }

    const ev = { id, dependsOn: [] };
    for (const f of SCALAR_FIELDS) {
      const res = mergeScalar(b[f], l[f], r[f]);
      if (res.conflict) {
        const c = { type: 'FIELD', eventId: id, field: f, base: b[f], local: l[f], remote: r[f] };
        c.conflictId = conflictId(c);
        conflicts.push(c);
        ev[f] = b[f];
      } else {
        ev[f] = res.value;
      }
    }
    // dependsOn: per-edge three-way existence merge.
    const out = [];
    for (const dep of [...new Set([...b.dependsOn, ...l.dependsOn, ...r.dependsOn])].sort()) {
      const be = b.dependsOn.includes(dep);
      const le = l.dependsOn.includes(dep);
      const re = r.dependsOn.includes(dep);
      const me = le === re ? le : le !== be ? le : re;
      if (me) out.push(dep);
    }
    ev.dependsOn = out;
    merged.set(id, ev);
    recordProvenance(edgeProvenance, id, b, l, r);
  }

  const appliedResolutions = [];
  for (const res of resolutions) {
    const c = conflicts.find((x) => x.conflictId === res.conflictId);
    if (!c) continue;
    applyResolution(merged, c, res.pick);
    appliedResolutions.push(res.conflictId);
  }

  const result = { events: merged, conflicts, edgeProvenance, appliedResolutions };
  return refreshDerived(result, null);
}
