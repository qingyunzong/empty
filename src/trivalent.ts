export type TV = 'allow' | 'deny' | 'unknown';

export function tvAnd(...values: TV[]): TV {
  let sawUnknown = false;
  for (const v of values) {
    if (v === 'deny') return 'deny';
    if (v === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'allow';
}

export function tvOr(...values: TV[]): TV {
  let sawUnknown = false;
  for (const v of values) {
    if (v === 'allow') return 'allow';
    if (v === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'deny';
}

export function tvNot(value: TV): TV {
  if (value === 'allow') return 'deny';
  if (value === 'deny') return 'allow';
  return 'unknown';
}
