export type Dominance = 'equal' | 'dominates' | 'dominated' | 'concurrent';

/** Immutable vector clock keyed by replica id. */
export class VersionVector {
  private constructor(readonly entries: ReadonlyMap<string, number>) {}

  static zero(): VersionVector {
    return new VersionVector(new Map());
  }

  static from(entries: Iterable<readonly [string, number]>): VersionVector {
    const clean = new Map<string, number>();
    for (const [id, n] of entries) {
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`invalid counter for ${id}: ${n}`);
      }
      if (n > 0) clean.set(id, n);
    }
    return new VersionVector(clean);
  }

  get(id: string): number {
    return this.entries.get(id) ?? 0;
  }

  increment(id: string): VersionVector {
    const next = new Map(this.entries);
    next.set(id, this.get(id) + 1);
    return new VersionVector(next);
  }

  /** Pointwise max — the causal-context join. */
  merge(other: VersionVector): VersionVector {
    const out = new Map<string, number>();
    for (const id of this.entries.keys()) out.set(id, this.get(id));
    for (const id of other.entries.keys()) {
      out.set(id, Math.max(this.get(id), other.get(id)));
    }
    return VersionVector.from(out);
  }

  compare(other: VersionVector): Dominance {
    let thisGreater = false;
    let otherGreater = false;
    const ids = new Set([...this.entries.keys(), ...other.entries.keys()]);
    for (const id of ids) {
      const a = this.get(id);
      const b = other.get(id);
      if (a > b) thisGreater = true;
      else if (a < b) otherGreater = true;
      if (thisGreater && otherGreater) return 'concurrent';
    }
    if (thisGreater) return 'dominates';
    if (otherGreater) return 'dominated';
    return 'equal';
  }

  equals(other: VersionVector): boolean {
    return this.compare(other) === 'equal';
  }

  toString(): string {
    const parts = [...this.entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}:${v}`);
    return `{${parts.join(', ')}}`;
  }
}
