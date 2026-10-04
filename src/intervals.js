export class RecallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function checkInterval(start, end, what = 'interval') {
  if (start > end) {
    throw new RecallError('REVERSED_INTERVAL', `${what}: start ${start} is after end ${end}`);
  }
}

export class IntervalSet {
  constructor(intervals = []) {
    const sorted = intervals
      .map(([s, e]) => {
        checkInterval(s, e);
        return [s, e];
      })
      .filter(([s, e]) => s < e)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.intervals = [];
    for (const [s, e] of sorted) {
      const last = this.intervals[this.intervals.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else this.intervals.push([s, e]);
    }
  }

  static empty() {
    return new IntervalSet();
  }

  static of(start, end) {
    return new IntervalSet([[start, end]]);
  }

  isEmpty() {
    return this.intervals.length === 0;
  }

  union(other) {
    return new IntervalSet([...this.intervals, ...other.intervals]);
  }

  intersect(other) {
    const out = [];
    const a = this.intervals;
    const b = other.intervals;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const s = Math.max(a[i][0], b[j][0]);
      const e = Math.min(a[i][1], b[j][1]);
      if (s < e) out.push([s, e]);
      if (a[i][1] < b[j][1]) i += 1;
      else j += 1;
    }
    return new IntervalSet(out);
  }

  difference(other) {
    let remaining = this.intervals.map((x) => [...x]);
    for (const [s, e] of other.intervals) {
      const next = [];
      for (const [cs, ce] of remaining) {
        if (e <= cs || s >= ce) {
          next.push([cs, ce]);
          continue;
        }
        if (cs < s) next.push([cs, s]);
        if (e < ce) next.push([e, ce]);
      }
      remaining = next;
    }
    return new IntervalSet(remaining);
  }

  overlaps(other) {
    return !this.intersect(other).isEmpty();
  }

  toJSON() {
    return this.intervals;
  }
}
