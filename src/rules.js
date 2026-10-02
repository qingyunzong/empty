export const RULE_VERSIONS = {
  v1: {
    packages: [
      {
        id: 'P-STD',
        tiers: [
          { id: 'T1', upTo: 1_000_000, rate: 0.0005 },
          { id: 'T2', upTo: 5_000_000, rate: 0.0004 },
          { id: 'T3', upTo: Infinity, rate: 0.0003 },
        ],
        minFee: 100,
        rebates: [{ id: 'R-VOL', minTurnover: 2_000_000, pct: 0.1 }],
      },
      {
        id: 'P-PRO',
        tiers: [
          { id: 'T1', upTo: 2_000_000, rate: 0.00045 },
          { id: 'T2', upTo: Infinity, rate: 0.00035 },
        ],
        minFee: 200,
        rebates: [],
      },
    ],
  },
  v2: {
    packages: [
      { id: 'P-FLAT-A', tiers: [{ id: 'F1', upTo: Infinity, rate: 0.0004 }], minFee: 0, rebates: [] },
      {
        id: 'P-FLAT-B',
        tiers: [{ id: 'F1', upTo: Infinity, rate: 0.0005 }],
        minFee: 0,
        rebates: [{ id: 'R-B', minTurnover: 0, pct: 0.2 }],
      },
      {
        id: 'P-STD2',
        tiers: [
          { id: 'T1', upTo: 1_000_000, rate: 0.00048 },
          { id: 'T2', upTo: Infinity, rate: 0.00038 },
        ],
        minFee: 80,
        rebates: [],
      },
    ],
  },
};

export const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function splitIntoTiers(tiers, turnover) {
  const amounts = [];
  let lower = 0;
  for (const t of tiers) {
    const upper = Math.min(t.upTo, turnover);
    amounts.push(Math.max(0, upper - lower));
    lower = t.upTo;
  }
  return amounts;
}

export function tierDelta(tiers, from, to) {
  const a = splitIntoTiers(tiers, from);
  const b = splitIntoTiers(tiers, to);
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push({ index: i, delta: b[i] - a[i] });
  }
  return out;
}

export function hitTierIndex(amounts) {
  let hit = -1;
  for (let i = 0; i < amounts.length; i++) if (amounts[i] > 0) hit = i;
  return hit;
}

export function computeFee(pack, turnover) {
  const amounts = splitIntoTiers(pack.tiers, turnover);
  const tiers = [];
  let gross = 0;
  for (let i = 0; i < pack.tiers.length; i++) {
    const amount = amounts[i];
    if (amount > 0) {
      const fee = r4(amount * pack.tiers[i].rate);
      gross = r4(gross + fee);
      tiers.push({ tier: pack.tiers[i].id, amount, rate: pack.tiers[i].rate, fee });
    }
  }
  const minFeeApplied = turnover > 0 && gross < pack.minFee;
  const afterMin = minFeeApplied ? pack.minFee : gross;
  let rebate = 0;
  let rebateId = null;
  for (const r of pack.rebates) {
    if (turnover >= r.minTurnover) {
      const val = r4(afterMin * r.pct);
      if (val > rebate) {
        rebate = val;
        rebateId = r.id;
      }
    }
  }
  return {
    packageId: pack.id,
    turnover,
    tiers,
    gross,
    minFee: pack.minFee,
    minFeeApplied,
    rebate,
    rebateId,
    net: r4(afterMin - rebate),
  };
}

export function selectPackage(packages, turnover) {
  if (packages.length === 0) throw new Error('no fee packages available');
  const results = packages.map((p) => computeFee(p, turnover));
  let best = results[0].net;
  for (const r of results) if (r.net < best) best = r.net;
  const tied = results.filter((r) => r.net === best).map((r) => r.packageId).sort();
  return { winner: tied[0], tied, results };
}
