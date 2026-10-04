import { SCALAR_FIELDS } from './event.js';
import { canonical, deepEqual } from './canonical.js';
import { compareIdsByKey, dependentsIndex, computeBlocked } from './graph.js';

// Independent checker: replays a topo certificate against the merged graph.
// Verifies full event coverage, per-edge ordering, exact candidate sets and
// the minimal (ts, id) choice at every step.
export function checkCertificate(events, certificate) {
  const errors = [];
  if (!certificate) return { ok: false, errors: [{ type: 'NO_CERTIFICATE' }] };
  const order = certificate.order ?? [];
  if (new Set(order).size !== order.length) errors.push({ type: 'DUPLICATE_IN_ORDER' });
  const missing = [...events.keys()].filter((id) => !order.includes(id));
  const extra = order.filter((id) => !events.has(id));
  if (missing.length) errors.push({ type: 'MISSING_EVENTS', ids: missing });
  if (extra.length) errors.push({ type: 'EXTRA_EVENTS', ids: extra });

  const pos = new Map(order.map((id, i) => [id, i]));
  for (const e of events.values()) {
    for (const d of e.dependsOn) {
      if (pos.has(d) && pos.has(e.id) && !(pos.get(d) < pos.get(e.id))) {
        errors.push({ type: 'EDGE_ORDER', event: e.id, dependsOn: d });
      }
    }
  }

  const dependents = dependentsIndex(events);
  const indeg = new Map();
  for (const [id, e] of events) indeg.set(id, e.dependsOn.filter((d) => events.has(d)).length);
  let avail = [...events.keys()].filter((id) => indeg.get(id) === 0);
  const steps = certificate.steps ?? [];
  for (const step of steps) {
    const expectAvail = [...avail].sort((a, b) => compareIdsByKey(events, a, b));
    if (canonical(step.candidates ?? []) !== canonical(expectAvail)) {
      errors.push({ type: 'CANDIDATE_SET', chosen: step.chosen, expected: expectAvail, got: step.candidates });
    }
    if (expectAvail.length && step.chosen !== expectAvail[0]) {
      errors.push({ type: 'NOT_MINIMAL_CHOICE', chosen: step.chosen, expected: expectAvail[0] });
    }
    if (!avail.includes(step.chosen)) {
      errors.push({ type: 'UNAVAILABLE_CHOICE', chosen: step.chosen });
      continue;
    }
    avail = avail.filter((id) => id !== step.chosen);
    for (const n of dependents.get(step.chosen) ?? []) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) avail.push(n);
    }
  }
  if (steps.length !== events.size) errors.push({ type: 'INCOMPLETE_CERTIFICATE', steps: steps.length, events: events.size });
  return { ok: errors.length === 0, errors };
}

function otherChanged(side, base) {
  return (
    SCALAR_FIELDS.some((f) => f !== 'deleted' && !deepEqual(side[f], base[f])) ||
    !deepEqual(side.dependsOn, base.dependsOn)
  );
}

// Independent per-field recompute of the expected conflict set.
export function independentConflicts(base, local, remote) {
  const conflicts = [];
  const ids = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort();
  for (const id of ids) {
    const b = base.get(id) ?? null;
    const l = local.get(id) ?? b;
    const r = remote.get(id) ?? b;
    if (!b) {
      const lr = local.get(id);
      const rr = remote.get(id);
      if (lr && rr && !deepEqual(lr, rr)) {
        for (const f of SCALAR_FIELDS) {
          if (!deepEqual(lr[f], rr[f])) conflicts.push({ type: 'FIELD', eventId: id, field: f, base: null, local: lr[f], remote: rr[f] });
        }
      }
      continue;
    }
    const lcd = l.deleted !== b.deleted;
    const rcd = r.deleted !== b.deleted;
    if (lcd !== rcd && (lcd ? otherChanged(r, b) : otherChanged(l, b))) {
      conflicts.push({ type: 'DELETE_UPDATE', eventId: id, deleteSide: lcd ? 'local' : 'remote', base: b, local: l, remote: r });
      continue;
    }
    for (const f of SCALAR_FIELDS) {
      if (!deepEqual(l[f], r[f]) && !deepEqual(l[f], b[f]) && !deepEqual(r[f], b[f])) {
        conflicts.push({ type: 'FIELD', eventId: id, field: f, base: b[f], local: l[f], remote: r[f] });
      }
    }
  }
  return conflicts;
}

// Verifies a merge report (events + conflicts + cycle + blocked) against the
// three source branches, recomputing everything independently.
export function checkMergeReport(base, local, remote, report) {
  const errors = [];

  const expected = independentConflicts(base, local, remote);
  const got = report.conflicts ?? [];
  const key = (c) => `${c.type}|${c.eventId}|${c.field ?? ''}`;
  const expMap = new Map(expected.map((c) => [key(c), c]));
  const gotMap = new Map(got.map((c) => [key(c), c]));
  for (const [k, c] of expMap) {
    const g = gotMap.get(k);
    if (!g) errors.push({ type: 'CONFLICT_MISSING', key: k });
    else if (!deepEqual(c.local, g.local) || !deepEqual(c.remote, g.remote) || !deepEqual(c.base ?? null, g.base ?? null)) {
      errors.push({ type: 'CONFLICT_PROVENANCE', key: k });
    }
  }
  for (const k of gotMap.keys()) {
    if (!expMap.has(k)) errors.push({ type: 'CONFLICT_SPURIOUS', key: k });
  }

  const blockedExpected = computeBlocked(report.events);
  if (canonical(blockedExpected) !== canonical(report.blocked ?? [])) {
    errors.push({ type: 'BLOCKED_MISMATCH', expected: blockedExpected, got: report.blocked });
  }

  if (report.cycle) {
    const nodes = report.cycle.nodes;
    if (nodes[0] !== nodes[nodes.length - 1]) errors.push({ type: 'CYCLE_NOT_CLOSED' });
    for (const edge of report.cycle.edges) {
      const ev = report.events.get(edge.event);
      if (!ev || !ev.dependsOn.includes(edge.dependsOn)) {
        errors.push({ type: 'CYCLE_EDGE_NOT_IN_GRAPH', edge });
        continue;
      }
      const expectedBranches = ['base', 'local', 'remote'].filter((name) => {
        const br = name === 'base' ? base : name === 'local' ? local : remote;
        return br.get(edge.event)?.dependsOn.includes(edge.dependsOn) ?? false;
      });
      if (canonical(expectedBranches) !== canonical(edge.branches)) {
        errors.push({ type: 'CYCLE_EDGE_PROVENANCE', edge, expectedBranches });
      }
    }
  } else {
    const cert = checkCertificate(report.events, report.certificate);
    if (!cert.ok) errors.push({ type: 'CERTIFICATE', errors: cert.errors });
  }

  return { ok: errors.length === 0, errors };
}
