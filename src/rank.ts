export interface Observation {
  value: number;
  weight: number;
}

export interface ScoreEntry {
  id: string;
  value: number;
  weight: number;
  score: number;
}

function checkObservation(value: number, weight: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`value must be finite, got ${value}`);
  }
  if (!Number.isFinite(weight) || weight < 0) {
    throw new RangeError(`weight must be a finite non-negative number, got ${weight}`);
  }
}

/**
 * Exact weighted ranking index.
 *
 * Percentile convention (mid-rank): for a value v the percentile is
 *   (weight of items with value < v + half the weight of items with value == v)
 *   / total weight.
 *
 * Updates and deletes are exact: every mutation adjusts the stored
 * observations precisely, no sketching or approximation is used.
 */
export class WeightedRank {
  private items = new Map<string, Observation>();
  private generation = 0;

  get size(): number {
    return this.items.size;
  }

  /** Bumped exactly once per committed mutation batch. */
  get gen(): number {
    return this.generation;
  }

  upsert(id: string, value: number, weight: number): void {
    checkObservation(value, weight);
    this.items.set(id, { value, weight });
    this.generation += 1;
  }

  remove(id: string): boolean {
    const removed = this.items.delete(id);
    if (removed) {
      this.generation += 1;
    }
    return removed;
  }

  /** Atomically swaps the whole observation set in a single generation. */
  replaceAll(entries: Iterable<[string, Observation]>): void {
    const next = new Map<string, Observation>();
    for (const [id, o] of entries) {
      checkObservation(o.value, o.weight);
      next.set(id, { value: o.value, weight: o.weight });
    }
    this.items = next;
    this.generation += 1;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): Observation | undefined {
    const o = this.items.get(id);
    return o === undefined ? undefined : { ...o };
  }

  entries(): Array<[string, Observation]> {
    return [...this.items.entries()].map(([id, o]) => [id, { ...o }]);
  }

  totalWeight(): number {
    let total = 0;
    for (const o of this.items.values()) {
      total += o.weight;
    }
    return total;
  }

  /** Mid-rank percentile of `value`; null when the index is empty. */
  percentileOf(value: number): number | null {
    if (this.items.size === 0) {
      return null;
    }
    let less = 0;
    let equal = 0;
    let total = 0;
    for (const o of this.items.values()) {
      total += o.weight;
      if (o.value < value) {
        less += o.weight;
      } else if (o.value === value) {
        equal += o.weight;
      }
    }
    if (total === 0) {
      return null;
    }
    return (less + equal / 2) / total;
  }

  /** Percentile score of a stored observation; null when absent or empty. */
  scoreOf(id: string): number | null {
    const o = this.items.get(id);
    if (o === undefined) {
      return null;
    }
    return this.percentileOf(o.value);
  }

  /** All scores; an empty array when the index is empty. */
  scores(): ScoreEntry[] {
    if (this.items.size === 0) {
      return [];
    }
    const total = this.totalWeight();
    if (total === 0) {
      return [];
    }
    const result: ScoreEntry[] = [];
    for (const [id, o] of this.items) {
      let less = 0;
      let equal = 0;
      for (const other of this.items.values()) {
        if (other.value < o.value) {
          less += other.weight;
        } else if (other.value === o.value) {
          equal += other.weight;
        }
      }
      result.push({ id, value: o.value, weight: o.weight, score: (less + equal / 2) / total });
    }
    return result;
  }
}
