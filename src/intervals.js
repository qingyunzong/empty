import { AuditError, E_INTERVAL } from './errors.js';

export function validateInterval(iv) {
  if (iv === null || typeof iv !== 'object' || Array.isArray(iv)) {
    throw new AuditError(E_INTERVAL, 'interval must be an object {start, end}');
  }
  const { start, end } = iv;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new AuditError(E_INTERVAL, `interval bounds must be integers, got [${start}, ${end})`);
  }
  if (start >= end) {
    throw new AuditError(E_INTERVAL, `invalid interval [${start}, ${end}): start must be < end`);
  }
}

export function normalize(intervals) {
  if (!Array.isArray(intervals)) {
    throw new AuditError(E_INTERVAL, 'intervals must be an array');
  }
  const sorted = intervals
    .map((iv) => {
      validateInterval(iv);
      return { start: iv.start, end: iv.end };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

export function union(a, b) {
  return normalize([...a, ...b]);
}

export function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].start, b[j].start);
    const e = Math.min(a[i].end, b[j].end);
    if (s < e) out.push({ start: s, end: e });
    if (a[i].end < b[j].end) i += 1;
    else j += 1;
  }
  return out;
}

export function difference(a, b) {
  const out = [];
  for (const iv of a) {
    let segments = [{ start: iv.start, end: iv.end }];
    for (const cut of b) {
      const next = [];
      for (const seg of segments) {
        if (cut.end <= seg.start || cut.start >= seg.end) {
          next.push(seg);
          continue;
        }
        if (seg.start < cut.start) next.push({ start: seg.start, end: cut.start });
        if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end });
      }
      segments = next;
    }
    out.push(...segments);
  }
  return out;
}

// Half-open semantics: [0,5) and [5,9) touch but do NOT overlap.
export function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function anyOverlap(a, b) {
  return intersect(a, b).length > 0;
}

export function containsPoint(set, point) {
  let lo = 0;
  let hi = set.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = set[mid];
    if (point < iv.start) hi = mid - 1;
    else if (point >= iv.end) lo = mid + 1;
    else return true;
  }
  return false;
}

export function gaps(set, lo, hi) {
  validateInterval({ start: lo, end: hi });
  return difference([{ start: lo, end: hi }], set);
}
