'use strict';

// Independent brute-force reference used only by tests.
// Given valid points (unique integer depths 0..1000), it sorts by depth,
// checks every adjacent pair for inversion (> 0.5 C rise with depth) and
// enumerates contiguous missing integer-depth intervals inside [min, max].

function referenceState(points) {
  const sorted = points
    .map((p) => ({ depth: p.depth, temp: p.temp }))
    .sort((a, b) => a.depth - b.depth);

  const inversions = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    if (sorted[i + 1].temp - sorted[i].temp > 0.5) {
      inversions.push([sorted[i].depth, sorted[i + 1].depth]);
    }
  }

  let maxInversionLayer = null;
  let runStart = null;
  let runPairs = 0;
  const layers = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const isInv = sorted[i + 1].temp - sorted[i].temp > 0.5;
    if (isInv) {
      if (runStart === null) runStart = sorted[i].depth;
      runPairs += 1;
    } else if (runStart !== null) {
      layers.push({ from: runStart, to: sorted[i].depth, pairCount: runPairs });
      runStart = null;
      runPairs = 0;
    }
  }
  if (runStart !== null) {
    layers.push({ from: runStart, to: sorted[sorted.length - 1].depth, pairCount: runPairs });
  }
  for (const layer of layers) {
    if (
      maxInversionLayer === null ||
      layer.pairCount > maxInversionLayer.pairCount ||
      (layer.pairCount === maxInversionLayer.pairCount &&
        (layer.to - layer.from > maxInversionLayer.to - maxInversionLayer.from ||
          (layer.to - layer.from === maxInversionLayer.to - maxInversionLayer.from &&
            layer.from < maxInversionLayer.from)))
    ) {
      maxInversionLayer = layer;
    }
  }

  const present = new Set(sorted.map((p) => p.depth));
  const blocks = [];
  if (sorted.length > 1) {
    const min = sorted[0].depth;
    const max = sorted[sorted.length - 1].depth;
    let d = min;
    while (d <= max) {
      if (present.has(d)) {
        d += 1;
        continue;
      }
      const start = d;
      while (d <= max && !present.has(d)) d += 1;
      blocks.push({ start, end: d - 1, count: d - start });
    }
  }
  const missingCount = blocks.reduce((acc, b) => acc + b.count, 0);

  return {
    depths: sorted.map((p) => p.depth),
    inversions,
    maxInversionLayer,
    missing: { blockCount: blocks.length, missingCount, blocks },
  };
}

module.exports = { referenceState };
