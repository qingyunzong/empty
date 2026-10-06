import { AsyncLocalStorage } from 'node:async_hooks';

export type Topic = string;

/** Context handed to every callback invocation. */
export interface CallbackContext {
  readonly bus: EventBus;
  readonly topic: Topic;
  /** Id of the publish this invocation belongs to. */
  readonly publishId: number;
  /** Depth of the publish in the publish tree (root publishes are 0). */
  readonly depth: number;
  /** The subscription handle this invocation belongs to. */
  readonly subscription: Subscription;
  /** Aborted when the owning publish is cancelled. */
  readonly signal: AbortSignal;
}

export type Callback<T = unknown> = (payload: T, context: CallbackContext) => unknown;

export interface Subscription {
  readonly id: number;
  readonly topic: Topic;
  readonly active: boolean;
  /** Detach immediately; in-flight invocations keep running. */
  remove(): void;
  /**
   * Detach, then wait for every in-flight invocation of this subscription.
   * Invocations that are ancestors of the current callback (including the
   * current callback itself) are never awaited, so a callback may safely
   * remove itself — directly or through a nested publish — without
   * deadlocking.
   */
  removeAndWait(): Promise<void>;
}

export interface PublishReceipt {
  readonly publishId: number;
  readonly topic: Topic;
  readonly depth: number;
  readonly cancelled: boolean;
  /** Number of snapshot callbacks actually invoked. */
  readonly invoked: number;
  /** Number of errors aggregated from the whole publish subtree. */
  readonly errorCount: number;
}

export interface PublishAsyncOptions {
  /** Aborting skips snapshot callbacks that have not started yet. */
  readonly signal?: AbortSignal;
}

export interface EventBusOptions {
  /**
   * Called with aggregates that can no longer be merged into their parent
   * publish (e.g. an async publish derived from a synchronous one).
   */
  readonly onLateError?: (error: unknown, bus: EventBus) => void;
}

type LogEntry =
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'child'; readonly node: PublishNode };

/**
 * Explicit scope for one in-flight callback invocation. Every callback runs
 * inside exactly one scope; the scope is propagated across `await` boundaries
 * via AsyncLocalStorage so derived publishes attach to the right publish node
 * even when they happen after the callback yielded.
 */
class InvocationScope {
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    readonly node: PublishNode,
    readonly subscription: SubscriptionImpl,
  ) {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  finish(): void {
    this.resolveDone();
  }
}

/** One node of the publish tree: a single publish operation. */
class PublishNode {
  readonly children: PublishNode[] = [];
  /** Chronological log of own callback errors and derived publishes. */
  readonly log: LogEntry[] = [];
  readonly scopes = new Set<InvocationScope>();
  readonly abortController = new AbortController();
  /** Resolves once this node (including its whole subtree) has finalized. */
  readonly settled: Promise<void>;
  cancelled = false;
  invoked = 0;
  finalized = false;
  mergedErrors: readonly unknown[] = [];
  aggregate: AggregateError | null = null;
  private resolveSettled!: () => void;

  constructor(
    readonly id: number,
    readonly topic: Topic,
    readonly parent: PublishNode | null,
    /** Scope that was active when this publish started (null for roots). */
    readonly createdBy: InvocationScope | null,
    readonly depth: number,
  ) {
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
  }

  /**
   * Merge errors in publish-tree order: walk the chronological log, keeping
   * own callback errors and splicing in each derived publish's merged errors
   * at the position where the derived publish started. An aggregate that a
   * callback re-throws from a derived publish is dropped here because its
   * errors are already merged at the derived publish's log position.
   */
  finalize(): void {
    const childAggregates = new Set<unknown>();
    for (const child of this.children) {
      if (child.aggregate !== null) childAggregates.add(child.aggregate);
    }
    const merged: unknown[] = [];
    for (const entry of this.log) {
      if (entry.kind === 'error') {
        if (!childAggregates.has(entry.error)) merged.push(entry.error);
      } else {
        merged.push(...entry.node.mergedErrors);
      }
    }
    this.mergedErrors = merged;
    if (merged.length > 0) {
      this.aggregate = new AggregateError(
        merged,
        `publish #${this.id} (${this.topic}): ${merged.length} callback error(s)`,
      );
    }
    this.finalized = true;
    this.resolveSettled();
  }
}

class SubscriptionImpl implements Subscription {
  active = true;
  /** Scopes of currently running invocations, across all publishes. */
  readonly inFlight = new Set<InvocationScope>();

  constructor(
    private readonly bus: EventBus,
    readonly id: number,
    readonly topic: Topic,
    readonly callback: Callback,
  ) {}

  remove(): void {
    this.bus.unsubscribe(this);
  }

  removeAndWait(): Promise<void> {
    return this.bus.unsubscribeAndWait(this);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function';
}

export class EventBus {
  private readonly registry = new Map<Topic, Map<number, SubscriptionImpl>>();
  private readonly scopes = new AsyncLocalStorage<InvocationScope>();
  private readonly lateErrors: unknown[] = [];
  private nextSubscriptionId = 1;
  private nextPublishId = 1;
  private readonly onLateError?: (error: unknown, bus: EventBus) => void;

  constructor(options: EventBusOptions = {}) {
    this.onLateError = options.onLateError;
  }

  subscribe<T>(topic: Topic, callback: Callback<T>): Subscription {
    const subscription = new SubscriptionImpl(
      this,
      this.nextSubscriptionId++,
      topic,
      callback as Callback,
    );
    let bucket = this.registry.get(topic);
    if (bucket === undefined) {
      bucket = new Map();
      this.registry.set(topic, bucket);
    }
    bucket.set(subscription.id, subscription);
    return subscription;
  }

  unsubscribe(subscription: Subscription): void {
    if (!(subscription instanceof SubscriptionImpl) || !subscription.active) {
      return;
    }
    subscription.active = false;
    const bucket = this.registry.get(subscription.topic);
    if (bucket !== undefined) {
      bucket.delete(subscription.id);
      if (bucket.size === 0) this.registry.delete(subscription.topic);
    }
  }

  async unsubscribeAndWait(subscription: Subscription): Promise<void> {
    this.unsubscribe(subscription);
    if (!(subscription instanceof SubscriptionImpl)) return;
    // Never wait on an invocation that the current execution depends on:
    // the current scope itself and every ancestor scope up the publish tree.
    // Waiting on those would be a self-deadlock.
    const excluded = this.ancestorScopes();
    const pending: Promise<void>[] = [];
    for (const scope of subscription.inFlight) {
      if (!excluded.has(scope)) pending.push(scope.done);
    }
    await Promise.all(pending);
  }

  /**
   * Synchronous publish. Dispatches the fixed snapshot in subscription
   * order. Throws an AggregateError with the publish-tree errors if any
   * callback failed. Callbacks must be synchronous; a callback returning a
   * thenable is reported as an error (use {@link publishAsync} instead).
   */
  publish<T>(topic: Topic, payload: T): PublishReceipt {
    const node = this.openNode(topic);
    const snapshot = this.snapshot(topic);
    try {
      for (const subscription of snapshot) {
        if (node.cancelled) break;
        this.invokeSync(node, subscription, payload);
      }
    } finally {
      node.finalize();
      this.reportIfOrphaned(node);
    }
    if (node.aggregate !== null) throw node.aggregate;
    return this.receipt(node);
  }

  /**
   * Asynchronous publish. Snapshot callbacks are dispatched sequentially in
   * subscription order. The returned promise settles only after every
   * callback and every derived publish spawned inside them (even
   * fire-and-forget ones started after an `await`) has fully completed.
   * Rejects with an AggregateError of the publish-tree errors, if any.
   */
  publishAsync<T>(
    topic: Topic,
    payload: T,
    options: PublishAsyncOptions = {},
  ): Promise<PublishReceipt> {
    const node = this.openNode(topic);
    const signal = options.signal;
    let onAbort: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    if (signal !== undefined) {
      if (signal.aborted) {
        node.cancel();
      } else {
        observedSignal = signal;
        onAbort = () => node.cancel();
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const result = this.runAsync(node, topic, payload);
    if (onAbort !== undefined && observedSignal !== undefined) {
      const target = observedSignal;
      const handler = onAbort;
      const cleanup = (): void => target.removeEventListener('abort', handler);
      result.then(cleanup, cleanup);
    }
    if (node.parent !== null) {
      // Derived publish errors are merged into the ancestor publish tree, so
      // an un-awaited derived publish must not crash the process.
      result.catch(() => {});
    }
    return result;
  }

  /** Errors that could not be merged into an already-finalized parent. */
  drainLateErrors(): unknown[] {
    return this.lateErrors.splice(0, this.lateErrors.length);
  }

  private async runAsync<T>(
    node: PublishNode,
    topic: Topic,
    payload: T,
  ): Promise<PublishReceipt> {
    const snapshot = this.snapshot(topic);
    try {
      for (const subscription of snapshot) {
        if (node.cancelled) break;
        await this.invokeAsync(node, subscription, payload);
      }
    } finally {
      // A parent publish waits for its derived publishes to clean up, even
      // ones that were never awaited by user code. node.children is stable
      // here: children are only registered by this node's own scopes, and
      // all of them have finished by now.
      await Promise.all(node.children.map((child) => child.settled));
      node.finalize();
      this.reportIfOrphaned(node);
    }
    if (node.aggregate !== null) throw node.aggregate;
    return this.receipt(node);
  }

  private invokeSync<T>(
    node: PublishNode,
    subscription: SubscriptionImpl,
    payload: T,
  ): void {
    const scope = new InvocationScope(node, subscription);
    node.scopes.add(scope);
    subscription.inFlight.add(scope);
    node.invoked += 1;
    try {
      const result = this.scopes.run(scope, () =>
        subscription.callback(payload, this.contextOf(node, subscription)),
      );
      if (isThenable(result)) {
        // Swallow the late rejection so it cannot crash the process...
        Promise.resolve(result).then(undefined, () => {});
        // ...and report the misuse as a publish error instead.
        node.log.push({
          kind: 'error',
          error: new Error(
            `callback for topic "${subscription.topic}" returned a promise ` +
              'during synchronous publish; use publishAsync',
          ),
        });
      }
    } catch (error) {
      node.log.push({ kind: 'error', error });
    } finally {
      node.scopes.delete(scope);
      subscription.inFlight.delete(scope);
      scope.finish();
    }
  }

  private async invokeAsync<T>(
    node: PublishNode,
    subscription: SubscriptionImpl,
    payload: T,
  ): Promise<void> {
    const scope = new InvocationScope(node, subscription);
    node.scopes.add(scope);
    subscription.inFlight.add(scope);
    node.invoked += 1;
    try {
      await this.scopes.run(scope, () =>
        subscription.callback(payload, this.contextOf(node, subscription)),
      );
    } catch (error) {
      node.log.push({ kind: 'error', error });
    } finally {
      node.scopes.delete(scope);
      subscription.inFlight.delete(scope);
      scope.finish();
    }
  }

  private openNode(topic: Topic): PublishNode {
    const parentScope = this.scopes.getStore() ?? null;
    const parent = parentScope === null ? null : parentScope.node;
    const node = new PublishNode(
      this.nextPublishId++,
      topic,
      parent,
      parentScope,
      parent === null ? 0 : parent.depth + 1,
    );
    if (parent !== null) {
      parent.children.push(node);
      parent.log.push({ kind: 'child', node });
    }
    return node;
  }

  private snapshot(topic: Topic): SubscriptionImpl[] {
    return Array.from(this.registry.get(topic)?.values() ?? []);
  }

  private contextOf(node: PublishNode, subscription: SubscriptionImpl): CallbackContext {
    return {
      bus: this,
      topic: node.topic,
      publishId: node.id,
      depth: node.depth,
      subscription,
      signal: node.abortController.signal,
    };
  }

  private receipt(node: PublishNode): PublishReceipt {
    return {
      publishId: node.id,
      topic: node.topic,
      depth: node.depth,
      cancelled: node.cancelled,
      invoked: node.invoked,
      errorCount: node.mergedErrors.length,
    };
  }

  private ancestorScopes(): Set<InvocationScope> {
    const ancestors = new Set<InvocationScope>();
    let scope: InvocationScope | null = this.scopes.getStore() ?? null;
    while (scope !== null) {
      ancestors.add(scope);
      scope = scope.node.createdBy;
    }
    return ancestors;
  }

  private reportIfOrphaned(node: PublishNode): void {
    if (
      node.parent !== null &&
      node.parent.finalized &&
      node.aggregate !== null
    ) {
      this.lateErrors.push(node.aggregate);
      this.onLateError?.(node.aggregate, this);
    }
  }
}
