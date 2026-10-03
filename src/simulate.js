// Pure, deterministic charging simulation.
// Given a config and a set of business events (each with a business timestamp
// `ts` in minutes and a monotonic `seq`), replays them in (ts, seq) order and
// produces the charging timeline, the waiting queue and quota usage.
//
// Rules implemented here:
//  - a charging pile serves at most one session at a time (mutual exclusion);
//  - the sum of active session power never exceeds the site power quota;
//  - a tenant may not charge more than `dailyMinutes` per day (1440 min);
//  - an emergency event preempts a running non-emergency session; the
//    preempted vehicle keeps the energy already charged and re-enters the
//    waiting queue keeping its original enqueue time (aging);
//  - the waiting queue is dispatched by (priority, enqueue time, seq), so the
//    longest-waiting vehicle is served first ("aging").

export const MINUTES_PER_DAY = 1440;

const dayOf = (ts) => Math.floor(ts / MINUTES_PER_DAY);

export function simulate(config, events) {
  const sitePowerKw = config.sitePowerKw;
  const piles = config.piles.map((p) => ({ id: p.id, powerKw: p.powerKw, session: null }));
  const vehicles = new Map(config.vehicles.map((v) => [v.id, v]));
  const tenantCaps = new Map((config.tenants ?? []).map((t) => [t.id, t.dailyMinutes]));

  const usage = new Map(); // `${tenantId}@${day}` -> minutes
  const timeline = [];
  const queue = []; // waiting entries
  const active = new Map(); // vehicleId -> session
  const requests = new Map(); // vehicleId -> remaining requested minutes
  const simErrors = [];
  let peakPowerKw = 0;

  const usageKey = (tenantId, ts) => `${tenantId}@${dayOf(ts)}`;
  const usedMinutes = (tenantId, ts) => usage.get(usageKey(tenantId, ts)) ?? 0;
  const tenantRemaining = (tenantId, ts) => {
    const cap = tenantCaps.get(tenantId);
    if (cap == null) return Infinity;
    return Math.max(0, cap - usedMinutes(tenantId, ts));
  };
  const activePowerKw = () => {
    let sum = 0;
    for (const s of active.values()) sum += s.powerKw;
    return sum;
  };

  function recordUsage(tenantId, ts, minutes) {
    const key = usageKey(tenantId, ts);
    usage.set(key, (usage.get(key) ?? 0) + minutes);
  }

  function startSession(entry, pile, ts) {
    const vehicle = vehicles.get(entry.vehicleId);
    const minutes = Math.min(entry.remaining, tenantRemaining(vehicle.tenantId, ts));
    const session = {
      vehicleId: entry.vehicleId,
      pileId: pile.id,
      start: ts,
      plannedEnd: ts + minutes,
      powerKw: entry.powerKw ?? vehicle.powerKw,
      enqueuedTs: entry.enqueuedTs,
      seq: entry.seq,
      emergency: entry.priority > 0,
    };
    active.set(entry.vehicleId, session);
    pile.session = session;
    peakPowerKw = Math.max(peakPowerKw, activePowerKw());
  }

  function finalizeSession(vehicleId, endTs, reason) {
    const session = active.get(vehicleId);
    if (!session) return;
    const vehicle = vehicles.get(vehicleId);
    const minutes = endTs - session.start;
    const kwh = (minutes / 60) * session.powerKw;
    timeline.push({
      vehicleId,
      tenantId: vehicle.tenantId,
      pileId: session.pileId,
      start: session.start,
      end: endTs,
      minutes,
      kwh,
      reason,
    });
    recordUsage(vehicle.tenantId, session.start, minutes);
    active.delete(vehicleId);
    piles.find((p) => p.id === session.pileId).session = null;
    const remaining = (requests.get(vehicleId) ?? 0) - minutes;
    if (reason === 'preempted' && remaining > 0) {
      // Keep the already-charged amount, re-enter the waiting queue with the
      // original enqueue time so aging decides the next order.
      requests.set(vehicleId, remaining);
      queue.push({
        vehicleId,
        remaining,
        enqueuedTs: session.enqueuedTs,
        priority: 0,
        seq: session.seq,
        powerKw: session.powerKw,
      });
    } else {
      requests.delete(vehicleId);
    }
  }

  const compareEntries = (a, b) =>
    b.priority - a.priority || a.enqueuedTs - b.enqueuedTs || a.seq - b.seq;

  function dispatch(ts) {
    queue.sort(compareEntries);
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      const vehicle = vehicles.get(entry.vehicleId);
      const powerKw = entry.powerKw ?? vehicle.powerKw;
      if (tenantRemaining(vehicle.tenantId, ts) <= 0) continue;
      const pile = piles.find((p) => !p.session && p.powerKw >= powerKw);
      if (!pile) continue;
      if (activePowerKw() + powerKw > sitePowerKw) continue;
      queue.splice(i, 1);
      i--;
      startSession(entry, pile, ts);
    }
  }

  function processCompletionsUpTo(ts) {
    for (;;) {
      let next = null;
      for (const s of active.values()) {
        if (s.plannedEnd > ts) continue;
        if (
          !next ||
          s.plannedEnd < next.plannedEnd ||
          (s.plannedEnd === next.plannedEnd && s.vehicleId < next.vehicleId)
        ) {
          next = s;
        }
      }
      if (!next) break;
      finalizeSession(next.vehicleId, next.plannedEnd, 'completed');
      dispatch(next.plannedEnd);
    }
  }

  function handleRequest(event) {
    if (requests.has(event.vehicleId)) {
      simErrors.push({ seq: event.seq, reason: 'duplicate-request', vehicleId: event.vehicleId });
      return;
    }
    requests.set(event.vehicleId, event.minutes);
    queue.push({
      vehicleId: event.vehicleId,
      remaining: event.minutes,
      enqueuedTs: event.ts,
      priority: 0,
      seq: event.seq,
      powerKw: event.powerKw,
    });
    dispatch(event.ts);
  }

  function handleRelease(event) {
    if (active.has(event.vehicleId)) {
      finalizeSession(event.vehicleId, event.ts, 'released');
      requests.delete(event.vehicleId);
      dispatch(event.ts);
      return;
    }
    const idx = queue.findIndex((e) => e.vehicleId === event.vehicleId);
    if (idx >= 0) {
      queue.splice(idx, 1);
      requests.delete(event.vehicleId);
      return;
    }
    simErrors.push({ seq: event.seq, reason: 'release-without-request', vehicleId: event.vehicleId });
  }

  function handleEmergency(event) {
    const ts = event.ts;
    const vehicle = vehicles.get(event.vehicleId);
    const powerKw = event.powerKw ?? vehicle.powerKw;
    requests.set(event.vehicleId, event.minutes);
    const entry = {
      vehicleId: event.vehicleId,
      remaining: event.minutes,
      enqueuedTs: ts,
      priority: 1,
      seq: event.seq,
      powerKw,
    };
    const quota = tenantRemaining(vehicle.tenantId, ts);
    const freePile = piles.find((p) => !p.session && p.powerKw >= powerKw);
    if (quota > 0 && freePile && activePowerKw() + powerKw <= sitePowerKw) {
      startSession(entry, freePile, ts);
      return;
    }
    // Preempt the most recently started non-emergency session on a pile that
    // can serve this vehicle, keeping the site power quota satisfied.
    const candidates = [...active.values()]
      .filter((s) => !s.emergency)
      .filter((s) => piles.find((p) => p.id === s.pileId).powerKw >= powerKw)
      .filter((s) => activePowerKw() - s.powerKw + powerKw <= sitePowerKw)
      .sort((a, b) => b.start - a.start || (a.vehicleId < b.vehicleId ? -1 : 1));
    if (quota > 0 && candidates.length > 0) {
      const victim = candidates[0];
      finalizeSession(victim.vehicleId, ts, 'preempted');
      startSession(entry, piles.find((p) => p.id === victim.pileId), ts);
      return;
    }
    queue.push(entry);
  }

  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  for (const event of sorted) {
    processCompletionsUpTo(event.ts);
    switch (event.type) {
      case 'request':
        handleRequest(event);
        break;
      case 'release':
        handleRelease(event);
        break;
      case 'emergency':
        handleEmergency(event);
        break;
      default:
        simErrors.push({ seq: event.seq, reason: 'unknown-event-type' });
    }
  }
  processCompletionsUpTo(Infinity);

  return {
    timeline,
    waiting: queue.map((e) => ({
      vehicleId: e.vehicleId,
      remainingMinutes: e.remaining,
      enqueuedTs: e.enqueuedTs,
      priority: e.priority,
    })),
    peakPowerKw,
    usage: [...usage.entries()].map(([key, minutes]) => {
      const at = key.lastIndexOf('@');
      return { tenantId: key.slice(0, at), day: Number(key.slice(at + 1)), minutes };
    }),
    simErrors,
  };
}
