/**
 * Merge K async iterators into one async iterable.
 *
 * Semantics:
 * - Each source has at most one in-flight `next()` (single-item prefetch).
 * - Ready items are delivered in round-robin order across sources.
 * - When `return()` races with in-flight `next()` calls, items already
 *   delivered to the merger (resolved prefetches) are yielded first; the
 *   remaining in-flight prefetches are released (sources are closed).
 * - A source that throws is closed (its `return()` awaited) and reported
 *   via `onSourceError`; the other sources keep flowing.
 * - Closing is idempotent: every source's `return()` runs at most once,
 *   no matter how many times the merged iterator is returned/closed.
 */

export interface SourceFailure {
  readonly index: number;
  readonly error: unknown;
}

export interface MergeOptions {
  readonly onSourceError?: (failure: SourceFailure) => void;
}

export type SourceInput<T> = AsyncIterable<T> | AsyncIterator<T>;

/** Async iterator returned by {@link mergeRoundRobin} with a guaranteed close. */
export interface MergedAsyncIterator<T> extends AsyncIterableIterator<T> {
  next(): Promise<IteratorResult<T>>;
  return(): Promise<IteratorResult<T>>;
  throw(error: unknown): Promise<IteratorResult<T>>;
}

interface SourceState<T> {
  readonly iterator: AsyncIterator<T>;
  readonly index: number;
  /** In-flight prefetch, settled wrapper around `iterator.next()`. */
  pending: Promise<void> | null;
  /** Resolved prefetch not yet delivered to the consumer. */
  ready: IteratorResult<T> | null;
  /** Rejection captured from the in-flight prefetch. */
  failure: { readonly error: unknown } | null;
  /** Source exhausted, failed, or closed. */
  done: boolean;
  /** Memoized close so `iterator.return()` runs at most once. */
  closePromise: Promise<void> | null;
}

function toIterator<T>(source: SourceInput<T>): AsyncIterator<T> {
  if (Symbol.asyncIterator in source) {
    return (source as AsyncIterable<T>)[Symbol.asyncIterator]();
  }
  return source as AsyncIterator<T>;
}

export function mergeRoundRobin<T>(
  sources: ReadonlyArray<SourceInput<T>>,
  options: MergeOptions = {}
): MergedAsyncIterator<T> {
  const states: Array<SourceState<T>> = sources.map((source, index) => ({
    iterator: toIterator(source),
    index,
    pending: null,
    ready: null,
    failure: null,
    done: false,
    closePromise: null,
  }));

  let activeCount = states.length;
  let cursor = 0;
  let closed = false;
  let closeAllPromise: Promise<void> | null = null;

  const closeSource = (state: SourceState<T>): Promise<void> => {
    if (state.closePromise === null) {
      state.done = true;
      const iterator = state.iterator;
      state.closePromise = Promise.resolve()
        .then(() => (iterator.return ? iterator.return() : undefined))
        .then(
          () => undefined,
          () => undefined
        );
    }
    return state.closePromise;
  };

  const closeAll = (): Promise<void> => {
    if (closeAllPromise === null) {
      closed = true;
      closeAllPromise = (async () => {
        // Release every source exactly once. In-flight prefetches are not
        // awaited: their results are discarded when they settle, and their
        // rejections are already observed by the prefetch wrapper, so a
        // stuck source can never deadlock the consumer's return().
        await Promise.all(states.map(closeSource));
      })();
    }
    return closeAllPromise;
  };

  const prefetch = (state: SourceState<T>): void => {
    if (
      closed ||
      state.done ||
      state.pending !== null ||
      state.ready !== null ||
      state.failure !== null
    ) {
      return;
    }
    let result: Promise<IteratorResult<T>>;
    try {
      result = Promise.resolve(state.iterator.next());
    } catch (error) {
      result = Promise.reject(error);
    }
    state.pending = result.then(
      (settled) => {
        state.pending = null;
        if (settled.done) {
          // Natural completion is accounted for here, once, so the
          // round-robin loop can simply skip done sources.
          activeCount -= 1;
          state.done = true;
        } else {
          state.ready = settled;
        }
      },
      (error: unknown) => {
        state.pending = null;
        state.failure = { error };
      }
    );
  };

  /** Deliver one already-prefetched item, round-robin from the cursor. */
  const drainReady = (): IteratorResult<T> | null => {
    for (let scanned = 0; scanned < states.length; scanned += 1) {
      const state = states[(cursor + scanned) % states.length]!;
      if (!state.done && state.ready !== null) {
        const result = state.ready;
        state.ready = null;
        cursor = (state.index + 1) % states.length;
        return result;
      }
    }
    return null;
  };

  const next = async (): Promise<IteratorResult<T>> => {
    while (!closed && activeCount > 0) {
      const state = states[cursor]!;
      cursor = (cursor + 1) % states.length;
      if (state.done) {
        continue;
      }
      if (state.pending !== null) {
        await state.pending;
      }
      if (closed) {
        return { value: undefined, done: true };
      }
      if (state.failure !== null) {
        const { error } = state.failure;
        state.failure = null;
        activeCount -= 1;
        // Only this source is closed; the rest keep flowing.
        await closeSource(state);
        options.onSourceError?.({ index: state.index, error });
        continue;
      }
      if (state.done) {
        // Finished naturally while we awaited the prefetch; the wrapper
        // already accounted for it.
        continue;
      }
      const result = state.ready!;
      state.ready = null;
      prefetch(state);
      return { value: result.value, done: false };
    }
    return { value: undefined, done: true };
  };

  const doReturn = async (): Promise<IteratorResult<T>> => {
    // Delivered items win the race against the close: hand out every
    // resolved prefetch before releasing anything.
    const drained = drainReady();
    if (drained !== null) {
      return { value: drained.value, done: false };
    }
    await closeAll();
    return { value: undefined, done: true };
  };

  const doThrow = async (error: unknown): Promise<IteratorResult<T>> => {
    await closeAll();
    throw error;
  };

  // Kick off the single-item prefetch for every source.
  for (const state of states) {
    prefetch(state);
  }

  return {
    next,
    return: doReturn,
    throw: doThrow,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
