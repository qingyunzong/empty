// Quality vocabulary and the three-valued confidence model.
//
// quality ∈ { good, suspect, unknown, bad }
//   - weight: how strongly an observation pulls the window mean.
//   - reliability: three-valued truth used for window confidence.
//     "unknown" is genuinely unknown — it is NOT a failure.
export const QUALITIES = ['good', 'suspect', 'unknown', 'bad'];

export const WEIGHTS = {
  good: 1,
  suspect: 0.5,
  unknown: 0.5,
  bad: 0,
};

export function reliabilityOf(quality) {
  if (quality === 'bad') return false;
  if (quality === 'unknown') return 'unknown';
  return true;
}

export function normQuality(quality) {
  if (quality == null) return 'good';
  if (!QUALITIES.includes(quality)) {
    throw new Error(`unknown quality marker: ${quality} (expected one of ${QUALITIES.join(', ')})`);
  }
  return quality;
}
