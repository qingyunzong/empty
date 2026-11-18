import type { ReservationState } from './types.js';

export interface WindowRecord {
  id: string;
  at: number;
  state: ReservationState;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function insertSorted(values: number[], value: number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  values.splice(low, 0, value);
}

function removeSorted(values: number[], value: number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((values[middle] as number) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (values[low] === value) {
    values.splice(low, 1);
  }
}

export class SlidingWindow {
  readonly windowMs: number;
  #records = new Map<string, WindowRecord>();
  #times: number[] = [];

  constructor(windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be a finite positive number');
    }
    this.windowMs = windowMs;
  }

  get size(): number {
    return this.#records.size;
  }

  has(id: string): boolean {
    return this.#records.has(id);
  }

  get(id: string): WindowRecord | undefined {
    const record = this.#records.get(id);
    return record === undefined ? undefined : { ...record };
  }

  add(record: WindowRecord): boolean {
    if (!Number.isFinite(record.at)) {
      throw new RangeError('record.at must be finite');
    }
    if (this.#records.has(record.id)) {
      return false;
    }
    this.#records.set(record.id, { ...record });
    insertSorted(this.#times, record.at);
    return true;
  }

  commit(id: string): boolean {
    const record = this.#records.get(id);
    if (record === undefined || record.state !== 'reserved') {
      return false;
    }
    this.#records.set(id, { ...record, state: 'passed' });
    return true;
  }

  release(id: string): boolean {
    const record = this.#records.get(id);
    if (record === undefined) {
      return false;
    }
    this.#records.delete(id);
    removeSorted(this.#times, record.at);
    return true;
  }

  records(): WindowRecord[] {
    return [...this.#records.values()]
      .map((record) => ({ ...record }))
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  }

  times(): number[] {
    return [...this.#times];
  }

  usageAt(now: number): number {
    const end = upperBound(this.#times, now);
    const start = upperBound(this.#times, now - this.windowMs);
    return end - start;
  }

  remainingAt(now: number, limit: number): number {
    return Math.max(0, limit - this.usageAt(now));
  }

  maxUsage(): number {
    if (this.#times.length === 0) {
      return 0;
    }
    let best = 0;
    let left = 0;
    for (let right = 0; right < this.#times.length; right += 1) {
      const rightTime = this.#times[right] as number;
      while ((this.#times[left] as number) <= rightTime - this.windowMs) {
        left += 1;
      }
      best = Math.max(best, right - left + 1);
    }
    return best;
  }

  maxUsageWith(at: number): number {
    const windowStart = at - this.windowMs;
    let best = this.#countStartingAt(windowStart);
    const end = at + this.windowMs;
    for (
      let index = lowerBound(this.#times, at);
      index < this.#times.length;
      index += 1
    ) {
      const time = this.#times[index] as number;
      if (time >= end) {
        break;
      }
      best = Math.max(best, this.#countStartingAt(time - this.windowMs));
    }
    return best + 1;
  }

  admit(at: number, limit: number): boolean {
    return this.maxUsageWith(at) <= limit;
  }

  compact(now: number): number {
    let removed = 0;
    for (const record of [...this.#records.values()]) {
      if (record.state === 'passed' && record.at <= now - this.windowMs) {
        this.release(record.id);
        removed += 1;
      }
    }
    return removed;
  }

  #countStartingAt(start: number): number {
    return (
      upperBound(this.#times, start + this.windowMs) -
      upperBound(this.#times, start)
    );
  }
}

export function maxWindowUsage(times: readonly number[], windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a finite positive number');
  }
  const sorted = [...times].sort((left, right) => left - right);
  let best = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    const rightTime = sorted[right] as number;
    while ((sorted[left] as number) <= rightTime - windowMs) {
      left += 1;
    }
    best = Math.max(best, right - left + 1);
  }
  return best;
}
