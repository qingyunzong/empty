'use strict';

// Char sets as sorted, merged arrays of [lo, hi] code-unit intervals.
const MAX_CP = 0xffff;

function norm(set) {
  const a = set.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [lo, hi] of a) {
    if (out.length && lo <= out[out.length - 1][1] + 1) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], hi);
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

function negate(set) {
  const s = norm(set);
  const out = [];
  let cur = 0;
  for (const [lo, hi] of s) {
    if (lo > cur) out.push([cur, lo - 1]);
    cur = hi + 1;
  }
  if (cur <= MAX_CP) out.push([cur, MAX_CP]);
  return out;
}

function contains(set, cp) {
  let lo = 0;
  let hi = set.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cp < set[m][0]) hi = m - 1;
    else if (cp > set[m][1]) lo = m + 1;
    else return true;
  }
  return false;
}

function union(a, b) {
  return norm(a.concat(b));
}

module.exports = { norm, negate, contains, union, MAX_CP };
