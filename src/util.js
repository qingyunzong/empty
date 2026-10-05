export function toIso(ms) {
  return new Date(ms).toISOString();
}

export function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
