import { cloneSnapshot, emptySnapshot } from './snapshot.js';
import type { StateStore } from './types.js';
import type { DeltaQueueSnapshot } from './snapshot.js';

/**
 * Reference StateStore kept fully in process memory. Clones on load/save so
 * callers cannot mutate committed state through retained references.
 */
export class InMemoryStateStore implements StateStore {
  private snapshot: DeltaQueueSnapshot;

  constructor(initial: DeltaQueueSnapshot = emptySnapshot()) {
    this.snapshot = cloneSnapshot(initial);
  }

  async load(): Promise<DeltaQueueSnapshot> {
    return cloneSnapshot(this.snapshot);
  }

  async save(snapshot: DeltaQueueSnapshot): Promise<void> {
    this.snapshot = cloneSnapshot(snapshot);
  }
}
