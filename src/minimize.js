'use strict';

const { simulate, normalizeArrivals } = require('./sim');

// Find a 1-minimal set of arrivals that still triggers a violation:
// 1. shortest prefix of the (time-ordered) arrival stream that violates;
// 2. delta-minimize it: drop any arrival whose removal keeps the violation.
// The result is minimal in the sense that removing ANY single remaining
// arrival makes the violation disappear (verified by the caller's tests).
// Returns null when no prefix of the stream violates.
function minimizePrefix(config, options = {}) {
  const arrivals = normalizeArrivals(config);
  const violates = (list) =>
    simulate({ ...config, arrivals: list }, options).status === 'VIOLATION';

  let prefixLen = -1;
  for (let k = 1; k <= arrivals.length; k++) {
    if (violates(arrivals.slice(0, k))) {
      prefixLen = k;
      break;
    }
  }
  if (prefixLen < 0) return null;

  let set = arrivals.slice(0, prefixLen);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of set) {
      const candidate = set.filter((x) => x !== a);
      if (candidate.length > 0 && violates(candidate)) {
        set = candidate;
        changed = true;
        break;
      }
    }
  }

  const result = simulate({ ...config, arrivals: set }, options);
  return { arrivals: set, violation: result.firstViolation, status: result.status };
}

module.exports = { minimizePrefix };
