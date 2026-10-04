export interface MapLimitOptions {
  signal?: AbortSignal;
}

export class MapLimitError<V> extends Error {
  override readonly name = "MapLimitError";
  readonly index: number;
  readonly values: V[];

  constructor(index: number, reason: unknown, values: V[]) {
    super(`mapLimit: item at index ${index} failed`, { cause: reason });
    this.index = index;
    this.values = values;
  }
}

const fallbackSignal = new AbortController().signal;

export async function mapLimit<T, V>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number, signal: AbortSignal) => V | Promise<V>,
  options: MapLimitOptions = {},
): Promise<V[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  const results: V[] = new Array<V>(items.length);
  const failures: Array<{ index: number; reason: unknown }> = [];
  let nextIndex = 0;
  let stopped = false;

  const signal = options.signal;
  const stopOnAbort = (): void => {
    stopped = true;
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      stopped = true;
    } else {
      signal.addEventListener("abort", stopOnAbort, { once: true });
    }
  }

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await mapper(items[index] as T, index, signal ?? fallbackSignal);
      } catch (reason) {
        failures.push({ index, reason });
        stopped = true;
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (signal !== undefined) {
    signal.removeEventListener("abort", stopOnAbort);
  }

  if (failures.length > 0) {
    let first = failures[0] as { index: number; reason: unknown };
    for (const failure of failures) {
      if (failure.index < first.index) {
        first = failure;
      }
    }
    throw new MapLimitError<V>(first.index, first.reason, results.slice(0, first.index));
  }

  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw new DOMException("The operation was aborted", "AbortError");
  }

  return results;
}
