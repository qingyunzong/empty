export function refOccupancyAt(holds, captures, t, cfg) {
  const periodOf = (x) => Math.floor((x - cfg.anchor) / cfg.periodMinutes);
  const active = (list, pick) => list
    .filter(pick)
    .reduce((acc, x) => {
      acc.total += x.amount;
      acc.byCategory[x.category] = (acc.byCategory[x.category] ?? 0) + x.amount;
      return acc;
    }, { total: 0, byCategory: {} });
  const fromHolds = active(holds, (h) => h.start <= t && t < h.end);
  const fromCaps = active(captures, (c) => c.at <= t && periodOf(c.at) === periodOf(t));
  const byCategory = { ...fromHolds.byCategory };
  for (const [k, v] of Object.entries(fromCaps.byCategory)) {
    byCategory[k] = (byCategory[k] ?? 0) + v;
  }
  return { total: fromHolds.total + fromCaps.total, byCategory };
}

export function refDayUsage(holds, captures, category, day, cfg) {
  const ds = day * cfg.dayMinutes;
  const de = ds + cfg.dayMinutes;
  const perHold = {};
  for (const h of holds) {
    if (h.category === category && h.start < de && ds < h.end) {
      perHold[h.id] = Math.max(perHold[h.id] ?? 0, h.amount);
    }
  }
  let used = 0;
  for (const k of Object.keys(perHold)) used += perHold[k];
  for (const c of captures) {
    if (c.category === category && Math.floor(c.at / cfg.dayMinutes) === day) used += c.amount;
  }
  return used;
}

export function refCheckTimeline(holds, captures, cfg, t0, t1) {
  const violations = [];
  let maxTotal = 0;
  for (let t = t0; t < t1; t++) {
    const occ = refOccupancyAt(holds, captures, t, cfg);
    if (occ.total > maxTotal) maxTotal = occ.total;
    if (occ.total > cfg.totalLimit) {
      violations.push({ kind: 'total', at: t, total: occ.total, limit: cfg.totalLimit });
    }
  }
  const d0 = Math.floor(t0 / cfg.dayMinutes);
  const d1 = Math.floor((t1 - 1) / cfg.dayMinutes);
  for (let d = d0; d <= d1; d++) {
    for (const [category, cap] of Object.entries(cfg.dailyCaps)) {
      const used = refDayUsage(holds, captures, category, d, cfg);
      if (used > cap) {
        violations.push({ kind: 'daily', day: d, category, used, cap });
      }
    }
  }
  return { violations, maxTotal };
}
