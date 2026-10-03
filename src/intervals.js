'use strict';

// Half-open interval sets [start, end). Endpoint touching does NOT count as
// overlapping: [0, 5) and [5, 10) are disjoint.

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function checkInterval(iv) {
  if (
    !iv ||
    typeof iv.start !== 'number' ||
    typeof iv.end !== 'number' ||
    !Number.isFinite(iv.start) ||
    !Number.isFinite(iv.end)
  ) {
    throw makeError('ERR_INVALID_INTERVAL', `invalid interval bounds: ${JSON.stringify(iv)}`);
  }
  if (iv.start > iv.end) {
    throw makeError('ERR_INTERVAL_REVERSED', `interval reversed: [${iv.start}, ${iv.end})`);
  }
}

class IntervalSet {
  constructor(intervals = []) {
    const sorted = [];
    for (const iv of intervals) {
      checkInterval(iv);
      if (iv.start < iv.end) sorted.push({ start: iv.start, end: iv.end });
    }
    sorted.sort((a, b) => a.start - b.start || a.end - b.end);
    this.intervals = [];
    for (const iv of sorted) {
      const last = this.intervals[this.intervals.length - 1];
      if (last && iv.start <= last.end) {
        // merge overlapping or adjacent pieces into a canonical form
        if (iv.end > last.end) last.end = iv.end;
      } else {
        this.intervals.push({ start: iv.start, end: iv.end });
      }
    }
  }

  static of(start, end) {
    return new IntervalSet([{ start, end }]);
  }

  isEmpty() {
    return this.intervals.length === 0;
  }

  union(other) {
    return new IntervalSet([...this.intervals, ...other.intervals]);
  }

  intersect(other) {
    const out = [];
    let i = 0;
    let j = 0;
    const a = this.intervals;
    const b = other.intervals;
    while (i < a.length && j < b.length) {
      const start = Math.max(a[i].start, b[j].start);
      const end = Math.min(a[i].end, b[j].end);
      if (start < end) out.push({ start, end });
      if (a[i].end < b[j].end) i += 1;
      else j += 1;
    }
    return new IntervalSet(out);
  }

  subtract(other) {
    let pieces = this.intervals.map((iv) => ({ ...iv }));
    for (const cut of other.intervals) {
      const next = [];
      for (const p of pieces) {
        if (cut.end <= p.start || cut.start >= p.end) {
          next.push(p);
          continue;
        }
        if (p.start < cut.start) next.push({ start: p.start, end: cut.start });
        if (cut.end < p.end) next.push({ start: cut.end, end: p.end });
      }
      pieces = next;
    }
    return new IntervalSet(pieces);
  }

  // True only when the two sets share an interval of positive length.
  // Merely touching endpoints returns false.
  overlapsPositive(other) {
    return !this.intersect(other).isEmpty();
  }

  measure() {
    return this.intervals.reduce((acc, iv) => acc + (iv.end - iv.start), 0);
  }

  toJSON() {
    return this.intervals.map((iv) => ({ start: iv.start, end: iv.end }));
  }
}

module.exports = { IntervalSet, makeError };
