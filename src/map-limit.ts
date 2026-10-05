export interface MapLimitOptions {
  signal?: AbortSignal;
}

export class MapLimitError<R = unknown> extends Error {
  readonly index: number;
  readonly partialResults: readonly R[];

  constructor(index: number, cause: unknown, partialResults: readonly R[]) {
    super(`mapLimit: item at index ${index} failed`, { cause });
    this.name = 'MapLimitError';
    this.index = index;
    this.partialResults = partialResults;
  }
}

const NO_FAILURE = Number.POSITIVE_INFINITY;

export function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number, signal: AbortSignal) => R | Promise<R>,
  options: MapLimitOptions = {},
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return Promise.reject(
      new RangeError(`mapLimit: concurrency must be a positive integer, got ${concurrency}`),
    );
  }

  const externalSignal = options.signal;
  if (externalSignal?.aborted) {
    return Promise.reject(externalSignal.reason ?? defaultAbortReason());
  }

  const results = new Array<R>(items.length);
  const controller = new AbortController();

  let nextIndex = 0;
  let running = 0;
  let settled = false;
  let firstFailureIndex = NO_FAILURE;
  let firstFailureReason: unknown;

  return new Promise<R[]>((resolve, reject) => {
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      externalSignal?.removeEventListener('abort', onExternalAbort);
      callback();
    };

    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
      settle(() => reject(externalSignal?.reason ?? defaultAbortReason()));
    };

    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const maybeSettle = (): void => {
      if (firstFailureIndex !== NO_FAILURE && running === 0) {
        const index = firstFailureIndex;
        const reason = firstFailureReason;
        settle(() => reject(new MapLimitError<R>(index, reason, results.slice(0, index))));
        return;
      }
      if (nextIndex >= items.length && running === 0) {
        settle(() => resolve(results));
      }
    };

    const launch = (): void => {
      while (
        !settled &&
        firstFailureIndex === NO_FAILURE &&
        running < concurrency &&
        nextIndex < items.length
      ) {
        const index = nextIndex;
        nextIndex += 1;
        running += 1;
        const item = items[index]!;
        void Promise.resolve()
          .then(() => mapper(item, index, controller.signal))
          .then(
            (value) => {
              running -= 1;
              results[index] = value;
              maybeSettle();
              launch();
            },
            (reason: unknown) => {
              running -= 1;
              if (index < firstFailureIndex) {
                firstFailureIndex = index;
                firstFailureReason = reason;
              }
              maybeSettle();
              launch();
            },
          );
      }
    };

    if (items.length === 0) {
      settle(() => resolve(results));
      return;
    }
    launch();
  });
}

function defaultAbortReason(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}
