// Vector clock utilities. A vector clock maps siteId -> logical counter.

export function compare(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let less = false;
  let greater = false;
  for (const k of keys) {
    const x = a[k] || 0;
    const y = b[k] || 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  if (less && greater) return 'concurrent';
  if (less) return 'before';
  if (greater) return 'after';
  return 'equal';
}

export const happensBefore = (a, b) => compare(a, b) === 'before';
export const isConcurrent = (a, b) => compare(a, b) === 'concurrent';
