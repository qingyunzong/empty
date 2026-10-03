// Independent checker. Re-derives conflicts with a self-contained field-wise
// merge and replays the topology certificate round by round. Deliberately
// does not reuse the merger's code paths.

import { deepEqual, compareIds } from './util.js';
import { SCALAR_FIELDS } from './events.js';

const eq = (a, b) => deepEqual(a, b);

// Self-contained conflict recomputation from the three input branches.
export function independentConflicts(base = {}, local = {}, remote = {}) {
  const conflicts = new Map();
  const ids = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();
  for (const id of ids) {
    const b = base[id] ?? null, l = local[id] ?? null, r = remote[id] ?? null;
    const ver = (bv, lv, rv) => ({ base: bv ?? null, local: lv ?? null, remote: rv ?? null });

    if (!b) {
      if (l && r) {
        for (const f of SCALAR_FIELDS) {
          if (!eq(l[f], r[f])) {
            const cid = `field:${id}:${f}`;
            conflicts.set(cid, { id: cid, type: 'FIELD', eventId: id, fields: { [f]: ver(null, l[f], r[f]) } });
          }
        }
      }
      continue;
    }
    if (!l || !r) {
      if (!l && !r) continue;
      const survivor = l ?? r;
      if (eq(survivor, b)) continue;
      const cid = `delete-update:${id}`;
      conflicts.set(cid, {
        id: cid, type: 'DELETE_UPDATE', eventId: id, removal: true,
        deletingSide: l ? 'remote' : 'local',
        fields: { presence: { base: 'present', local: l ? 'present' : 'absent', remote: r ? 'present' : 'absent' } },
      });
      continue;
    }

    const lDel = l.deleted === true && b.deleted === false;
    const rDel = r.deleted === true && b.deleted === false;
    const otherChanged = (x) => SCALAR_FIELDS.some((f) => f !== 'deleted' && !eq(x[f], b[f]))
      || !eq(x.dependsOn, b.dependsOn);
    const duSide = lDel && !rDel && otherChanged(r) ? 'local'
      : rDel && !lDel && otherChanged(l) ? 'remote'
        : null;

    if (duSide) {
      const fields = {};
      const contested = new Set(['deleted']);
      for (const f of SCALAR_FIELDS) {
        if (f !== 'deleted' && (!eq(l[f], b[f]) || !eq(r[f], b[f]))) contested.add(f);
      }
      for (const f of contested) fields[f] = ver(b[f], l[f], r[f]);
      if (!eq(l.dependsOn, b.dependsOn) || !eq(r.dependsOn, b.dependsOn)) {
        fields.dependsOn = ver(b.dependsOn, l.dependsOn, r.dependsOn);
      }
      const cid = `delete-update:${id}`;
      conflicts.set(cid, { id: cid, type: 'DELETE_UPDATE', eventId: id, deletingSide: duSide, fields });
    } else {
      for (const f of SCALAR_FIELDS) {
        if (!eq(l[f], r[f]) && !eq(b[f], l[f]) && !eq(b[f], r[f])) {
          const cid = `field:${id}:${f}`;
          conflicts.set(cid, { id: cid, type: 'FIELD', eventId: id, fields: { [f]: ver(b[f], l[f], r[f]) } });
        }
      }
    }
  }
  return conflicts;
}

// Verifies a topology certificate against merged events and conflict
// provenance. Returns {ok, errors}.
export function checkCertificate({ base = {}, local = {}, remote = {}, events, certificate, conflicts }) {
  const errors = [];
  certificate = certificate ?? {};
  const ids = Object.keys(events).sort();

  // 1. The certificate covers exactly the merged event set.
  const orderIds = [...(certificate.order ?? [])].sort();
  if (!deepEqual(orderIds, ids)) {
    errors.push('CERT_EVENTS_MISMATCH: certificate order does not contain exactly all events');
  }
  const pos = new Map((certificate.order ?? []).map((id, i) => [id, i]));

  // 2. Every dependency edge is respected by the order.
  for (const [id, e] of Object.entries(events)) {
    for (const t of e.dependsOn) {
      if (!events[t]) {
        errors.push(`DANGLING_REF: ${id} depends on missing ${t}`);
      } else if (!(pos.get(t) < pos.get(id))) {
        errors.push(`EDGE_ORDER: dependency ${t} must precede ${id}`);
      }
    }
  }

  // 3. Replay rounds: candidate sets and minimal (ts, id) choice.
  const cmp = (a, b) => events[a].ts - events[b].ts || compareIds(a, b);
  const placed = new Set();
  const remaining = new Set(Object.keys(events));
  for (const round of certificate.rounds ?? []) {
    const expected = [...remaining]
      .filter((id) => events[id].dependsOn.every((t) => !events[t] || placed.has(t)))
      .sort(cmp);
    if (!deepEqual(round.candidates, expected)) {
      errors.push(`ROUND_CANDIDATES: expected [${expected}] got [${round.candidates}]`);
    }
    if (round.chosen !== expected[0]) {
      errors.push(`ROUND_CHOICE: ${round.chosen} is not the (ts,id)-minimum candidate ${expected[0]}`);
    }
    placed.add(round.chosen);
    remaining.delete(round.chosen);
  }
  if (remaining.size > 0) errors.push(`ROUND_INCOMPLETE: ${remaining.size} events never placed`);

  // 4. Conflict provenance matches an independent field-wise merge.
  const expected = independentConflicts(base, local, remote);
  const actual = new Map((conflicts ?? []).map((c) => [c.id, c]));
  for (const [cid, c] of expected) {
    const a = actual.get(cid);
    if (!a) {
      errors.push(`CONFLICT_MISSING: ${cid}`);
      continue;
    }
    if (a.type !== c.type || !deepEqual(a.fields, c.fields)) {
      errors.push(`CONFLICT_PROVENANCE: ${cid} versions do not match independent merge`);
    }
    actual.delete(cid);
  }
  for (const cid of actual.keys()) errors.push(`CONFLICT_SPURIOUS: ${cid}`);

  return { ok: errors.length === 0, errors };
}
