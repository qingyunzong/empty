'use strict';

const { normalizeRules } = require('./rules');

// Independent brute-force reference: plain loops, no Fenwick trees, O(n * W).
// Used to cross-check the incremental engine and to verify alarm minimality.
function recompute(snapshot) {
  const config = snapshot.config;
  const rules = normalizeRules(config.rules);
  const W = config.windowSize ?? 50;
  const minSamples = config.minSamples ?? 10;

  const points = snapshot.points;
  const active = points.filter((p) => p.valid && !p.flags.includes('ERR_UNIT'));

  const statuses = new Map();
  for (const p of points) {
    if (!p.valid || p.flags.includes('ERR_UNIT')) statuses.set(p.id, 'EXCLUDED');
  }

  const alarms = [];
  for (let i = 0; i < active.length; i++) {
    const cur = active[i];
    const base = active.slice(Math.max(0, i - W), i);
    if (base.length < minSamples) {
      statuses.set(cur.id, 'UNKNOWN');
      continue;
    }
    let sum = 0;
    let sq = 0;
    for (const b of base) {
      sum += b.value;
      sq += b.value * b.value;
    }
    const mean = sum / base.length;
    let variance = sq / base.length - mean * mean;
    if (variance < 0) variance = 0;
    const sigma = Math.sqrt(variance);

    const fired = [];
    for (const rule of rules) {
      if (rule.type === 'beyond') {
        if (i + 1 < rule.m) continue;
        const hi = mean + rule.sigma * sigma;
        const lo = mean - rule.sigma * sigma;
        let above = 0;
        let below = 0;
        for (let j = i + 1 - rule.m; j <= i; j++) {
          if (active[j].value > hi) above++;
          else if (active[j].value < lo) below++;
        }
        if (above >= rule.k) fired.push({ rule: rule.name, side: 'above' });
        else if (below >= rule.k) fired.push({ rule: rule.name, side: 'below' });
      } else {
        if (i + 1 < rule.run) continue;
        let above = true;
        let below = true;
        for (let j = i + 1 - rule.run; j <= i; j++) {
          if (active[j].value <= mean) above = false;
          if (active[j].value >= mean) below = false;
        }
        if (above) fired.push({ rule: rule.name, side: 'above' });
        else if (below) fired.push({ rule: rule.name, side: 'below' });
      }
    }
    statuses.set(cur.id, fired.length ? 'ALARM' : 'IN_CONTROL');
    for (const f of fired) alarms.push({ rule: f.rule, triggerId: cur.id, side: f.side });
  }

  const tail = active.slice(-W);
  let limits = null;
  let limitsStatus = 'UNKNOWN';
  if (tail.length >= minSamples) {
    let sum = 0;
    let sq = 0;
    for (const b of tail) {
      sum += b.value;
      sq += b.value * b.value;
    }
    const mean = sum / tail.length;
    let variance = sq / tail.length - mean * mean;
    if (variance < 0) variance = 0;
    const sigma = Math.sqrt(variance);
    limits = { mean, sigma, cl: mean, ucl: mean + 3 * sigma, lcl: mean - 3 * sigma };
    limitsStatus = 'OK';
  }

  const status = active.length < minSamples ? 'UNKNOWN' : alarms.length ? 'ALARM' : 'IN_CONTROL';
  return { statuses, alarms, controlLimits: { status: limitsStatus, samples: tail.length, limits }, status };
}

module.exports = { recompute };
