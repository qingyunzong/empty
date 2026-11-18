export interface InvalidationEvent<K> {
  readonly key: K;
  readonly version: number;
  readonly origin: string;
}

export type InvalidationListener<K> = (
  event: InvalidationEvent<K>,
) => void | Promise<void>;

export interface InvalidationTransport<K> {
  publish(event: InvalidationEvent<K>): void | Promise<void>;
  subscribe(listener: InvalidationListener<K>): () => void;
}

export interface OrderedInvalidationBusOptions {
  onError?: (error: unknown, event: unknown) => void;
}

/**
 * In-process ordered broadcast used by tests and single-process embeddings.
 * Events are delivered one at a time in publish-call order, so every
 * subscriber observes the same total order.
 */
export class OrderedInvalidationBus<K> implements InvalidationTransport<K> {
  private listeners = new Set<InvalidationListener<K>>();
  private tail: Promise<void> = Promise.resolve();
  private readonly onError: ((error: unknown, event: unknown) => void) | undefined;

  constructor(options: OrderedInvalidationBusOptions = {}) {
    this.onError = options.onError;
  }

  publish(event: InvalidationEvent<K>): Promise<void> {
    const deliver = async (): Promise<void> => {
      for (const listener of [...this.listeners]) {
        try {
          await listener(event);
        } catch (error) {
          this.onError?.(error, event);
        }
      }
    };
    const task = this.tail.then(deliver, deliver);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  subscribe(listener: InvalidationListener<K>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves once every event published so far has been delivered. */
  async idle(): Promise<void> {
    await this.tail;
  }

  close(): void {
    this.listeners.clear();
  }
}
