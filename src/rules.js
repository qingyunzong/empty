'use strict';

// Western Electric rule presets. Two generic shapes:
//  - beyond: k of the last m active points beyond `sigma` * σ on the same side of the centre line
//  - run:    `run` consecutive active points strictly on the same side of the centre line
const PRESETS = {
  WE1: { type: 'beyond', k: 1, m: 1, sigma: 3 },
  WE2: { type: 'beyond', k: 2, m: 3, sigma: 2 },
  WE3: { type: 'beyond', k: 4, m: 5, sigma: 1 },
  WE4: { type: 'run', run: 8 },
};

function normalizeRules(rules) {
  const list = rules == null ? ['WE1', 'WE2', 'WE3', 'WE4'] : rules;
  if (!Array.isArray(list) || list.length === 0) throw new Error('rules must be a non-empty array');
  return list.map((r, i) => {
    const rule = typeof r === 'string' ? PRESETS[r] : r;
    if (!rule) throw new Error(`unknown rule preset: ${r}`);
    const name = typeof r === 'string' ? r : rule.name || `CUSTOM${i}`;
    if (rule.type === 'beyond') {
      for (const key of ['k', 'm', 'sigma']) {
        if (!Number.isFinite(rule[key])) throw new Error(`rule ${name}: missing ${key}`);
      }
      return { name, type: 'beyond', k: rule.k, m: rule.m, sigma: rule.sigma };
    }
    if (rule.type === 'run') {
      if (!Number.isFinite(rule.run)) throw new Error(`rule ${name}: missing run`);
      return { name, type: 'run', run: rule.run };
    }
    throw new Error(`rule ${name}: unknown type ${rule.type}`);
  });
}

module.exports = { PRESETS, normalizeRules };
