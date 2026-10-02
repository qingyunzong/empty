import { RATES_TO_USD, bucketKey } from './currency.js';

function addToBucket(buckets, key, value) {
  let agg = buckets.get(key);
  if (!agg) {
    agg = { count: 0, min: Infinity, max: -Infinity, sum: 0 };
    buckets.set(key, agg);
  }
  agg.count += 1;
  agg.sum += value;
  if (value < agg.min) agg.min = value;
  if (value > agg.max) agg.max = value;
}

// Shared finalizer so incremental, recomputed and brute-force results agree.
function finalize(buckets, merchant, day) {
  const currencies = {};
  let totalUsd = 0;
  for (const [key, agg] of [...buckets.entries()].sort()) {
    currencies[key] = { count: agg.count, min: agg.min, max: agg.max, sum: agg.sum };
    const rate = RATES_TO_USD[key];
    if (rate != null) totalUsd += Math.round(agg.sum * rate);
  }
  return { merchant, day, currencies, totalUsd };
}

// Materialized per-(merchant, day, currency-bucket) min/max/sum/count,
// maintained incrementally as capture events are applied.
export class Stats {
  constructor() {
    this.data = new Map(); // merchant -> Map(day -> Map(bucket -> agg))
  }

  // rec: {merchant, day, currency, effective}; effective === null is skipped.
  addCapture(rec) {
    if (rec.effective == null) return;
    let days = this.data.get(rec.merchant);
    if (!days) {
      days = new Map();
      this.data.set(rec.merchant, days);
    }
    let buckets = days.get(rec.day);
    if (!buckets) {
      buckets = new Map();
      days.set(rec.day, buckets);
    }
    addToBucket(buckets, bucketKey(rec.currency), rec.effective);
  }

  get(merchant, day) {
    const buckets = this.data.get(merchant)?.get(day) ?? new Map();
    return finalize(buckets, merchant, day);
  }

  // Backtracking recompute: drop materialized days >= fromDay for the
  // merchant and rebuild them from the capture log.
  recompute(merchant, fromDay, captures) {
    const days = this.data.get(merchant);
    if (days) {
      for (const day of [...days.keys()]) {
        if (day >= fromDay) days.delete(day);
      }
    }
    for (const rec of captures) {
      if (rec.merchant === merchant && rec.day >= fromDay) this.addCapture(rec);
    }
  }
}

// Reference implementation: full scan of the capture log.
export function bruteForceStats(captures, merchant, day) {
  const buckets = new Map();
  for (const rec of captures) {
    if (rec.merchant !== merchant || rec.day !== day || rec.effective == null) continue;
    addToBucket(buckets, bucketKey(rec.currency), rec.effective);
  }
  return finalize(buckets, merchant, day);
}
