import { GateError, EXIT } from './errors.js';
import { effectivePermission } from './config.js';
import { stateHash } from './serialize.js';

const DAY_MS = 24 * 3600 * 1000;

const iso = (t) => new Date(t).toISOString();

// Builds the next-day queue. Shifts with end <= start wrap past midnight.
export function buildSchedule(idx, state, runDate) {
  const dayStart = Date.parse(`${runDate}T00:00:00Z`);
  if (Number.isNaN(dayStart)) {
    throw new GateError(`invalid run date "${runDate}"`, EXIT.USAGE);
  }
  const shifts = idx.shifts.map((s) => {
    const start = dayStart + s.startMin * 60000;
    let end = dayStart + s.endMin * 60000;
    if (s.endMin <= s.startMin) end += DAY_MS;
    return { name: s.name, start, end, orders: [], usage: {} };
  });

  const breaches = [];
  const ready = [];
  for (const [id, order] of Object.entries(state.orders)) {
    const perm = effectivePermission(idx, id);
    if (order.decision === 'released' && perm !== 'allow') {
      breaches.push({ order: id, reason: 'permission-denied', permission: perm });
    }
    if (
      order.decision === 'frozen' &&
      order.candidates.some((c) => c.type === 'release' && !state.revoked[c.seq])
    ) {
      breaches.push({ order: id, reason: 'frozen' });
    }
    if (order.decision !== 'released' || perm !== 'allow') continue;
    const spec = idx.orders.get(id);
    const locked = Object.entries(spec.materials).every(
      ([m, q]) => (order.locks[m] ?? 0) >= q,
    );
    if (!locked) continue; // material-shortage already recorded during the fold
    ready.push({ id, order, spec });
  }

  ready.sort((a, b) => {
    const pa = -(a.order.decisionEvent?.priority ?? 0);
    const pb = -(b.order.decisionEvent?.priority ?? 0);
    if (pa !== pb) return pa - pb;
    return (a.order.decisionEvent?.seq ?? 0) - (b.order.decisionEvent?.seq ?? 0);
  });

  for (const { id, order, spec } of ready) {
    const earliest = order.scheduledTo ?? shifts[0].start;
    let placed = false;
    for (const shift of shifts) {
      if (shift.end <= earliest) continue;
      const center = idx.centers.get(spec.centerId);
      const cap = spec.capability;
      const limit = cap ? (center.capabilities[cap] ?? 0) : Infinity;
      const used = shift.usage[spec.centerId]?.[cap] ?? 0;
      if (used >= limit) continue;
      const start = Math.max(shift.start, earliest);
      const end = start + spec.durationMin * 60000;
      shift.usage[spec.centerId] ??= {};
      shift.usage[spec.centerId][cap] = used + 1;
      shift.orders.push({
        order: id,
        workCenter: spec.centerId,
        capability: cap,
        start: iso(start),
        end: iso(end),
        crossesMidnight:
          Math.floor(start / DAY_MS) !== Math.floor((end - 1) / DAY_MS),
      });
      placed = true;
      break;
    }
    if (!placed) breaches.push({ order: id, reason: 'capacity-exceeded' });
  }

  const hash = stateHash(state);
  return {
    schedule: {
      date: runDate,
      generatedFromEvents: state.seq,
      stateHash: hash,
      shifts: shifts.map((s) => ({
        name: s.name,
        start: iso(s.start),
        end: iso(s.end),
        orders: s.orders,
      })),
    },
    breaches: [...state.breaches, ...breaches],
  };
}
