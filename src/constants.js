export const DENSITY_MIN = 0.95; // g/mL, water-like beverages
export const DENSITY_MAX = 1.05;
export const WATERMARK_LAG_MS = 3 * 60 * 1000; // watermark = max event time - 3min

export const STATUS = Object.freeze({
  HOLD: 'HOLD',
  RELEASE: 'RELEASE',
  REJECT: 'REJECT',
});

// Severity rank. Transitions may only increase rank, except the audited
// compensation path RELEASE -> HOLD (lab retract / fill retract / cip retract).
export const RANK = Object.freeze({ HOLD: 0, RELEASE: 1, REJECT: 2 });
