// Stateful fleet gateway: validates and ingests vehicle events in arrival
// order, recomputes the schedule on every accepted event, issues reversal
// (冲正) certificates when recomputation changes bills, and rejects anything
// arriving after the settlement cutoff without touching settled bills.

import { simulate, round6 } from './engine.js';

export function validateEvent(event, config, seenIds, seenSeq) {
  if (!event || typeof event !== 'object') return 'invalid_shape';
  if (typeof event.eventId !== 'string' || !event.eventId) return 'invalid_shape';
  if (seenIds.has(event.eventId)) return 'duplicate_event';
  if (typeof event.vehicleId !== 'string' || !config.vehicles?.[event.vehicleId]) {
    return 'unknown_vehicle';
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) return 'invalid_shape';
  if (seenSeq.get(event.vehicleId)?.has(event.seq)) return 'duplicate_event';
  if (!Number.isFinite(event.ts) || event.ts < 0) return 'invalid_shape';
  if (event.type === 'charge_request') {
    if (!Number.isInteger(event.minutes) || event.minutes <= 0) return 'invalid_shape';
    if (typeof event.powerKw !== 'number' || !(event.powerKw > 0)) return 'invalid_shape';
    const maxChargerKw = Math.max(...(config.chargers ?? []).map((c) => c.maxPowerKw));
    if (event.powerKw > config.sitePowerKw || event.powerKw > maxChargerKw) return 'excess_power';
    const tenantId = config.vehicles[event.vehicleId].tenantId;
    if (!config.tenants?.[tenantId]) return 'unknown_tenant';
    if (event.priority != null && !['normal', 'emergency'].includes(event.priority)) {
      return 'invalid_shape';
    }
  } else if (event.type !== 'charge_release') {
    return 'invalid_shape';
  }
  return null;
}

export function diffBills(prev, next) {
  const diffs = [];
  const scopes = [
    ['vehicle', prev.vehicles ?? {}, next.vehicles ?? {}],
    ['tenant', prev.tenants ?? {}, next.tenants ?? {}],
  ];
  for (const [scope, a, b] of scopes) {
    const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const id of ids) {
      for (const field of ['minutes', 'energyKwh']) {
        const before = a[id]?.[field] ?? 0;
        const after = b[id]?.[field] ?? 0;
        if (Math.abs(after - before) > 1e-9) {
          diffs.push({ scope, id, field, before, after, delta: round6(after - before) });
        }
      }
    }
  }
  return diffs;
}

export class Fleet {
  constructor(config) {
    this.config = config;
    this.cutoffTs = config.cutoffTs ?? Number.POSITIVE_INFINITY;
    this.events = []; // accepted events, in arrival order
    this.seenIds = new Set();
    this.seenSeq = new Map(); // vehicleId -> Set(seq)
    this.rejections = []; // ingest-stage rejections
    this.reversals = []; // reversal certificates
    this.result = simulate([], config);
  }

  ingest(event, arrivalTs = event?.arrivalTs ?? 0) {
    const reason = validateEvent(event, this.config, this.seenIds, this.seenSeq);
    if (reason) {
      this.rejections.push({ stage: 'ingest', eventId: event?.eventId ?? null, arrivalTs, reason });
      return { status: 'rejected', reason };
    }
    if (arrivalTs > this.cutoffTs) {
      // After the settlement cutoff: register the rejection only; settled
      // bills must not change.
      this.rejections.push({ stage: 'ingest', eventId: event.eventId, arrivalTs, reason: 'after_cutoff' });
      return { status: 'rejected', reason: 'after_cutoff' };
    }
    this.seenIds.add(event.eventId);
    if (!this.seenSeq.has(event.vehicleId)) this.seenSeq.set(event.vehicleId, new Set());
    this.seenSeq.get(event.vehicleId).add(event.seq);
    this.events.push(event);

    const next = simulate(this.events, this.config);
    const diffs = diffBills(this.result.bills, next.bills);
    if (diffs.length) {
      this.reversals.push({
        certificateId: `REV-${this.reversals.length + 1}`,
        triggerEventId: event.eventId,
        arrivalTs,
        diffs,
      });
    }
    this.result = next;
    return { status: 'accepted' };
  }

  report() {
    return {
      timeline: this.result.timeline,
      bills: this.result.bills,
      quotas: this.result.quotas,
      unscheduled: this.result.unscheduled,
      reversals: this.reversals,
      rejections: [
        ...this.rejections,
        ...this.result.rejections.map((r) => ({ stage: 'engine', ...r })),
      ],
    };
  }
}
