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
export interface SkippedRange {
    /** First skipped (never delivered) version, inclusive. */
    readonly from: number;
    /** Last skipped (never delivered) version, inclusive. */
    readonly to: number;
}
export interface Snapshot<T> {
    /** Committed state for this notification. */
    readonly value: T;
    /** Monotonic version of the commit, starting at 1. */
    readonly version: number;
    /**
     * Versions that were committed but never delivered to this observer because
     * it was still processing a previous notification. `null` when nothing was
     * skipped.
     */
    readonly skipped: SkippedRange | null;
}
export type Observer<T> = (snapshot: Snapshot<T>) => void | Promise<void>;
export type ObserverErrorHandler = (error: unknown) => void;
export interface Subscription {
    /**
     * Detaches the observer. The returned promise resolves once the currently
     * in-flight callback (if any) has finished. No further notifications are
     * delivered to this observer.
     */
    unsubscribe(): Promise<void>;
    readonly closed: boolean;
}
export interface ObservableStoreOptions {
    /** Called when an observer throws or rejects. Defaults to a no-op. */
    onObserverError?: ObserverErrorHandler;
}
export declare class ObservableStore<T> {
    private state;
    private version;
    private readonly observers;
    private flushScheduled;
    private isClosed;
    private readonly onObserverError;
    constructor(initialState: T, options?: ObservableStoreOptions);
    /** Current committed state. */
    getState(): T;
    /** Version of the current committed state (0 before the first commit). */
    getVersion(): number;
    get closed(): boolean;
    /**
     * Commits `next` synchronously and schedules asynchronous notification.
     * Returns the new version. Throws if the store is closed.
     */
    set(next: T): number;
    /** Commits `fn(currentState)`; see `set`. */
    update(fn: (previous: T) => T): number;
    subscribe(observer: Observer<T>): Subscription;
    /**
     * Drops pending notifications, waits for in-flight observer callbacks and
     * guarantees no notification is delivered after the returned promise
     * resolves. Subsequent `set`/`update`/`subscribe` calls throw.
     */
    close(): Promise<void>;
    private scheduleFlush;
    private flush;
    private drain;
}
