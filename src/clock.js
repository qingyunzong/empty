// Vector-clock utilities. A clock is a plain object {site: counter}.

export function clockLe(a, b) {
  for (const k of Object.keys(a)) {
    if ((b[k] ?? 0) < a[k]) return false;
  }
  return true;
}

export function clockEq(a, b) {
  return clockLe(a, b) && clockLe(b, a);
}

// Strict happens-before.
export function clockLt(a, b) {
  return clockLe(a, b) && !clockLe(b, a);
}

export function clockMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = Math.max(out[k] ?? 0, b[k]);
  }
  return out;
}
