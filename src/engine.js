// Core deterministic simulation engine.
//
// Semantics:
// - Events are merged by business timestamp (ts), then per-vehicle sequence
//   number (seq), then eventId. Arrival order never influences the result.
// - A charge segment reserves tenant quota minutes at start; unused reserved
//   minutes are returned when the segment ends early (preempt / release).
// - Emergency requests preempt the non-emergency active vehicle with the
//   largest remaining demand (tie-break: vehicleId) until they fit.
// - Preempted / tenant-capped vehicles keep charged energy and re-enter the
//   waiting queue preserving their original waitSince (aging): within the
//   same priority the longest-waiting vehicle is scheduled first.
// - Completions exactly at time T are processed before events at time T.

export const PRIORITY_RANK = { emergency: 1, normal: 0 };

export const round6 = (x) => Math.round(x * 1e6) / 1e6;

export function compareEvents(a, b) {
  return (
    a.ts - b.ts ||
    a.seq - b.seq ||
    (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)
  );
}

export function simulate(events, config) {
  const sorted = [...events].sort(compareEvents);
  const chargers = config.chargers ?? [];
  const sitePowerKw = config.sitePowerKw;
  const tenantCap = new Map(
    Object.entries(config.tenants ?? {}).map(([id, t]) => [id, t.dailyMinutesCap]),
  );
  const tenantCommitted = new Map([...tenantCap.keys()].map((id) => [id, 0]));
  const tenantSettled = new Map([...tenantCap.keys()].map((id) => [id, 0]));
  const vehicles = config.vehicles ?? {};

  const active = new Map(); // vehicleId -> segment state
  const waiting = []; // pending requests
  const segments = []; // completed timeline records
  const rejections = []; // engine-level rejections (deterministic)
  let now = 0;

  const tenantRemaining = (t) => (tenantCap.get(t) ?? 0) - (tenantCommitted.get(t) ?? 0);

  function freeChargers() {
    const busy = new Set([...active.values()].map((a) => a.chargerId));
    return chargers.filter((c) => !busy.has(c.id));
  }

  function availablePower() {
    let used = 0;
    for (const a of active.values()) used += a.powerKw;
    return sitePowerKw - used;
  }

  function canPlace(w) {
    return (
      tenantRemaining(w.tenantId) > 0 &&
      availablePower() >= w.powerKw &&
      freeChargers().some((c) => c.maxPowerKw >= w.powerKw)
    );
  }

  function closeActive(vehicleId, reason) {
    const a = active.get(vehicleId);
    active.delete(vehicleId);
    tenantCommitted.set(a.tenantId, tenantCommitted.get(a.tenantId) - a.plannedMin + a.chargedMin);
    tenantSettled.set(a.tenantId, tenantSettled.get(a.tenantId) + a.chargedMin);
    if (a.chargedMin > 0) {
      segments.push({
        vehicleId,
        chargerId: a.chargerId,
        startTs: a.startTs,
        endTs: now,
        minutes: a.chargedMin,
        powerKw: a.powerKw,
        energyKwh: round6((a.chargedMin * a.powerKw) / 60),
        endReason: reason,
      });
    }
    const remaining = a.remainingMin - a.chargedMin;
    if (remaining > 0 && reason !== 'released') {
      // Keep original waitSince so aging is preserved across preemption.
      waiting.push({
        vehicleId: a.vehicleId,
        tenantId: a.tenantId,
        remainingMin: remaining,
        powerKw: a.powerKw,
        priority: a.priority,
        waitSince: a.waitSince,
        seq: a.seq,
      });
    }
  }

  function preemptVictim() {
    const victims = [...active.values()].filter((a) => a.priority !== 'emergency');
    if (!victims.length) return false;
    victims.sort(
      (x, y) =>
        y.remainingMin - y.chargedMin - (x.remainingMin - x.chargedMin) ||
        (x.vehicleId < y.vehicleId ? -1 : 1),
    );
    closeActive(victims[0].vehicleId, 'preempted');
    return true;
  }

  function schedule() {
    for (;;) {
      const free = freeChargers();
      const avail = availablePower();
      const candidates = waiting.filter(
        (w) =>
          !active.has(w.vehicleId) &&
          tenantRemaining(w.tenantId) > 0 &&
          w.powerKw <= avail &&
          free.some((c) => c.maxPowerKw >= w.powerKw),
      );
      if (!candidates.length) return;
      candidates.sort(
        (x, y) =>
          (PRIORITY_RANK[y.priority] ?? 0) - (PRIORITY_RANK[x.priority] ?? 0) ||
          x.waitSince - y.waitSince ||
          x.seq - y.seq ||
          (x.vehicleId < y.vehicleId ? -1 : x.vehicleId > y.vehicleId ? 1 : 0),
      );
      const w = candidates[0];
      waiting.splice(waiting.indexOf(w), 1);
      const charger = free
        .filter((c) => c.maxPowerKw >= w.powerKw)
        .sort((a, b) => a.maxPowerKw - b.maxPowerKw || (a.id < b.id ? -1 : 1))[0];
      const plannedMin = Math.min(w.remainingMin, tenantRemaining(w.tenantId));
      tenantCommitted.set(w.tenantId, tenantCommitted.get(w.tenantId) + plannedMin);
      active.set(w.vehicleId, {
        ...w,
        chargerId: charger.id,
        startTs: now,
        plannedMin,
        chargedMin: 0,
      });
    }
  }

  function advance(toTs) {
    for (;;) {
      if (active.size === 0) {
        now = toTs;
        return;
      }
      let nextTs = toTs;
      let finishing = [];
      for (const [vid, a] of active) {
        const endTs = a.startTs + a.plannedMin;
        if (endTs < nextTs) {
          nextTs = endTs;
          finishing = [vid];
        } else if (endTs === nextTs) {
          finishing.push(vid);
        }
      }
      const dt = nextTs - now;
      if (dt > 0) for (const a of active.values()) a.chargedMin += dt;
      now = nextTs;
      if (!finishing.length) return; // reached toTs mid-segment
      finishing.sort();
      for (const vid of finishing) {
        const a = active.get(vid);
        closeActive(vid, a.chargedMin >= a.remainingMin ? 'completed' : 'tenant_cap');
      }
      schedule();
      if (now >= toTs) return;
    }
  }

  for (const ev of sorted) {
    advance(ev.ts);
    if (ev.type === 'charge_request') {
      const tenantId = vehicles[ev.vehicleId].tenantId;
      const entry = {
        vehicleId: ev.vehicleId,
        tenantId,
        remainingMin: ev.minutes,
        powerKw: ev.powerKw,
        priority: ev.priority ?? 'normal',
        waitSince: ev.ts,
        seq: ev.seq,
      };
      waiting.push(entry);
      if (entry.priority === 'emergency') {
        while (!canPlace(entry) && preemptVictim()) {
          // preempt normal-priority vehicles until the emergency fits
        }
      }
      schedule();
    } else if (ev.type === 'charge_release') {
      if (active.has(ev.vehicleId)) {
        closeActive(ev.vehicleId, 'released');
        schedule();
      } else {
        const idx = waiting.findIndex((w) => w.vehicleId === ev.vehicleId);
        if (idx >= 0) waiting.splice(idx, 1);
        else {
          rejections.push({
            eventId: ev.eventId,
            vehicleId: ev.vehicleId,
            ts: ev.ts,
            reason: 'release_without_charge',
          });
        }
      }
    }
  }
  advance(Number.POSITIVE_INFINITY); // drain remaining active charges

  segments.sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs || (a.vehicleId < b.vehicleId ? -1 : 1));

  const vehicleBills = {};
  for (const s of segments) {
    const b = (vehicleBills[s.vehicleId] ??= { minutes: 0, energyKwh: 0 });
    b.minutes += s.minutes;
    b.energyKwh = round6(b.energyKwh + s.energyKwh);
  }
  const tenantBills = {};
  for (const [tid, cap] of tenantCap) tenantBills[tid] = { minutes: 0, energyKwh: 0, capMinutes: cap };
  for (const s of segments) {
    const tid = vehicles[s.vehicleId].tenantId;
    tenantBills[tid].minutes += s.minutes;
    tenantBills[tid].energyKwh = round6(tenantBills[tid].energyKwh + s.energyKwh);
  }

  return {
    timeline: segments,
    bills: { vehicles: vehicleBills, tenants: tenantBills },
    quotas: tenantBills,
    rejections,
    unscheduled: waiting.map((w) => ({
      vehicleId: w.vehicleId,
      tenantId: w.tenantId,
      remainingMin: w.remainingMin,
      waitSince: w.waitSince,
    })),
  };
}
