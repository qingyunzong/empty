/** Number of decimal digits of |value| (the sign never counts). */
export function digitCount(value: bigint): number {
  const v = value < 0n ? -value : value;
  return v.toString().length;
}

export function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}
