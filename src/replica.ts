import { VersionVector } from './version-vector.js';
import {
  DominanceEvidence,
  VersionedValue,
  mergeSiblings,
} from './siblings.js';

/**
 * One storage node. Each key maps to a minimal conflict set of sibling
 * versions: every stored version is pairwise concurrent with the others.
 */
export class Replica<T = unknown> {
  private readonly data = new Map<string, VersionedValue<T>[]>();

  constructor(readonly id: string) {}

  /**
   * Local write. `context` is the causal context the client observed on its
   * last read; the new version supersedes exactly those versions, while
   * versions the client never saw stay concurrent and are preserved.
   */
  write(
    key: string,
    value: T,
    context: VersionVector = VersionVector.zero(),
    evidence?: DominanceEvidence[],
  ): VersionedValue<T> {
    const item: VersionedValue<T> = {
      value,
      vv: context.increment(this.id),
    };
    this.data.set(
      key,
      mergeSiblings([...this.readLocal(key), item], evidence),
    );
    return item;
  }

  readLocal(key: string): VersionedValue<T>[] {
    return [...(this.data.get(key) ?? [])];
  }

  /** Anti-entropy / read-repair entry point: set-merge a remote conflict set in. */
  accept(
    key: string,
    siblings: readonly VersionedValue<T>[],
    evidence?: DominanceEvidence[],
  ): void {
    const merged = mergeSiblings([...this.readLocal(key), ...siblings], evidence);
    if (merged.length === 0) this.data.delete(key);
    else this.data.set(key, merged);
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}
