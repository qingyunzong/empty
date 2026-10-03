// Fee-package math: tiered rates, minimum fee, rebates.
// All money is handled as integer cents; rates as integer per-million ("micros")
// so results are deterministic across runs and platforms.

const MICRO = 1_000_000;

export function toCents(value, field = 'amount') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid ${field}: expected a finite number, got ${JSON.stringify(value)}`);
  }
  return Math.round(value * 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function normalizeTiers(rawTiers) {
  if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
    throw new Error('package: "tiers" must be a non-empty array');
  }
  const tiers = rawTiers.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`tier ${index}: must be an object`);
    const { rate } = raw;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`tier ${index}: "rate" must be a non-negative finite number`);
    }
    const upToCents = raw.upTo === null || raw.upTo === undefined
      ? Infinity
      : toCents(raw.upTo, `tier ${index} "upTo"`);
    if (upToCents <= 0) throw new Error(`tier ${index}: "upTo" must be positive or null`);
    return { upToCents, rateMicros: Math.round(rate * MICRO) };
  });
  for (let i = 0; i < tiers.length; i += 1) {
    if (i > 0 && tiers[i].upToCents <= tiers[i - 1].upToCents) {
      throw new Error(`tier ${i}: "upTo" values must be strictly ascending`);
    }
    if (i < tiers.length - 1 && tiers[i].upToCents === Infinity) {
      throw new Error(`tier ${i}: only the last tier may be unbounded (upTo: null)`);
    }
  }
  return tiers;
}

function normalizeRebate(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`rebate ${index}: must be an object`);
  const minTurnoverCents = toCents(raw.minTurnover ?? 0, `rebate ${index} "minTurnover"`);
  if (minTurnoverCents < 0) throw new Error(`rebate ${index}: "minTurnover" must be >= 0`);
  if (raw.amount !== undefined) {
    const amountCents = toCents(raw.amount, `rebate ${index} "amount"`);
    if (amountCents < 0) throw new Error(`rebate ${index}: "amount" must be >= 0`);
    return { kind: 'fixed', minTurnoverCents, amountCents };
  }
  if (raw.percent !== undefined) {
    if (typeof raw.percent !== 'number' || !Number.isFinite(raw.percent) || raw.percent < 0) {
      throw new Error(`rebate ${index}: "percent" must be a non-negative finite number`);
    }
    return { kind: 'percent', minTurnoverCents, percentMicros: Math.round((raw.percent / 100) * MICRO) };
  }
  throw new Error(`rebate ${index}: needs either "amount" (fixed) or "percent" (of gross fee)`);
}

// Amount of turnover falling into each tier bracket.
export function tierAmountsFor(tiers, turnoverCents) {
  const amounts = new Array(tiers.length);
  let lower = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    const upper = tiers[i].upToCents;
    amounts[i] = Math.max(0, Math.min(turnoverCents, upper) - lower);
    lower = upper;
  }
  return amounts;
}

// Per-tier delta between two turnover levels; sums to deltaCents.
export function distributeDelta(tiers, beforeCents, deltaCents) {
  const before = tierAmountsFor(tiers, beforeCents);
  const after = tierAmountsFor(tiers, beforeCents + deltaCents);
  return after.map((value, i) => value - before[i]);
}

// Highest tier index holding any amount; null when nothing is invested.
export function hitTierFromAmounts(amounts) {
  for (let i = amounts.length - 1; i >= 0; i -= 1) {
    if (amounts[i] > 0) return i;
  }
  return null;
}

export class FeePackage {
  constructor(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('package: spec must be an object');
    if (typeof spec.id !== 'string' || spec.id.length === 0) {
      throw new Error('package: "id" must be a non-empty string');
    }
    this.id = spec.id;
    this.version = spec.version ?? 1;
    if (!Number.isInteger(this.version) || this.version < 1) {
      throw new Error(`package ${this.id}: "version" must be a positive integer`);
    }
    this.tiers = normalizeTiers(spec.tiers);
    this.minFeeCents = toCents(spec.minFee ?? 0, `package ${this.id} "minFee"`);
    if (this.minFeeCents < 0) throw new Error(`package ${this.id}: "minFee" must be >= 0`);
    this.rebates = (spec.rebates ?? []).map((r, i) => normalizeRebate(r, i));
    this.spec = {
      id: this.id,
      version: this.version,
      tiers: spec.tiers,
      minFee: spec.minFee ?? 0,
      rebates: spec.rebates ?? [],
    };
  }

  quote(turnoverCents) {
    return this.quoteFromTierAmounts(tierAmountsFor(this.tiers, turnoverCents), turnoverCents);
  }

  quoteFromTierAmounts(tierAmounts, turnoverCents) {
    let micros = 0;
    for (let i = 0; i < tierAmounts.length; i += 1) {
      micros += tierAmounts[i] * this.tiers[i].rateMicros;
    }
    const rawCents = Math.round(micros / MICRO);
    // Minimum fee only applies while the account actually traded.
    const grossCents = turnoverCents > 0 ? Math.max(rawCents, this.minFeeCents) : 0;
    let rebateCents = 0;
    for (const rebate of this.rebates) {
      if (turnoverCents >= rebate.minTurnoverCents) {
        rebateCents += rebate.kind === 'fixed'
          ? rebate.amountCents
          : Math.round((grossCents * rebate.percentMicros) / MICRO);
      }
    }
    return {
      feeCents: Math.max(0, grossCents - rebateCents),
      rawCents,
      grossCents,
      rebateCents,
      hitTier: turnoverCents > 0 ? hitTierFromAmounts(tierAmounts) : null,
    };
  }
}
