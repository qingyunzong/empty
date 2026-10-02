'use strict';
const crypto = require('node:crypto');

class SettleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function parseEvent(line, lineno) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    throw new SettleError('E_PARSE', `line ${lineno}: invalid JSON`);
  }
  if (!ev || typeof ev !== 'object' || !isNonEmptyString(ev.type)) {
    throw new SettleError('E_PARSE', `line ${lineno}: missing event type`);
  }
  switch (ev.type) {
    case 'rule': {
      if (!isNonEmptyString(ev.ruleId)) throw new SettleError('E_PARSE', `line ${lineno}: rule missing ruleId`);
      if (ev.scope !== 'product' && ev.scope !== 'merchant') {
        throw new SettleError('E_PARSE', `line ${lineno}: rule scope must be product|merchant`);
      }
      if (ev.scope === 'product' && !isNonEmptyString(ev.productId)) {
        throw new SettleError('E_PARSE', `line ${lineno}: product rule missing productId`);
      }
      if (ev.scope === 'merchant' && !isNonEmptyString(ev.merchantId)) {
        throw new SettleError('E_PARSE', `line ${lineno}: merchant rule missing merchantId`);
      }
      if (ev.ts !== undefined && !Number.isFinite(ev.ts)) {
        throw new SettleError('E_PARSE', `line ${lineno}: rule ts must be a number`);
      }
      if (!Array.isArray(ev.tiers) || ev.tiers.length === 0) {
        throw new SettleError('E_PARSE', `line ${lineno}: rule tiers must be a non-empty array`);
      }
      const tiers = ev.tiers.map((t) => {
        if (!t || !isNonNegInt(t.min) || !isNonNegInt(t.bps)) {
          throw new SettleError('E_PARSE', `line ${lineno}: tier needs non-negative integer min and bps`);
        }
        return { min: t.min, bps: t.bps };
      });
      tiers.sort((a, b) => a.min - b.min);
      for (let i = 1; i < tiers.length; i += 1) {
        if (tiers[i].min === tiers[i - 1].min) {
          throw new SettleError('E_PARSE', `line ${lineno}: duplicate tier min ${tiers[i].min}`);
        }
      }
      return { type: 'rule', ruleId: ev.ruleId, scope: ev.scope, productId: ev.productId, merchantId: ev.merchantId, ts: ev.ts, tiers };
    }
    case 'charge': {
      if (!isNonEmptyString(ev.id) || !isNonEmptyString(ev.merchantId) || !isNonEmptyString(ev.productId) || !isNonEmptyString(ev.period)) {
        throw new SettleError('E_PARSE', `line ${lineno}: charge needs id, merchantId, productId, period`);
      }
      if (!isNonNegInt(ev.amount)) {
        throw new SettleError('E_PARSE', `line ${lineno}: charge amount must be a non-negative integer`);
      }
      return { type: 'charge', id: ev.id, merchantId: ev.merchantId, productId: ev.productId, period: ev.period, amount: ev.amount };
    }
    case 'correct': {
      if (!isNonEmptyString(ev.id) || !isNonEmptyString(ev.linksTo)) {
        throw new SettleError('E_PARSE', `line ${lineno}: correct needs id and linksTo`);
      }
      return { type: 'correct', id: ev.id, linksTo: ev.linksTo };
    }
    case 'snapshot': {
      if (!isNonEmptyString(ev.id) || !isNonEmptyString(ev.merchantId) || !isNonEmptyString(ev.period)) {
        throw new SettleError('E_PARSE', `line ${lineno}: snapshot needs id, merchantId, period`);
      }
      if (ev.hash !== undefined && !isNonEmptyString(ev.hash)) {
        throw new SettleError('E_PARSE', `line ${lineno}: snapshot hash must be a string`);
      }
      return { type: 'snapshot', id: ev.id, merchantId: ev.merchantId, period: ev.period, hash: ev.hash };
    }
    default:
      throw new SettleError('E_PARSE', `line ${lineno}: unknown event type ${ev.type}`);
  }
}

function baseRate(rule) {
  return rule.tiers[0].bps;
}

function compareRuleId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Merchant-scoped rules override product-scoped ones (inheritance product -> merchant).
// Within the winning scope the most recently defined rule wins; ties break by
// ascending base rate, then ascending ruleId.
function resolveRule(rules, merchantId, productIds) {
  const merchantRules = rules.filter((r) => r.scope === 'merchant' && r.merchantId === merchantId);
  let candidates = merchantRules;
  if (candidates.length === 0) {
    candidates = rules.filter((r) => r.scope === 'product' && productIds.includes(r.productId));
  }
  if (candidates.length === 0) return null;
  const maxTs = Math.max(...candidates.map((r) => r.ts));
  candidates = candidates.filter((r) => r.ts === maxTs);
  candidates.sort((a, b) => baseRate(a) - baseRate(b) || compareRuleId(a.ruleId, b.ruleId));
  return candidates[0];
}

function selectTier(tiers, volume) {
  let chosen = tiers[0];
  for (const tier of tiers) {
    if (volume >= tier.min) chosen = tier;
  }
  return chosen;
}

function computeSettlement(charges, rule) {
  const volume = charges.reduce((sum, c) => sum + (c.reversed ? 0 : c.amount), 0);
  if (!rule) return { volume, rebate: 0, ruleId: null, tier: null };
  const tier = selectTier(rule.tiers, volume);
  const rebate = Math.floor((volume * tier.bps) / 10000);
  return { volume, rebate, ruleId: rule.ruleId, tier };
}

function snapshotPayload(rec, settlement) {
  return {
    merchantId: rec.merchantId,
    period: rec.period,
    volume: settlement.volume,
    rebate: settlement.rebate,
    ruleId: settlement.ruleId,
    tier: settlement.tier,
    charges: rec.charges.map((c) => ({ id: c.id, amount: c.amount, reversed: c.reversed })),
  };
}

function settle(events) {
  const rules = [];
  const chargesById = new Map();
  const periods = new Map();
  let seq = 0;

  const getPeriod = (merchantId, period) => {
    const key = `${merchantId}|${period}`;
    let rec = periods.get(key);
    if (!rec) {
      rec = {
        merchantId,
        period,
        charges: [],
        postSnapshotActivity: false,
        postSnapshotCorrections: [],
        postSnapshotCharges: [],
        snapshot: null,
        snapshotSeq: 0,
      };
      periods.set(key, rec);
    }
    return rec;
  };

  for (const ev of events) {
    seq += 1;
    if (ev.type === 'rule') {
      rules.push({ ...ev, ts: ev.ts !== undefined ? ev.ts : seq, seq });
    } else if (ev.type === 'charge') {
      if (chargesById.has(ev.id)) {
        throw new SettleError('E_PARSE', `duplicate event id ${ev.id}`);
      }
      const charge = { ...ev, reversed: false, corrections: [] };
      chargesById.set(ev.id, charge);
      const rec = getPeriod(ev.merchantId, ev.period);
      rec.charges.push(charge);
      if (rec.snapshot) {
        rec.postSnapshotActivity = true;
        rec.postSnapshotCharges.push(ev.id);
      }
    } else if (ev.type === 'correct') {
      const target = chargesById.get(ev.linksTo);
      if (!target) {
        throw new SettleError('E_LINK', `correction ${ev.id} links to unknown event ${ev.linksTo}`);
      }
      if (target.reversed) {
        throw new SettleError('E_LINK', `correction ${ev.id} links to already-reversed charge ${ev.linksTo}`);
      }
      target.reversed = true;
      target.corrections.push(ev.id);
      const rec = getPeriod(target.merchantId, target.period);
      if (rec.snapshot) {
        rec.postSnapshotActivity = true;
        rec.postSnapshotCorrections.push(ev.id);
      }
    } else if (ev.type === 'snapshot') {
      const rec = getPeriod(ev.merchantId, ev.period);
      if (rec.snapshot) {
        throw new SettleError('E_SNAPSHOT', `duplicate snapshot for ${rec.merchantId}|${rec.period}`);
      }
      const eligibleRules = rules.filter((r) => r.seq < seq);
      const productIds = [...new Set(rec.charges.map((c) => c.productId))];
      const rule = resolveRule(eligibleRules, rec.merchantId, productIds);
      const result = computeSettlement(rec.charges, rule);
      const hash = hashOf(snapshotPayload(rec, result));
      if (ev.hash !== undefined && ev.hash !== hash) {
        throw new SettleError('E_SNAPSHOT', `snapshot ${ev.id} hash mismatch for ${rec.merchantId}|${rec.period}`);
      }
      rec.snapshot = { id: ev.id, hash, ...result };
      rec.snapshotSeq = seq;
    }
  }

  const out = [];
  for (const rec of periods.values()) {
    const productIds = [...new Set(rec.charges.map((c) => c.productId))];
    const adjustments = rec.charges
      .filter((c) => c.corrections.length > 0)
      .map((c) => ({ chargeId: c.id, corrections: [...c.corrections] }));

    if (rec.snapshot) {
      const supplements = [];
      if (rec.postSnapshotActivity) {
        const eligibleRules = rules.filter((r) => r.seq < rec.snapshotSeq);
        const rule = resolveRule(eligibleRules, rec.merchantId, productIds);
        const result = computeSettlement(rec.charges, rule);
        supplements.push({
          batchId: `${rec.snapshot.id}-sup-1`,
          corrections: [...rec.postSnapshotCorrections],
          charges: [...rec.postSnapshotCharges],
          volume: result.volume,
          rebate: result.rebate,
          ruleId: result.ruleId,
          deltaVolume: result.volume - rec.snapshot.volume,
          deltaRebate: result.rebate - rec.snapshot.rebate,
        });
      }
      out.push({
        merchantId: rec.merchantId,
        period: rec.period,
        volume: rec.snapshot.volume,
        rebate: rec.snapshot.rebate,
        ruleId: rec.snapshot.ruleId,
        tier: rec.snapshot.tier,
        adjustments,
        snapshot: rec.snapshot,
        supplements,
      });
    } else {
      const rule = resolveRule(rules, rec.merchantId, productIds);
      const result = computeSettlement(rec.charges, rule);
      out.push({
        merchantId: rec.merchantId,
        period: rec.period,
        ...result,
        adjustments,
        snapshot: null,
        supplements: [],
      });
    }
  }

  out.sort((a, b) => compareRuleId(a.merchantId, b.merchantId) || compareRuleId(a.period, b.period));
  return { periods: out };
}

module.exports = { settle, parseEvent, hashOf, SettleError };
