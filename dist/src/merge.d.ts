export type SourceErrorHandler = (error: unknown, sourceIndex: number) => void;
/**
 * Merges K async iterables into one async iterator.
 *
 * - At most one outstanding prefetch (one in-flight `next()`) per source.
 * - Values are delivered round-robin across the sources that are still live.
 * - When `return()` races a pending `next()`, an already-delivered (settled)
 *   prefetch still wins and is handed to the consumer; every other pending
 *   prefetch is released and its source is closed exactly once.
 * - A source that throws is closed (its `return()` awaited), reported via
 *   `onSourceError`, and removed from the rotation; the other sources keep
 *   going. Closing is idempotent: repeated `return()` calls never close a
 *   source twice.
 */
export declare function mergeRoundRobin<T>(sources: readonly AsyncIterable<T>[], onSourceError?: SourceErrorHandler): AsyncIterableIterator<T>;
