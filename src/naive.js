// naive.js — independent brute-force reference implementation of the SPC spec.
// Everything here is computed with plain O(n) loops over plain arrays.
// It shares NO code with the incremental engine (src/spc.js) on purpose:
// tests cross-check the engine against this file.

export const DEFAULT_RULES = Object.freeze({
  // WE rule 1: a single point more than k sigma away from the center line.
  beyondSigma: { enabled: true, k: 3 },
  // WE rule 2: n of `of` consecutive points beyond k sigma on the same side.
  twoOfThree: { enabled: true, k: 2, n: 2, of: 3 },
  // WE rule 3: n of `of` consecutive points beyond k sigma on the same side.
  fourOfFive: { enabled: true, k: 1, n: 4, of: 5 },
  // WE rule 4: `run` consecutive points on the same side of the center line.
  runSide: { enabled: true, run: 8 },
});

export function normalizeRules(rules) {
  const merged = {};
  for (const [name, def] of Object.entries(DEFAULT_RULES)) {
    merged[name] = { ...def, ...(rules?.[name] ?? {}) };
  }
  return merged;
}

export function sideOf(value, mu) {
  if (value > mu) return 1;
  if (value < mu) return -1;
  return 0;
}

export function isBeyond(value, mu, sigma, k) {
  return Math.abs(value - mu) > k * sigma;
}

// Does `ruleName` fire on the given ordered sequence of values, measured
// against the FIXED limits (mu, sigma) of the window the alarm came from?
// For n-of-m rules a subset smaller than `of` is treated as a single window.
export function checkRuleOnSubset(ruleName, cfg, values, mu, sigma) {
  if (ruleName === 'beyondSigma') {
    return values.some((v) => isBeyond(v, mu, sigma, cfg.k));
  }
  if (ruleName === 'twoOfThree' || ruleName === 'fourOfFive') {
    if (values.length < cfg.n) return false;
    const width = Math.min(cfg.of, values.length);
    for (let i = 0; i + width <= values.length; i++) {
      for (const s of [1, -1]) {
        let hit = 0;
        for (let j = i; j < i + width; j++) {
          if (sideOf(values[j], mu) === s && isBeyond(values[j], mu, sigma, cfg.k)) hit++;
        }
        if (hit >= cfg.n) return true;
      }
    }
    return false;
  }
  if (ruleName === 'runSide') {
    let best = 0;
    let cur = 0;
    let curSide = 0;
    for (const v of values) {
      const s = sideOf(v, mu);
      if (s !== 0 && s === curSide) {
        cur++;
      } else {
        cur = s === 0 ? 0 : 1;
        curSide = s;
      }
      if (cur > best) best = cur;
    }
    return best >= cfg.run;
  }
  throw new Error(`unknown rule: ${ruleName}`);
}

// Full brute-force evaluation of a stream of valid points [{id, value}]
// (already ordered by sequence). Returns the same shape as the engine state.
export function naiveEvaluate(points, options = {}) {
  const windowSize = options.windowSize ?? Infinity;
  const minSamples = options.minSamples ?? 5;
  const rules = normalizeRules(options.rules);

  if (points.length < minSamples) {
    return {
      status: 'UNKNOWN',
      alarms: [],
      controlLimits: null,
      validCount: points.length,
    };
  }

  const win = points.slice(Math.max(0, points.length - Math.min(windowSize, points.length)));
  let sum = 0;
  for (const p of win) sum += p.value;
  const mu = sum / win.length;
  let sq = 0;
  for (const p of win) sq += p.value * p.value;
  let variance = sq / win.length - mu * mu;
  if (variance < 0) variance = 0; // floating-point guard
  const sigma = Math.sqrt(variance);

  const alarms = [];

  if (rules.beyondSigma.enabled) {
    for (const p of win) {
      if (isBeyond(p.value, mu, sigma, rules.beyondSigma.k)) {
        alarms.push({ rule: 'beyondSigma', side: sideOf(p.value, mu), pointIds: [p.id] });
      }
    }
  }

  for (const name of ['twoOfThree', 'fourOfFive']) {
    const cfg = rules[name];
    if (!cfg.enabled) continue;
    for (let i = 0; i + cfg.of <= win.length; i++) {
      const slice = win.slice(i, i + cfg.of);
      for (const s of [1, -1]) {
        const hits = slice.filter(
          (p) => sideOf(p.value, mu) === s && isBeyond(p.value, mu, sigma, cfg.k),
        );
        if (hits.length >= cfg.n) {
          alarms.push({ rule: name, side: s, pointIds: slice.map((p) => p.id) });
          break;
        }
      }
    }
  }

  if (rules.runSide.enabled) {
    let i = 0;
    while (i < win.length) {
      const s = sideOf(win[i].value, mu);
      if (s === 0) {
        i++;
        continue;
      }
      let j = i;
      while (j < win.length && sideOf(win[j].value, mu) === s) j++;
      if (j - i >= rules.runSide.run) {
        alarms.push({ rule: 'runSide', side: s, pointIds: win.slice(i, j).map((p) => p.id) });
      }
      i = j;
    }
  }

  return {
    status: alarms.length > 0 ? 'ALARM' : 'OK',
    alarms,
    controlLimits: {
      center: mu,
      sigma,
      ucl: mu + 3 * sigma,
      lcl: mu - 3 * sigma,
      n: win.length,
    },
    validCount: points.length,
  };
}
