import type { Item, Message, MessageListener, Policy } from './types.js';
import { ControllableExecutor } from './executor.js';

/**
 * Computes the authorized visible result set synchronously.
 * This is the ground truth used to reconcile the asynchronously
 * maintained subscription state.
 */
export function syncAuthorizedView(
  items: ReadonlyMap<string, Item>,
  policy: Policy,
): ReadonlyMap<string, Item> {
  const visible = new Map<string, Item>();
  for (const [id, item] of items) {
    if (policy.allows(item)) visible.set(id, item);
  }
  return visible;
}

/**
 * Maintains the authorized visible result set of a subscription.
 *
 * Guarantees:
 *  1. Delete-before-add: whenever a recompute (e.g. after a policy
 *     revocation) both hides and reveals items, all `delete` messages are
 *     published before any `add` message of the same batch.
 *  2. Version binding: every message carries a version starting at 1 and
 *     increasing by exactly 1.
 *  3. Stale suppression: authorization checks run asynchronously through a
 *     ControllableExecutor; if a newer change arrives while checks are in
 *     flight, the older (stale) result is discarded and never published.
 */
export class SubscriptionLibrary {
  private readonly items = new Map<string, Item>();
  private visible = new Map<string, Item>();
  private policy: Policy;
  private generation = 0;
  private version = 0;
  private readonly listeners: MessageListener[] = [];
  private readonly published: Message[] = [];

  constructor(
    policy: Policy,
    private readonly executor: ControllableExecutor = new ControllableExecutor(),
  ) {
    this.policy = policy;
    this.scheduleRecompute();
  }

  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  /** All messages published so far, in order. */
  get messages(): readonly Message[] {
    return this.published;
  }

  /** Current visible result set (ids). */
  get visibleIds(): ReadonlySet<string> {
    return new Set(this.visible.keys());
  }

  /** Current visible result set (id -> item). */
  get visibleItems(): ReadonlyMap<string, Item> {
    return new Map(this.visible);
  }

  get currentVersion(): number {
    return this.version;
  }

  upsert(item: Item): void {
    this.items.set(item.id, item);
    this.scheduleRecompute();
  }

  remove(id: string): void {
    this.items.delete(id);
    this.scheduleRecompute();
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
    this.scheduleRecompute();
  }

  /** Ground-truth check: does the live state match a synchronous auth query? */
  reconcile(): boolean {
    const expected = syncAuthorizedView(this.items, this.policy);
    if (expected.size !== this.visible.size) return false;
    for (const [id, item] of expected) {
      if (this.visible.get(id) !== item) return false;
    }
    return true;
  }

  /**
   * Start a new recompute generation. Any older in-flight generation becomes
   * stale and its result will be discarded when it eventually completes.
   */
  private scheduleRecompute(): void {
    const generation = ++this.generation;
    const items = [...this.items.values()];
    const policy = this.policy;
    const checks = items.map((item) =>
      this.executor
        .submit(() => policy.allows(item))
        .then((allowed) => ({ item, allowed })),
    );
    void Promise.all(checks).then((results) => {
      if (generation !== this.generation) return; // stale: never publish
      const next = new Map<string, Item>();
      for (const { item, allowed } of results) {
        if (allowed) next.set(item.id, item);
      }
      this.publishDiff(next);
    });
  }

  /**
   * Publish the diff between the current and next visible sets.
   * Deletes are always emitted before adds within a batch, so a policy
   * revocation can never transiently expose data under the new policy
   * before the revoked data has been withdrawn.
   */
  private publishDiff(next: Map<string, Item>): void {
    for (const id of this.visible.keys()) {
      if (!next.has(id)) {
        this.emit({ kind: 'delete', id, version: ++this.version });
      }
    }
    for (const [id, item] of next) {
      if (this.visible.get(id) !== item) {
        this.emit({ kind: 'add', item, version: ++this.version });
      }
    }
    this.visible = next;
  }

  private emit(message: Message): void {
    this.published.push(message);
    for (const listener of this.listeners) listener(message);
  }
}
