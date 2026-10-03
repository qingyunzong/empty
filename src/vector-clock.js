'use strict';

/**
 * Compare two vector clocks.
 * Returns 'gt' if a strictly dominates b, 'lt' if b strictly dominates a,
 * 'eq' if they are identical, 'concurrent' if neither dominates.
 */
function compareClocks(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let aGreater = false;
  let bGreater = false;
  for (const key of keys) {
    const x = a[key] || 0;
    const y = b[key] || 0;
    if (x > y) aGreater = true;
    else if (y > x) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'gt';
  if (bGreater) return 'lt';
  return 'eq';
}

module.exports = { compareClocks };
