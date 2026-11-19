export const RATIO_SCALE = 10000;

export function scaledRatio(ratio: number): number {
  return Math.round(ratio * RATIO_SCALE);
}

export function ceilDiv(numerator: number, denominator: number): number {
  const quotient = Math.trunc(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  return remainder === 0 ? quotient : quotient + 1;
}

export function ceilRatio(base: number, numerator: number, denominator: number): number {
  return ceilDiv(base * numerator, denominator);
}

export function floorRatio(base: number, numerator: number, denominator: number): number {
  return Math.trunc((base * numerator) / denominator);
}
