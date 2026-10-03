// FleetEngine: event-sourced facade over the pure simulation.
//
// Events may arrive out of order; every accepted event is stored and the full
// history is deterministically re-simulated in (ts, seq) order, so the final
// merged result is independent of arrival order.
//
// Settlement / cut-off semantics:
//  - `settle(cutoffTs)` publishes the bills for all sessions ending at or
//    before `cutoffTs`.
//  - A late event (business ts <= cutoff) that arrives at or before the
//    cut-off is still accepted: the history is recomputed and, if the settled
//    bills change, a reversal certificate (冲正证书) with the per-tenant diff
//    is emitted and the settled bills are updated.
//  - A late event that arrives after the cut-off is only registered in the
//    rejection list; settled results never change.
//
// Validation errors (reported, event not stored):
//  - duplicate-event: same `seq` seen twice;
//  - unknown-vehicle: vehicle not in the config;
//  - power-exceeded: requested power above the site quota or every pile.

import { simulate, MINUTES_PER_DAY } from './simulate.js';

export class FleetEngine {
  constructor(config) {
    validateConfig(config);
    this.config = config;
    this.vehicleById = new Map(config.vehicles.map((v) => [v.id, v]));
    this.events = new Map(); // seq -> event
    this.errors = [];
    this.rejections = [];
    this.reversals = [];
    this.cutoff = null;
    this.settledBills = null;
    this.result = simulate(config, []);
  }

  validateEvent(event) {
    if (!event || typeof event !== 'object') return 'malformed-event';
    if (!Number.isFinite(event.seq)) return 'missing-seq';
    if (!Number.isFinite(event.ts)) return 'missing-ts';
    if (!['request', 'release', 'emergency'].includes(event.type)) return 'unknown-event-type';
    if (!this.vehicleById.has(event.vehicleId)) return 'unknown-vehicle';
    if (this.events.has(event.seq)) return 'duplicate-event';
    if (event.type === 'request' || event.type === 'emergency') {
      if (!Number.isFinite(event.minutes) || event.minutes <= 0) return 'invalid-minutes';
      const vehicle = this.vehicleById.get(event.vehicleId);
      const powerKw = event.powerKw ?? vehicle.powerKw;
      const maxPileKw = Math.max(...this.config.piles.map((p) => p.powerKw));
      if (powerKw > this.config.sitePowerKw || powerKw > maxPileKw) return 'power-exceeded';
    }
    return null;
  }

  ingest(event, arrivalTs = event?.ts) {
    const reason = this.validateEvent(event);
    if (reason) {
      this.errors.push({ seq: event?.seq ?? null, reason, event });
      return { status: 'error', reason };
    }
    if (this.cutoff != null && event.ts <= this.cutoff && arrivalTs > this.cutoff) {
      this.rejections.push({
        seq: event.seq,
        reason: 'arrived-after-cutoff',
        eventTs: event.ts,
        arrivalTs,
        cutoff: this.cutoff,
      });
      return { status: 'rejected', reason: 'arrived-after-cutoff' };
    }
    this.events.set(event.seq, event);
    this.recompute(event, arrivalTs);
    return { status: 'applied' };
  }

  recompute(triggerEvent, arrivalTs) {
    this.result = simulate(this.config, [...this.events.values()]);
    if (this.settledBills) {
      const bills = this.bills(this.cutoff);
      const diffs = diffBills(this.settledBills, bills);
      if (diffs.length > 0) {
        this.reversals.push({
          id: `REV-${this.reversals.length + 1}`,
          triggerSeq: triggerEvent.seq,
          generatedAt: arrivalTs,
          cutoff: this.cutoff,
          diffs,
        });
        this.settledBills = bills;
      }
    }
  }

  settle(cutoffTs) {
    this.cutoff = cutoffTs;
    this.settledBills = this.bills(cutoffTs);
    return this.settledBills;
  }

  // Bills: per tenant per day, only sessions finished at or before `cutoffTs`.
  bills(cutoffTs) {
    const acc = new Map();
    for (const s of this.result.timeline) {
      if (s.end > cutoffTs) continue;
      const day = Math.floor(s.start / MINUTES_PER_DAY);
      const key = `${s.tenantId}@${day}`;
      const b = acc.get(key) ?? { tenantId: s.tenantId, day, minutes: 0, kwh: 0 };
      b.minutes += s.minutes;
      b.kwh += s.kwh;
      acc.set(key, b);
    }
    return [...acc.values()].sort(
      (a, b) => a.tenantId.localeCompare(b.tenantId) || a.day - b.day,
    );
  }

  report() {
    const tenantCaps = new Map((this.config.tenants ?? []).map((t) => [t.id, t.dailyMinutes]));
    const tenants = this.result.usage
      .map((u) => {
        const cap = tenantCaps.get(u.tenantId) ?? null;
        return {
          tenantId: u.tenantId,
          day: u.day,
          usedMinutes: u.minutes,
          capMinutes: cap,
          remainingMinutes: cap == null ? null : Math.max(0, cap - u.minutes),
        };
      })
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.day - b.day);
    return {
      timeline: this.result.timeline,
      waiting: this.result.waiting,
      quotas: {
        site: { quotaKw: this.config.sitePowerKw, peakPowerKw: this.result.peakPowerKw },
        tenants,
      },
      bills: this.settledBills,
      reversals: this.reversals,
      rejections: this.rejections,
      errors: [...this.errors, ...this.result.simErrors].sort(
        (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
      ),
    };
  }
}

function diffBills(before, after) {
  const key = (b) => `${b.tenantId}@${b.day}`;
  const beforeMap = new Map(before.map((b) => [key(b), b]));
  const afterMap = new Map(after.map((b) => [key(b), b]));
  const diffs = [];
  for (const k of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const b = beforeMap.get(k) ?? { minutes: 0, kwh: 0 };
    const a = afterMap.get(k) ?? { minutes: 0, kwh: 0 };
    if (b.minutes !== a.minutes || b.kwh !== a.kwh) {
      const [tenantId, day] = k.split('@');
      diffs.push({
        tenantId,
        day: Number(day),
        beforeMinutes: b.minutes,
        afterMinutes: a.minutes,
        deltaMinutes: a.minutes - b.minutes,
        beforeKwh: b.kwh,
        afterKwh: a.kwh,
        deltaKwh: a.kwh - b.kwh,
      });
    }
  }
  return diffs.sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.day - b.day);
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('config must be an object');
  if (!Number.isFinite(config.sitePowerKw) || config.sitePowerKw <= 0) {
    throw new Error('config.sitePowerKw must be a positive number');
  }
  if (!Array.isArray(config.piles) || config.piles.length === 0) {
    throw new Error('config.piles must be a non-empty array');
  }
  const pileIds = new Set();
  for (const p of config.piles) {
    if (!p.id || !Number.isFinite(p.powerKw) || p.powerKw <= 0) {
      throw new Error(`invalid pile: ${JSON.stringify(p)}`);
    }
    if (pileIds.has(p.id)) throw new Error(`duplicate pile id: ${p.id}`);
    pileIds.add(p.id);
  }
  const tenantIds = new Set((config.tenants ?? []).map((t) => t.id));
  if (tenantIds.size !== (config.tenants ?? []).length) {
    throw new Error('duplicate tenant id');
  }
  const vehicleIds = new Set();
  for (const v of config.vehicles ?? []) {
    if (!v.id || !Number.isFinite(v.powerKw) || v.powerKw <= 0) {
      throw new Error(`invalid vehicle: ${JSON.stringify(v)}`);
    }
    if (vehicleIds.has(v.id)) throw new Error(`duplicate vehicle id: ${v.id}`);
    vehicleIds.add(v.id);
    if (!tenantIds.has(v.tenantId)) throw new Error(`vehicle ${v.id}: unknown tenant`);
    if (v.powerKw > config.sitePowerKw) {
      throw new Error(`vehicle ${v.id}: powerKw exceeds site quota`);
    }
  }
}
