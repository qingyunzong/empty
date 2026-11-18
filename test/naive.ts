import type { WindowRecord } from '../src/index.js';

interface NaiveEntry {
  at: number;
  state: 'reserved' | 'passed';
  expiresAt: number | null;
}

export class NaiveShard {
  readonly id: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly reservationTtlMs: number;
  readonly entries = new Map<string, NaiveEntry>();
  accepted = 0;
  committed = 0;
  released = 0;

  constructor(
    id: string,
    limit: number,
    windowMs: number,
    reservationTtlMs: number,
  ) {
    this.id = id;
    this.limit = limit;
    this.windowMs = windowMs;
    this.reservationTtlMs = reservationTtlMs;
  }

  tick(now: number): number {
    let expired = 0;
    for (const [id, entry] of this.entries) {
      if (entry.state === 'reserved' && entry.expiresAt !== null && entry.expiresAt <= now) {
        this.entries.delete(id);
        this.released += 1;
        expired += 1;
      }
    }
    return expired;
  }

  reserve(id: string, at: number): boolean {
    this.tick(at);
    if (this.entries.has(id)) {
      return false;
    }
    if (this.#countWithCandidate(at) > this.limit) {
      return false;
    }
    this.entries.set(id, {
      at,
      state: 'reserved',
      expiresAt: at + this.reservationTtlMs,
    });
    this.accepted += 1;
    return true;
  }

  commit(id: string, at: number): boolean {
    this.tick(at);
    const entry = this.entries.get(id);
    if (entry === undefined || entry.state !== 'reserved') {
      return false;
    }
    entry.state = 'passed';
    entry.expiresAt = null;
    this.committed += 1;
    return true;
  }

  release(id: string, at: number): boolean {
    this.tick(at);
    const entry = this.entries.get(id);
    if (entry === undefined || entry.state !== 'reserved') {
      return false;
    }
    this.entries.delete(id);
    this.released += 1;
    return true;
  }

  liveReservedIds(): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.state === 'reserved')
      .sort((left, right) => left[1].at - right[1].at || left[0].localeCompare(right[0]))
      .map(([id]) => id);
  }

  records(now: number): WindowRecord[] {
    this.tick(now);
    return [...this.entries.entries()]
      .map(([id, entry]) => ({ id, at: entry.at, state: entry.state }))
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  }

  remaining(now: number): number {
    this.tick(now);
    let used = 0;
    for (const entry of this.entries.values()) {
      if (entry.at > now - this.windowMs && entry.at <= now) {
        used += 1;
      }
    }
    return Math.max(0, this.limit - used);
  }

  #countWithCandidate(at: number): number {
    const times = [...this.entries.values()].map((entry) => entry.at);
    const starts = [at - this.windowMs];
    for (const time of times) {
      const start = time - this.windowMs;
      if (start >= at - this.windowMs && start < at) {
        starts.push(start);
      }
    }
    let best = 0;
    for (const start of starts) {
      const count = times.filter(
        (time) => time > start && time <= start + this.windowMs,
      ).length;
      best = Math.max(best, count);
    }
    return best + 1;
  }
}
