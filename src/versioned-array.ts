/**
 * VersionedArray: an integer array with half-open interval assignment,
 * historical snapshots, and version diffing.
 *
 * Internal representation: each version is an immutable, sorted,
 * coalesced list of run-length segments covering [0, length).
 */

export interface Segment {
  /** inclusive */
  start: number;
  /** exclusive */
  end: number;
  value: number;
}

export interface DiffInterval {
  /** inclusive */
  start: number;
  /** exclusive */
  end: number;
  /** value in the `from` version */
  before: number;
  /** value in the `to` version */
  after: number;
}

function segmentsEqual(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end || a[i].value !== b[i].value) {
      return false;
    }
  }
  return true;
}

/** Assign `value` to [start, end) of a segment list, returning a new coalesced list. */
function setRange(segs: Segment[], start: number, end: number, value: number): Segment[] {
  const out: Segment[] = [];
  const push = (s: number, e: number, v: number) => {
    if (s >= e) return;
    const last = out[out.length - 1];
    if (last && last.value === v && last.end === s) {
      last.end = e;
    } else {
      out.push({ start: s, end: e, value: v });
    }
  };
  for (const seg of segs) {
    if (seg.end <= start || seg.start >= end) {
      push(seg.start, seg.end, seg.value);
      continue;
    }
    push(seg.start, Math.min(seg.end, start), seg.value);
    push(Math.max(seg.start, start), Math.min(seg.end, end), value);
    push(Math.max(seg.start, end), seg.end, seg.value);
  }
  return out;
}

/** Diff two segment lists; adjacent positions with the same (before, after) pair are merged. */
export function diffSegments(from: Segment[], to: Segment[]): DiffInterval[] {
  const out: DiffInterval[] = [];
  let i = 0;
  let j = 0;
  const emit = (start: number, end: number, before: number, after: number) => {
    if (before === after || start >= end) return;
    const last = out[out.length - 1];
    if (last && last.before === before && last.after === after && last.end === start) {
      last.end = end;
    } else {
      out.push({ start, end, before, after });
    }
  };
  while (i < from.length && j < to.length) {
    const a = from[i];
    const b = to[j];
    const lo = Math.max(a.start, b.start);
    const hi = Math.min(a.end, b.end);
    if (lo < hi) emit(lo, hi, a.value, b.value);
    if (a.end <= b.end) i++;
    if (b.end <= a.end) j++;
  }
  return out;
}

export class VersionedArray {
  readonly length: number;
  private readonly versions: Segment[][];

  constructor(length: number, initialValue = 0) {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError(`length must be a non-negative integer, got ${length}`);
    }
    this.length = length;
    this.versions = [length === 0 ? [] : [{ start: 0, end: length, value: initialValue }]];
  }

  /** Current version number (0-based; starts at 0). */
  get version(): number {
    return this.versions.length - 1;
  }

  /**
   * Assign `value` to the half-open interval [start, end).
   * Returns the version after the update. If nothing actually changes
   * (empty interval or identical values), no new version is created.
   */
  set(start: number, end: number, value: number): number {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new RangeError(`start/end must be integers, got [${start}, ${end})`);
    }
    if (start < 0 || end > this.length || start > end) {
      throw new RangeError(`invalid interval [${start}, ${end}) for length ${this.length}`);
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(`value must be an integer, got ${value}`);
    }
    const current = this.versions[this.versions.length - 1];
    if (start === end) return this.version;
    const next = setRange(current, start, end, value);
    if (segmentsEqual(current, next)) return this.version;
    this.versions.push(next);
    return this.version;
  }

  /** Read a single index at a given version (defaults to latest). */
  get(index: number, version = this.version): number {
    const segs = this.segments(version);
    if (index < 0 || index >= this.length) {
      throw new RangeError(`index ${index} out of bounds for length ${this.length}`);
    }
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].end <= index) lo = mid + 1;
      else hi = mid;
    }
    return segs[lo].value;
  }

  /** Materialize a version as a plain number array. */
  toArray(version = this.version): number[] {
    const out = new Array<number>(this.length);
    for (const seg of this.segments(version)) {
      out.fill(seg.value, seg.start, seg.end);
    }
    return out;
  }

  /**
   * Compare two versions. Returns the maximal contiguous intervals on which
   * they differ, each annotated with the before/after values. Adjacent
   * positions sharing the same (before, after) pair are merged into one
   * interval.
   */
  diff(fromVersion: number, toVersion: number): DiffInterval[] {
    return diffSegments(this.segments(fromVersion), this.segments(toVersion));
  }

  private segments(version: number): Segment[] {
    if (!Number.isInteger(version) || version < 0 || version > this.version) {
      throw new RangeError(`unknown version ${version}; valid range is [0, ${this.version}]`);
    }
    return this.versions[version];
  }
}
