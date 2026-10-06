import { ControllableExecutor } from './executor.js';
/**
 * Computes the authorized visible result set synchronously.
 * This is the ground truth used to reconcile the asynchronously
 * maintained subscription state.
 */
export function syncAuthorizedView(items, policy) {
    const visible = new Map();
    for (const [id, item] of items) {
        if (policy.allows(item))
            visible.set(id, item);
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
    executor;
    items = new Map();
    visible = new Map();
    policy;
    generation = 0;
    version = 0;
    listeners = [];
    published = [];
    constructor(policy, executor = new ControllableExecutor()) {
        this.executor = executor;
        this.policy = policy;
        this.scheduleRecompute();
    }
    onMessage(listener) {
        this.listeners.push(listener);
    }
    /** All messages published so far, in order. */
    get messages() {
        return this.published;
    }
    /** Current visible result set (ids). */
    get visibleIds() {
        return new Set(this.visible.keys());
    }
    /** Current visible result set (id -> item). */
    get visibleItems() {
        return new Map(this.visible);
    }
    get currentVersion() {
        return this.version;
    }
    upsert(item) {
        this.items.set(item.id, item);
        this.scheduleRecompute();
    }
    remove(id) {
        this.items.delete(id);
        this.scheduleRecompute();
    }
    setPolicy(policy) {
        this.policy = policy;
        this.scheduleRecompute();
    }
    /** Ground-truth check: does the live state match a synchronous auth query? */
    reconcile() {
        const expected = syncAuthorizedView(this.items, this.policy);
        if (expected.size !== this.visible.size)
            return false;
        for (const [id, item] of expected) {
            if (this.visible.get(id) !== item)
                return false;
        }
        return true;
    }
    /**
     * Start a new recompute generation. Any older in-flight generation becomes
     * stale and its result will be discarded when it eventually completes.
     */
    scheduleRecompute() {
        const generation = ++this.generation;
        const items = [...this.items.values()];
        const policy = this.policy;
        const checks = items.map((item) => this.executor
            .submit(() => policy.allows(item))
            .then((allowed) => ({ item, allowed })));
        void Promise.all(checks).then((results) => {
            if (generation !== this.generation)
                return; // stale: never publish
            const next = new Map();
            for (const { item, allowed } of results) {
                if (allowed)
                    next.set(item.id, item);
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
    publishDiff(next) {
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
    emit(message) {
        this.published.push(message);
        for (const listener of this.listeners)
            listener(message);
    }
}
