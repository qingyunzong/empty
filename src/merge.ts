export type SourceErrorHandler = (error: unknown, sourceIndex: number) => void;

interface TrackedPrefetch<T> {
  readonly promise: Promise<IteratorResult<T>>;
  settled: boolean;
  hasError: boolean;
  result?: IteratorResult<T>;
  error?: unknown;
}

interface SourceState<T> {
  readonly index: number;
  readonly iterator: AsyncIterator<T>;
  prefetch: TrackedPrefetch<T> | null;
  done: boolean;
  closed: boolean;
}

const DONE: IteratorReturnResult<undefined> = Object.freeze({
  value: undefined,
  done: true,
});

const noop = (): undefined => undefined;

function trackPrefetch<T>(promise: Promise<IteratorResult<T>>): TrackedPrefetch<T> {
  const tracked: TrackedPrefetch<T> = { promise, settled: false, hasError: false };
  promise.then(
    (result) => {
      tracked.settled = true;
      tracked.result = result;
    },
    (error: unknown) => {
      tracked.settled = true;
      tracked.hasError = true;
      tracked.error = error;
    }
  );
  return tracked;
}

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
export function mergeRoundRobin<T>(
  sources: readonly AsyncIterable<T>[],
  onSourceError?: SourceErrorHandler
): AsyncIterableIterator<T> {
  const states: SourceState<T>[] = sources.map((source, index) => ({
    index,
    iterator: source[Symbol.asyncIterator](),
    prefetch: null,
    done: false,
    closed: false,
  }));

  const rotation: SourceState<T>[] = [...states];
  let cursor = 0;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let notifyClosed: () => void = noop;
  const closeSignal = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  let nextChain: Promise<unknown> = Promise.resolve();

  function ensurePrefetch(state: SourceState<T>): void {
    if (state.prefetch !== null || state.done || state.closed) return;
    let promise: Promise<IteratorResult<T>>;
    try {
      promise = Promise.resolve(state.iterator.next());
    } catch (error) {
      promise = Promise.reject(error);
    }
    state.prefetch = trackPrefetch(promise);
  }

  // Eagerly prefetch one item per source (never more than one in flight each).
  for (const state of states) ensurePrefetch(state);

  function removeFromRotation(state: SourceState<T>): void {
    const at = rotation.indexOf(state);
    if (at === -1) return;
    rotation.splice(at, 1);
    if (at < cursor) cursor -= 1;
    cursor = rotation.length === 0 ? 0 : cursor % rotation.length;
  }

  async function closeSource(state: SourceState<T>): Promise<void> {
    if (state.closed) return;
    state.closed = true;
    // Release a still-pending prefetch; a settled one stays available so a
    // racing next() can still deliver it (delivered items take priority).
    if (state.prefetch !== null && !state.prefetch.settled) {
      state.prefetch = null;
    }
    if (!state.done && state.iterator.return) {
      try {
        await state.iterator.return();
      } catch {
        // Cleanup failures are ignored: the source is considered closed.
      }
    }
  }

  async function failSource(state: SourceState<T>, error: unknown): Promise<void> {
    removeFromRotation(state);
    await closeSource(state);
    onSourceError?.(error, state.index);
  }

  async function nextInternal(): Promise<IteratorResult<T>> {
    for (;;) {
      if (rotation.length === 0) return DONE;
      const state = rotation[cursor % rotation.length]!;
      let prefetch = state.prefetch;
      if (prefetch === null) {
        if (closed || state.closed) return DONE;
        ensurePrefetch(state);
        prefetch = state.prefetch!;
      }
      if (prefetch.settled) {
        // A settled prefetch wins the race against return().
        state.prefetch = null;
        if (prefetch.hasError) {
          await failSource(state, prefetch.error);
          continue;
        }
        const result = prefetch.result!;
        if (result.done) {
          state.done = true;
          removeFromRotation(state);
          await closeSource(state);
          continue;
        }
        if (rotation.length > 0) cursor = (cursor + 1) % rotation.length;
        ensurePrefetch(state); // refill: still at most one prefetch in flight
        return { value: result.value, done: false };
      }
      if (closed) return DONE;
      await Promise.race([prefetch.promise, closeSignal]).then(noop, noop);
    }
  }

  async function returnInternal(): Promise<IteratorResult<T>> {
    if (closePromise === null) {
      closed = true;
      notifyClosed();
      closePromise = Promise.all(states.map(closeSource)).then(noop);
    }
    await closePromise;
    return DONE;
  }

  return {
    next(): Promise<IteratorResult<T>> {
      // A next() issued after return() is done immediately; a next() that was
      // already queued races return() and may still deliver a settled item.
      if (closed) return Promise.resolve(DONE);
      const result = nextChain.then(nextInternal);
      nextChain = result.then(noop, noop);
      return result;
    },
    return: returnInternal,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
