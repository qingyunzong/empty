/**
 * VersionedArray: an integer array with historical snapshots.
 *
 * - Mutations are half-open range assignments: setRange(start, end, value)
 *   writes `value` into indices [start, end).
 * - Every effective mutation appends a new immutable snapshot and bumps the
 *   version. Empty updates (empty range, or a range already holding `value`)
 *   do NOT create a new version.
 * - diff(a, b) compares two versions and returns the maximal contiguous
 *   differing intervals with their before/after values. Adjacent positions
 *   whose delta (after - before) is identical are merged into one interval.
 */

export interface DiffInterval {
  /** Inclusive start index. */
  start: number;
  /** Exclusive end index. */
  end: number;
  /** Values in the `from` version over [start, end). */
  before: number[];
  /** Values in the `to` version over [start, end). */
  after: number[];
}

export class VersionedArray {
  private readonly snapshots: number[][];

  constructor(
    public readonly length: number,
    initial = 0,
  ) {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError(`length must be a non-negative integer, got ${length}`);
    }
    this.snapshots = [new Array<number>(length).fill(initial)];
  }

  /** Current version number (0 = initial state). */
  get version(): number {
    return this.snapshots.length - 1;
  }

  /** Read a single element at a given version (defaults to current). */
  at(index: number, version = this.version): number {
    return this.stateAt(version)[index];
  }

  /** Copy of the full array at a given version (defaults to current). */
  snapshot(version = this.version): number[] {
    return this.stateAt(version).slice();
  }

  /**
   * Assign `value` to the half-open range [start, end).
   * Returns the version after the operation; an empty update
   * (start >= end, or nothing actually changes) keeps the version.
   */
  setRange(start: number, end: number, value: number): number {
    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(value)) {
      throw new TypeError("start, end and value must be integers");
    }
    if (start < 0 || end > this.length || start > end) {
      throw new RangeError(`invalid range [${start}, ${end}) for length ${this.length}`);
    }
    const current = this.snapshots[this.snapshots.length - 1];
    if (start === end) return this.version; // empty range: no-op

    let changed = false;
    for (let i = start; i < end; i++) {
      if (current[i] !== value) {
        changed = true;
        break;
      }
    }
    if (!changed) return this.version; // empty update: no new version

    const next = current.slice();
    next.fill(value, start, end);
    this.snapshots.push(next);
    return this.version;
  }

  /**
   * Maximal contiguous differing intervals between two versions.
   * Adjacent differing positions with the same delta (after - before)
   * are merged into a single interval.
   */
  diff(fromVersion: number, toVersion: number): DiffInterval[] {
    const before = this.stateAt(fromVersion);
    const after = this.stateAt(toVersion);
    const intervals: DiffInterval[] = [];

    let i = 0;
    while (i < this.length) {
      if (before[i] === after[i]) {
        i++;
        continue;
      }
      const delta = after[i] - before[i];
      const start = i;
      i++;
      // Merge adjacent positions sharing the same delta.
      while (i < this.length && before[i] !== after[i] && after[i] - before[i] === delta) {
        i++;
      }
      intervals.push({
        start,
        end: i,
        before: before.slice(start, i),
        after: after.slice(start, i),
      });
    }
    return intervals;
  }

  private stateAt(version: number): number[] {
    if (!Number.isInteger(version) || version < 0 || version > this.version) {
      throw new RangeError(`unknown version ${version} (current: ${this.version})`);
    }
    return this.snapshots[version];
  }
}
