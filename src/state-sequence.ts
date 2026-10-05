export type Value = number | string;

export interface Sample {
  /** Integer tick at which the sample takes effect. */
  time: number;
  value: Value;
  /** Corrections at the same time: the higher version wins. */
  version: number;
  /** Ticks the sample stays valid. Undefined means "until the next sample". */
  ttl?: number;
}

export interface Segment {
  /** Inclusive start tick. */
  start: number;
  /** Exclusive end tick. */
  end: number;
  /** Held value, or null for an expired hole. */
  value: Value | null;
}

function assertInteger(name: string, n: number): void {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${name} must be a safe integer, got ${n}`);
  }
}

/**
 * A state sequence: each sample holds from its own tick until the next
 * sample's tick or until its own TTL expires, whichever comes first.
 * An expired hole is never extended: deleting the successor sample does
 * not resurrect a sample whose TTL has already elapsed.
 */
export class StateSequence {
  private readonly byTime = new Map<number, Sample>();
  private sorted: Sample[] | null = null;

  get size(): number {
    return this.byTime.size;
  }

  /**
   * Insert a sample. At an already-occupied tick only a strictly higher
   * version replaces the existing sample; equal or lower versions are
   * rejected. Returns true when the sample was accepted.
   */
  insert(sample: Sample): boolean {
    assertInteger("time", sample.time);
    assertInteger("version", sample.version);
    if (sample.ttl !== undefined && !(sample.ttl > 0)) {
      throw new RangeError(`ttl must be positive, got ${sample.ttl}`);
    }
    const existing = this.byTime.get(sample.time);
    if (existing !== undefined && existing.version >= sample.version) {
      return false;
    }
    this.byTime.set(sample.time, { ...sample });
    this.sorted = null;
    return true;
  }

  /**
   * Delete the sample at a tick. When `version` is given, the sample is
   * removed only if its version matches. Returns true when a sample was
   * removed.
   */
  delete(time: number, version?: number): boolean {
    const existing = this.byTime.get(time);
    if (existing === undefined) return false;
    if (version !== undefined && existing.version !== version) return false;
    this.byTime.delete(time);
    this.sorted = null;
    return true;
  }

  /** All live samples, ordered by time. */
  samples(): Sample[] {
    return [...this.ordered()];
  }

  private ordered(): Sample[] {
    if (this.sorted === null) {
      this.sorted = [...this.byTime.values()].sort((a, b) => a.time - b.time);
    }
    return this.sorted;
  }

  /** Value held at tick `t`, or null when `t` falls into an expired hole. */
  valueAt(t: number): Value | null {
    assertInteger("t", t);
    const samples = this.ordered();
    let lo = 0;
    let hi = samples.length; // upper bound: first index with time > t
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid]!.time <= t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    const s = samples[lo - 1]!;
    if (s.ttl !== undefined && t >= s.time + s.ttl) return null;
    return s.value;
  }

  /**
   * Range query over the half-open interval [start, end). Returns the
   * maximal half-open segments of equal value covering the interval;
   * expired holes appear as segments with value null.
   */
  query(start: number, end: number): Segment[] {
    assertInteger("start", start);
    assertInteger("end", end);
    if (start >= end) {
      throw new RangeError(`empty range: [${start}, ${end})`);
    }
    const segments: Segment[] = [];
    let cursor = start;
    while (cursor < end) {
      const value = this.valueAt(cursor);
      let segEnd = end;
      if (value === null) {
        const next = this.nextSampleTimeAfter(cursor);
        if (next !== null && next < segEnd) segEnd = next;
      } else {
        const s = this.sampleAtOrBefore(cursor)!;
        if (s.ttl !== undefined && s.time + s.ttl < segEnd) {
          segEnd = s.time + s.ttl;
        }
        const next = this.nextSampleTimeAfter(cursor);
        if (next !== null && next < segEnd) segEnd = next;
      }
      segments.push({ start: cursor, end: segEnd, value });
      cursor = segEnd;
    }
    // Merge adjacent segments with equal value into maximal segments.
    const merged: Segment[] = [];
    for (const seg of segments) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.value === seg.value) {
        last.end = seg.end;
      } else {
        merged.push({ ...seg });
      }
    }
    return merged;
  }

  private sampleAtOrBefore(t: number): Sample | null {
    const samples = this.ordered();
    let lo = 0;
    let hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid]!.time <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? null : samples[lo - 1]!;
  }

  private nextSampleTimeAfter(t: number): number | null {
    const samples = this.ordered();
    let lo = 0;
    let hi = samples.length; // first index with time > t
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid]!.time <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo === samples.length ? null : samples[lo]!.time;
  }
}
