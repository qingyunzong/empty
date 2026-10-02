import { WEIGHTS } from './quality.js';

// The seven counters every window aggregate is built from. Both the
// incremental (Fenwick) path and the brute-force replay path accumulate
// exactly these, which is what makes them comparable.
export function zeroCounts() {
  return {
    weightSum: 0,
    weightedValueSum: 0,
    usedCount: 0,
    nullCount: 0,
    deletedCount: 0,
    badCount: 0,
    unknownCount: 0,
  };
}

// Fold one visible version into the counters.
//   - tombstone (delete)        -> masked, counted, never physical
//   - value === null            -> missing (缺测): ignored by the mean, counted
//   - quality bad               -> excluded from the mean, drags confidence low
//   - quality unknown           -> weighted into the mean, confidence "unknown"
export function accumulate(counts, version) {
  if (!version) return counts;
  if (version.deleted) {
    counts.deletedCount += 1;
    return counts;
  }
  if (version.value === null) {
    counts.nullCount += 1;
    return counts;
  }
  if (version.quality === 'bad') {
    counts.badCount += 1;
    return counts;
  }
  const w = WEIGHTS[version.quality] ?? 0;
  counts.weightSum += w;
  counts.weightedValueSum += w * version.value;
  counts.usedCount += 1;
  if (version.quality === 'unknown') counts.unknownCount += 1;
  return counts;
}

// Window confidence is the Kleene AND of per-observation reliability:
// any failure -> "low"; else any unknown -> "unknown"; else data -> "high".
// An empty/all-missing window is honestly "unknown", never a fake "high".
export function summarize(counts) {
  const mean = counts.weightSum > 0 ? counts.weightedValueSum / counts.weightSum : null;
  let confidence;
  if (counts.badCount > 0) confidence = 'low';
  else if (counts.unknownCount > 0) confidence = 'unknown';
  else if (counts.usedCount > 0) confidence = 'high';
  else confidence = 'unknown';
  return { mean, ...counts, confidence };
}
