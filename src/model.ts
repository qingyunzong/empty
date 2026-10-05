/**
 * Brute-force reference model: a plainly sorted array plus a plain map.
 * Used by the tests to cross-check the persistent order-statistics index
 * and the conflict bounds at every step.
 */
import { quantileRank } from './quantile.js';

export class SortedList {
  private arr: number[] = [];

  size(): number {
    return this.arr.length;
  }

  insert(value: number): void {
    let lo = 0;
    let hi = this.arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.arr[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    this.arr.splice(lo, 0, value);
  }

  removeOne(value: number): void {
    const i = this.arr.indexOf(value);
    if (i < 0) throw new Error(`value ${value} not present`);
    this.arr.splice(i, 1);
  }

  at(index0: number): number {
    return this.arr[index0];
  }

  countLess(value: number): number {
    let n = 0;
    while (n < this.arr.length && this.arr[n] < value) n++;
    return n;
  }

  toArray(): number[] {
    return [...this.arr];
  }
}

/** Sliding-window model mirroring src/window.ts semantics with plain arrays. */
export class ModelWindow {
  private order: number[] = [];
  private values = new Map<number, number>();
  private sorted = new SortedList();

  constructor(readonly capacity: number) {}

  size(): number {
    return this.sorted.size();
  }

  add(eventId: number, value: number): void {
    if (this.values.has(eventId)) throw new Error(`duplicate event id ${eventId}`);
    if (this.order.length === this.capacity) {
      const oldest = this.order.shift()!;
      this.sorted.removeOne(this.values.get(oldest)!);
      this.values.delete(oldest);
    }
    this.order.push(eventId);
    this.values.set(eventId, value);
    this.sorted.insert(value);
  }

  remove(eventId: number): void {
    const value = this.values.get(eventId);
    if (value === undefined) return;
    this.values.delete(eventId);
    this.order = this.order.filter((id) => id !== eventId);
    this.sorted.removeOne(value);
  }

  correct(eventId: number, value: number): void {
    const old = this.values.get(eventId);
    if (old === undefined || old === value) return;
    this.values.set(eventId, value);
    this.sorted.removeOne(old);
    this.sorted.insert(value);
  }

  quantile(pNum: number, pDen: number): number | null {
    const n = this.sorted.size();
    if (n === 0) return null;
    return this.sorted.at(quantileRank(pNum, pDen, n) - 1);
  }

  toSortedArray(): number[] {
    return this.sorted.toArray();
  }
}
