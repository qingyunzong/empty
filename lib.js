'use strict';

const crypto = require('node:crypto');

class SettleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettleError';
    this.code = code;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hashObject(obj) {
  return crypto.createHash('sha256').update(canonical(obj)).digest('hex');
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function validateTiers(tiers, owner) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new SettleError('E_VALIDATION', `${owner}: tiers must be a non-empty array`);
  }
  let prev = -1;
  tiers.forEach((tier, i) => {
    if (!tier || typeof tier !== 'object') {
      throw new SettleError('E_VALIDATION', `${owner}: tier ${i} must be an object`);
    }
    if (!isNonNegInt(tier.rateBps)) {
      throw new SettleError('E_VALIDATION', `${owner}: tier ${i} rateBps must be a non-negative integer`);
    }
    const last = i === tiers.length - 1;
    if (last) {
      if (tier.upTo !== null) {
        throw new SettleError('E_VALIDATION', `${owner}: last tier upTo must be null`);
      }
    } else {
      if (!isNonNegInt(tier.upTo)) {
        throw new SettleError('E_VALIDATION', `${owner}: tier ${i} upTo must be a non-negative integer`);
      }
      if (tier.upTo <= prev) {
        throw new SettleError('E_VALIDATION', `${owner}: tier upTo values must be strictly increasing`);
      }
      prev = tier.upTo;
    }
  });
}

function validateEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new SettleError('E_VALIDATION', 'event must be an object');
  }
  if (!isNonEmptyString(ev.id)) {
    throw new SettleError('E_VALIDATION', 'event id must be a non-empty string');
  }
  switch (ev.type) {
    case 'charge':
      if (!isNonEmptyString(ev.merchantId)) throw new SettleError('E_VALIDATION', `charge ${ev.id}: merchantId required`);
      if (!isNonEmptyString(ev.productId)) throw new SettleError('E_VALIDATION', `charge ${ev.id}: productId required`);
      if (!isNonEmptyString(ev.period)) throw new SettleError('E_VALIDATION', `charge ${ev.id}: period required`);
      if (!isNonNegInt(ev.amount)) throw new SettleError('E_VALIDATION', `charge ${ev.id}: amount must be a non-negative integer`);
      break;
    case 'correct':
      if (!isNonEmptyString(ev.linksTo)) throw new SettleError('E_VALIDATION', `correct ${ev.id}: linksTo required`);
      if (!isNonNegInt(ev.amount)) throw new SettleError('E_VALIDATION', `correct ${ev.id}: amount must be a non-negative integer`);
      break;
    case 'snapshot':
      if (!isNonEmptyString(ev.merchantId)) throw new SettleError('E_VALIDATION', `snapshot ${ev.id}: merchantId required`);
      if (!isNonEmptyString(ev.period)) throw new SettleError('E_VALIDATION', `snapshot ${ev.id}: period required`);
      break;
    case 'rule':
      if (ev.scope !== 'product' && ev.scope !== 'merchant') {
        throw new SettleError('E_VALIDATION', `rule ${ev.id}: scope must be "product" or "merchant"`);
      }
      if (ev.scope === 'product' && !isNonEmptyString(ev.productId)) {
        throw new SettleError('E_VALIDATION', `rule ${ev.id}: productId required for product scope`);
      }
      if (ev.scope === 'merchant' && !isNonEmptyString(ev.merchantId)) {
        throw new SettleError('E_VALIDATION', `rule ${ev.id}: merchantId required for merchant scope`);
      }
      if (ev.period !== undefined && ev.period !== null && !isNonEmptyString(ev.period)) {
        throw new SettleError('E_VALIDATION', `rule ${ev.id}: period must be a non-empty string when present`);
      }
      validateTiers(ev.tiers, `rule ${ev.id}`);
      break;
    default:
      throw new SettleError('E_VALIDATION', `event ${ev.id}: unknown type ${JSON.stringify(ev.type)}`);
  }
}

function tierRateBps(tiers, volume) {
  for (const tier of tiers) {
    if (tier.upTo === null || volume <= tier.upTo) return tier.rateBps;
  }
  return tiers[tiers.length - 1].rateBps;
}

function compareRules(a, b) {
  const byRate = a.tiers[0].rateBps - b.tiers[0].rateBps;
  if (byRate !== 0) return byRate;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

// rules must be in definition (stream) order. Merchant-scope overrides
// product-scope; within a scope+key the most recently defined rule wins;
// remaining parallel candidates are tie-broken by rate asc, then ruleId asc.
function resolveRule(rules, merchantId, period, products) {
  const applicable = rules.filter((r) => r.period === undefined || r.period === null || r.period === period);
  const merchantRules = applicable.filter((r) => r.scope === 'merchant' && r.merchantId === merchantId);
  if (merchantRules.length > 0) return merchantRules[merchantRules.length - 1];
  const candidates = [];
  for (const product of products) {
    const productRules = applicable.filter((r) => r.scope === 'product' && r.productId === product);
    if (productRules.length > 0) candidates.push(productRules[productRules.length - 1]);
  }
  if (candidates.length === 0) return null;
  candidates.sort(compareRules);
  return candidates[0];
}

function computeSettlement(rules, merchantId, period, chargeRecs) {
  const products = [...new Set(chargeRecs.map((c) => c.productId))].sort();
  let volume = 0;
  for (const c of chargeRecs) volume += c.effective;
  const rule = resolveRule(rules, merchantId, period, products);
  const rateBps = rule ? tierRateBps(rule.tiers, volume) : 0;
  const rebate = Math.floor((volume * rateBps) / 10000);
  return { volume, ruleId: rule ? rule.id : null, rateBps, rebate };
}

function snapshotHash(merchantId, period, settlement, eventIds) {
  return hashObject({
    eventIds: [...eventIds].sort(),
    merchantId,
    period,
    rateBps: settlement.rateBps,
    rebate: settlement.rebate,
    ruleId: settlement.ruleId,
    volume: settlement.volume,
  });
}

function buildPeriodOutput(rules, bucket) {
  const chargeRecs = [...bucket.charges.values()];
  const current = computeSettlement(rules, bucket.merchantId, bucket.period, chargeRecs);
  const adjustments = chargeRecs
    .filter((c) => c.corrections.length > 0)
    .map((c) => ({
      chargeId: c.id,
      originalAmount: c.amount,
      effectiveAmount: c.effective,
      chain: c.corrections.map((k) => ({ id: k.id, amount: k.amount, delta: k.delta })),
    }))
    .sort((a, b) => (a.chargeId < b.chargeId ? -1 : a.chargeId > b.chargeId ? 1 : 0));
  const supplements = [];
  if (bucket.snapshot && bucket.postSnapshotIds.length > 0) {
    supplements.push({
      batchId: `SUPP-${bucket.snapshot.id}`,
      baseSnapshot: bucket.snapshot.id,
      baseHash: bucket.snapshot.hash,
      eventIds: [...bucket.postSnapshotIds],
      volume: current.volume,
      rebate: current.rebate,
      deltaVolume: current.volume - bucket.snapshot.volume,
      deltaRebate: current.rebate - bucket.snapshot.rebate,
    });
  }
  const settled = bucket.snapshot ? bucket.snapshot.rebate : current.rebate;
  return {
    merchantId: bucket.merchantId,
    period: bucket.period,
    ruleId: current.ruleId,
    rateBps: current.rateBps,
    volume: current.volume,
    rebate: settled,
    currentRebate: current.rebate,
    totalRebate: settled + supplements.reduce((acc, s) => acc + s.deltaRebate, 0),
    adjustments,
    snapshot: bucket.snapshot,
    supplements,
  };
}

function comparePeriods(a, b) {
  if (a.merchantId !== b.merchantId) return a.merchantId < b.merchantId ? -1 : 1;
  if (a.period !== b.period) return a.period < b.period ? -1 : 1;
  return 0;
}

function replay(events) {
  if (!Array.isArray(events)) throw new SettleError('E_VALIDATION', 'events must be an array');
  const ids = new Map();
  const rules = [];
  const buckets = new Map();
  const chargesById = new Map();

  const getBucket = (merchantId, period) => {
    const key = JSON.stringify([merchantId, period]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { merchantId, period, charges: new Map(), eventIds: [], postSnapshotIds: [], snapshot: null };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const ev of events) {
    validateEvent(ev);
    if (ids.has(ev.id)) throw new SettleError('E_VALIDATION', `duplicate event id: ${ev.id}`);
    ids.set(ev.id, ev.type);
    switch (ev.type) {
      case 'rule':
        rules.push(ev);
        break;
      case 'charge': {
        const bucket = getBucket(ev.merchantId, ev.period);
        const rec = { id: ev.id, productId: ev.productId, amount: ev.amount, effective: ev.amount, corrections: [] };
        bucket.charges.set(ev.id, rec);
        bucket.eventIds.push(ev.id);
        if (bucket.snapshot) bucket.postSnapshotIds.push(ev.id);
        chargesById.set(ev.id, { bucket, rec });
        break;
      }
      case 'correct': {
        const target = chargesById.get(ev.linksTo);
        if (!target) {
          throw new SettleError('E_LINK', `correct ${ev.id}: linksTo ${ev.linksTo} does not reference a prior charge event`);
        }
        const { bucket, rec } = target;
        const delta = ev.amount - rec.effective;
        rec.effective = ev.amount;
        rec.corrections.push({ id: ev.id, amount: ev.amount, delta });
        bucket.eventIds.push(ev.id);
        if (bucket.snapshot) bucket.postSnapshotIds.push(ev.id);
        break;
      }
      case 'snapshot': {
        const bucket = getBucket(ev.merchantId, ev.period);
        if (bucket.snapshot) {
          throw new SettleError('E_SNAPSHOT', `duplicate snapshot for merchant ${ev.merchantId} period ${ev.period}`);
        }
        const settlement = computeSettlement(rules, bucket.merchantId, bucket.period, [...bucket.charges.values()]);
        bucket.snapshot = {
          id: ev.id,
          hash: snapshotHash(bucket.merchantId, bucket.period, settlement, bucket.eventIds),
          volume: settlement.volume,
          rebate: settlement.rebate,
          ruleId: settlement.ruleId,
          rateBps: settlement.rateBps,
        };
        break;
      }
    }
  }

  const periods = [...buckets.values()].map((bucket) => buildPeriodOutput(rules, bucket));
  periods.sort(comparePeriods);
  return { version: 1, periods };
}

// Naive reference implementation: recomputes every settlement from the full
// event log instead of maintaining incremental state. Used to cross-check
// replay() in property tests.
function recomputeReference(events) {
  const charges = new Map();
  const correctionsByCharge = new Map();
  events.forEach((ev, idx) => {
    if (ev.type === 'charge') {
      charges.set(ev.id, { event: ev, idx });
    } else if (ev.type === 'correct') {
      const list = correctionsByCharge.get(ev.linksTo) || [];
      list.push({ event: ev, idx });
      correctionsByCharge.set(ev.linksTo, list);
    }
  });

  const keys = new Map();
  const addKey = (merchantId, period) => {
    const key = JSON.stringify([merchantId, period]);
    if (!keys.has(key)) keys.set(key, { merchantId, period });
  };
  for (const { event } of charges.values()) addKey(event.merchantId, event.period);
  for (const ev of events) if (ev.type === 'snapshot') addKey(ev.merchantId, ev.period);

  const allRules = events.filter((ev) => ev.type === 'rule');
  const periods = [];

  for (const { merchantId, period } of keys.values()) {
    const keyCharges = [...charges.values()].filter(
      (c) => c.event.merchantId === merchantId && c.event.period === period,
    );
    const belongsToKey = (ev) => {
      if (ev.type === 'charge') return ev.merchantId === merchantId && ev.period === period;
      if (ev.type === 'correct') {
        const root = charges.get(ev.linksTo);
        return root && root.event.merchantId === merchantId && root.event.period === period;
      }
      return false;
    };
    const buildRecs = (beforeIdx) =>
      keyCharges
        .filter((c) => c.idx < beforeIdx)
        .map((c) => {
          let effective = c.event.amount;
          const corrections = [];
          for (const k of (correctionsByCharge.get(c.event.id) || []).filter((k) => k.idx < beforeIdx)) {
            corrections.push({ id: k.event.id, amount: k.event.amount, delta: k.event.amount - effective });
            effective = k.event.amount;
          }
          return { id: c.event.id, productId: c.event.productId, amount: c.event.amount, effective, corrections };
        });

    const snapIdx = events.findIndex(
      (ev) => ev.type === 'snapshot' && ev.merchantId === merchantId && ev.period === period,
    );
    let snapshot = null;
    const postSnapshotIds = [];
    if (snapIdx !== -1) {
      const recs = buildRecs(snapIdx);
      const rulesBefore = events.slice(0, snapIdx).filter((ev) => ev.type === 'rule');
      const settlement = computeSettlement(rulesBefore, merchantId, period, recs);
      const eventIds = events.slice(0, snapIdx).filter(belongsToKey).map((ev) => ev.id);
      snapshot = {
        id: events[snapIdx].id,
        hash: snapshotHash(merchantId, period, settlement, eventIds),
        volume: settlement.volume,
        rebate: settlement.rebate,
        ruleId: settlement.ruleId,
        rateBps: settlement.rateBps,
      };
      for (const ev of events.slice(snapIdx + 1)) {
        if (belongsToKey(ev)) postSnapshotIds.push(ev.id);
      }
    }

    const finalRecs = buildRecs(Infinity);
    const bucket = {
      merchantId,
      period,
      charges: new Map(finalRecs.map((r) => [r.id, r])),
      snapshot,
      postSnapshotIds,
    };
    periods.push(buildPeriodOutput(allRules, bucket));
  }

  periods.sort(comparePeriods);
  return { version: 1, periods };
}

module.exports = {
  SettleError,
  replay,
  recomputeReference,
  resolveRule,
  computeSettlement,
  tierRateBps,
  hashObject,
  canonical,
};
