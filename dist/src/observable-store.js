"use strict";
/**
 * ObservableStore: an observable state container.
 *
 * Semantics:
 * - State commits are synchronous and versioned; notifications are always
 *   delivered asynchronously (on a microtask), never inside `set`/`update`.
 * - A throwing observer never rolls back committed state and never prevents
 *   other observers from being notified. Errors are routed to `onObserverError`.
 * - Slow observers are coalesced: while an observer callback is still running,
 *   only the latest committed version is kept. The next delivery carries the
 *   `skipped` version range that was superseded and never delivered.
 * - `unsubscribe()` waits for the currently in-flight callback to finish.
 * - `close()` waits for in-flight callbacks, drops pending notifications and
 *   guarantees no notification is delivered afterwards.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservableStore = void 0;
class ObservableStore {
    state;
    version = 0;
    observers = new Set();
    flushScheduled = false;
    isClosed = false;
    onObserverError;
    constructor(initialState, options = {}) {
        this.state = initialState;
        this.onObserverError = options.onObserverError ?? (() => undefined);
    }
    /** Current committed state. */
    getState() {
        return this.state;
    }
    /** Version of the current committed state (0 before the first commit). */
    getVersion() {
        return this.version;
    }
    get closed() {
        return this.isClosed;
    }
    /**
     * Commits `next` synchronously and schedules asynchronous notification.
     * Returns the new version. Throws if the store is closed.
     */
    set(next) {
        if (this.isClosed) {
            throw new Error("ObservableStore is closed");
        }
        this.state = next;
        this.version += 1;
        for (const entry of this.observers) {
            // Coalescing: a slow observer keeps only the latest version.
            entry.pending = { value: next, version: this.version };
        }
        this.scheduleFlush();
        return this.version;
    }
    /** Commits `fn(currentState)`; see `set`. */
    update(fn) {
        return this.set(fn(this.state));
    }
    subscribe(observer) {
        if (this.isClosed) {
            throw new Error("ObservableStore is closed");
        }
        const entry = {
            observer,
            pending: null,
            running: false,
            removed: false,
            lastDeliveredVersion: this.version,
            currentDrain: null,
        };
        this.observers.add(entry);
        const subscription = {
            get closed() {
                return entry.removed;
            },
            unsubscribe: () => {
                if (entry.removed) {
                    return entry.currentDrain ?? Promise.resolve();
                }
                entry.removed = true;
                entry.pending = null;
                this.observers.delete(entry);
                // Wait for the in-flight callback (drain) to finish, if any.
                return entry.currentDrain ?? Promise.resolve();
            },
        };
        return subscription;
    }
    /**
     * Drops pending notifications, waits for in-flight observer callbacks and
     * guarantees no notification is delivered after the returned promise
     * resolves. Subsequent `set`/`update`/`subscribe` calls throw.
     */
    async close() {
        if (this.isClosed) {
            return;
        }
        this.isClosed = true;
        const inFlight = [];
        for (const entry of this.observers) {
            entry.pending = null;
            if (entry.currentDrain) {
                inFlight.push(entry.currentDrain);
            }
        }
        this.observers.clear();
        await Promise.all(inFlight);
    }
    scheduleFlush() {
        if (this.flushScheduled) {
            return;
        }
        this.flushScheduled = true;
        queueMicrotask(() => {
            this.flushScheduled = false;
            this.flush();
        });
    }
    flush() {
        if (this.isClosed) {
            return;
        }
        for (const entry of [...this.observers]) {
            if (!entry.running && !entry.removed && entry.pending !== null) {
                entry.currentDrain = this.drain(entry);
            }
        }
    }
    async drain(entry) {
        entry.running = true;
        try {
            while (!this.isClosed && !entry.removed && entry.pending !== null) {
                const { value, version } = entry.pending;
                entry.pending = null;
                const skipped = version - entry.lastDeliveredVersion > 1
                    ? { from: entry.lastDeliveredVersion + 1, to: version - 1 }
                    : null;
                entry.lastDeliveredVersion = version;
                try {
                    await entry.observer({ value, version, skipped });
                }
                catch (error) {
                    // Observer failures never roll back committed state and never
                    // affect other observers.
                    this.onObserverError(error);
                }
            }
        }
        finally {
            entry.running = false;
            entry.currentDrain = null;
        }
    }
}
exports.ObservableStore = ObservableStore;
