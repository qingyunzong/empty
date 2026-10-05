'use strict';

// Test-only brute-force reference. Deliberately shares NO code with src/.
// Given at most 20 valid points, it sorts them, checks every adjacent pair,
// and enumerates contiguous missing depth intervals one meter at a time.

function sortPoints(points) {
  if (points.length > 20) {
    throw new Error('reference supports at most 20 points');
  }
  return [...points].sort((a, b) => a.depth - b.depth);
}

function referenceInversions(points) {
  const sorted = sortPoints(points);
  const pairs = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const rise = sorted[i + 1].temp - sorted[i].temp;
    if (rise > 0.5) pairs.push([sorted[i].depth, sorted[i + 1].depth]);
  }
  return pairs;
}

function referenceMaxInversion(points) {
  const sorted = sortPoints(points);
  let best = null;
  let i = 0;
  while (i + 1 < sorted.length) {
    const isInv = sorted[i + 1].temp - sorted[i].temp > 0.5;
    if (!isInv) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 2 < sorted.length &&
      sorted[j + 2].temp - sorted[j + 1].temp > 0.5
    ) {
      j++;
    }
    const top = sorted[i].depth;
    const bottom = sorted[j + 1].depth;
    if (best === null || bottom - top > best.span) {
      best = { top, bottom, span: bottom - top };
    }
    i = j + 1;
  }
  return best;
}

function referenceMissing(points) {
  const sorted = sortPoints(points);
  const present = new Set(sorted.map((p) => p.depth));
  const blocks = [];
  if (sorted.length > 0) {
    const lo = sorted[0].depth;
    const hi = sorted[sorted.length - 1].depth;
    for (let d = lo; d <= hi; d++) {
      if (present.has(d)) continue;
      const last = blocks[blocks.length - 1];
      if (last && last[1] === d - 1) last[1] = d;
      else blocks.push([d, d]);
    }
  }
  const missingCount = blocks.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
  return { blocks, blockCount: blocks.length, missingCount };
}

module.exports = {
  referenceInversions,
  referenceMaxInversion,
  referenceMissing,
};
