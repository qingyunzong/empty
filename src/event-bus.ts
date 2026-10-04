import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Handler invoked for each matching subscription of a publish.
 * May be synchronous or return a Promise (only awaited by `publish`).
 */
export type Handler<P = unknown> = (
  payload: P,
  context: HandlerContext,
) => void | Promise<void>;

export interface HandlerContext {
  /** Id of the publish node this invocation belongs to. */
  readonly publishId: number;
  /** Id of the subscription being invoked. */
  readonly subscriptionId: number;
  /** Topic of the publish. */
  readonly topic: string;
  /** Depth of the publish in the publish tree (root publishes are 0). */
  readonly depth: number;
}

export interface UnsubscribeOptions {
  /**
   * When true, the returned promise resolves only after every in-flight
   * invocation of the subscription has finished. A callback that removes
   * its own subscription (directly or transitively up its publish stack)
   * never waits on itself.
   */
  readonly wait?: boolean;
}

/** Aggregated errors of one publish subtree, merged in publish-tree order. */
export class PublishAggregateError extends AggregateError {
  readonly publishId: number;
  readonly topic: string;
  /** @internal Publish node this aggregate was produced by. */
  readonly node: object;
  constructor(topic: string, publishId: number, errors: Error[], node: object) {
    super(
      errors,
      `publish #${publishId} ("${topic}") produced ${errors.length} error(s)`,
    );
    this.name = "PublishAggregateError";
    this.publishId = publishId;
    this.topic = topic;
    this.node = node;
  }
}

/** Thrown when a `wait: true` removal would create a cyclic wait. */
export class CyclicWaitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclicWaitError";
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

interface SubscriptionRecord {
  readonly id: number;
  readonly topic: string;
  readonly handler: Handler;
  removed: boolean;
  /** Explicit set of in-flight invocation scopes of this subscription. */
  readonly inflight: Set<InvocationScope>;
}

let nextPublishId = 1;
let nextSubscriptionId = 1;
let nextScopeId = 1;

/**
 * One AsyncLocalStorage shared by every EventBus instance. Node.js keeps
 * live ALS instances in a global registry and context switches get slower
 * as that registry grows, so a per-bus ALS would degrade quadratically for
 * applications (and tests) that create many buses. The stored scope object
 * identifies its own bus, so sharing the storage is semantically safe.
 */
const invocationContext = new AsyncLocalStorage<InvocationScope>();

/** One node of the publish tree: a single publish operation. */
class PublishNode {
  readonly id = nextPublishId++;
  /** Invocation scopes of this publish, in snapshot order. */
  readonly scopes: InvocationScope[] = [];
  settledFlag = false;
  readonly settled: Promise<void>;
  private resolveSettled!: () => void;

  constructor(
    readonly topic: string,
    readonly sync: boolean,
    readonly depth: number,
    readonly parentScope: InvocationScope | null,
  ) {
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  finish(): void {
    this.settledFlag = true;
    this.resolveSettled();
  }

  /**
   * Errors of this subtree in publish-tree order: for each invocation scope
   * in snapshot order, the handler error, followed by the errors of every
   * derived publish in creation order. A handler error that is the aggregate
   * of one of this scope's own derived publishes is skipped here because the
   * structural walk of that child already contributes the same errors.
   */
  collectErrors(): Error[] {
    const out: Error[] = [];
    for (const scope of this.scopes) {
      if (scope.hasHandlerError) {
        const error = scope.handlerError;
        const isOwnChildAggregate =
          error instanceof PublishAggregateError &&
          scope.children.some((child) => child === error.node);
        if (isOwnChildAggregate) {
          // Covered by the structural walk of the child below.
        } else if (error instanceof PublishAggregateError) {
          out.push(...(error.errors as Error[]));
        } else {
          out.push(toError(error));
        }
      }
      for (const child of scope.children) {
        out.push(...child.collectErrors());
      }
    }
    return out;
  }
}

/** Explicit scope of one in-flight handler invocation. */
class InvocationScope {
  readonly id = nextScopeId++;
  /** Derived publishes created while this scope was active, in creation order. */
  readonly children: PublishNode[] = [];
  hasHandlerError = false;
  handlerError: unknown;
  active = false;
  readonly settled: Promise<void>;
  private resolveSettled!: () => void;

  constructor(
    readonly bus: EventBus,
    readonly record: SubscriptionRecord,
    readonly node: PublishNode,
    readonly parent: InvocationScope | null,
  ) {
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  enter(): void {
    this.active = true;
    this.record.inflight.add(this);
    this.bus.trackScope(this);
  }

  exit(): void {
    this.active = false;
    this.record.inflight.delete(this);
    this.bus.untrackScope(this);
    this.resolveSettled();
  }

  setHandlerError(error: unknown): void {
    this.hasHandlerError = true;
    this.handlerError = error;
  }

  /** True when this scope is `scope` itself or one of its ancestors. */
  isAncestorOrSelfOf(scope: InvocationScope): boolean {
    let cursor: InvocationScope | null = scope;
    while (cursor !== null) {
      if (cursor === this) return true;
      cursor = cursor.parent;
    }
    return false;
  }
}

/** Handle of one subscription. */
export class Subscription {
  /** @internal */
  constructor(
    private readonly bus: EventBus,
    /** @internal */
    readonly record: SubscriptionRecord,
  ) {}

  get id(): number {
    return this.record.id;
  }

  get topic(): string {
    return this.record.topic;
  }

  /** False once the subscription has been removed. */
  get active(): boolean {
    return !this.record.removed;
  }

  unsubscribe(): void;
  unsubscribe(options: { wait: true }): Promise<void>;
  unsubscribe(options?: UnsubscribeOptions): void | Promise<void> {
    return this.bus.removeSubscription(this.record, options?.wait === true);
  }
}

/**
 * Event bus with snapshot publish semantics.
 *
 * - A publish iterates a fixed snapshot of its topic's subscriptions;
 *   subscriptions added or removed by callbacks only affect later publishes.
 * - Each subscription runs at most once per publish, even when callbacks
 *   reentrantly publish (a reentrant publish is a new node of the tree).
 * - Handler errors are aggregated and never prevent other callbacks of the
 *   same publish from running. Errors are merged in publish-tree order and
 *   delivered as a `PublishAggregateError` to the caller of the publish.
 * - `publish` (async) awaits every callback; a parent publish also waits for
 *   all derived publishes created by its callbacks to finish cleaning up,
 *   even if a callback did not await them.
 * - `unsubscribe({ wait: true })` waits for in-flight invocations of the
   * subscription, but never waits on the current invocation stack (a callback
 *   removing itself does not self-wait) and throws `CyclicWaitError` instead
 *   of deadlocking on a wait cycle.
 */
export class EventBus {
  private readonly topics = new Map<string, Map<number, SubscriptionRecord>>();
  private readonly als = invocationContext;
  private readonly activeScopes = new Set<InvocationScope>();
  /** Wait-for graph edges: scope -> scopes it currently waits on. */
  private readonly waitEdges = new Map<InvocationScope, Set<InvocationScope>>();

  subscribe<P = unknown>(topic: string, handler: Handler<P>): Subscription {
    const record: SubscriptionRecord = {
      id: nextSubscriptionId++,
      topic,
      handler: handler as Handler,
      removed: false,
      inflight: new Set(),
    };
    let set = this.topics.get(topic);
    if (set === undefined) {
      set = new Map();
      this.topics.set(topic, set);
    }
    set.set(record.id, record);
    return new Subscription(this, record);
  }

  unsubscribe(subscription: Subscription): void;
  unsubscribe(subscription: Subscription, options: { wait: true }): Promise<void>;
  unsubscribe(
    subscription: Subscription,
    options?: UnsubscribeOptions,
  ): void | Promise<void> {
    return options?.wait === true
      ? subscription.unsubscribe({ wait: true })
      : subscription.unsubscribe();
  }

  /**
   * Synchronous publish. Throws `PublishAggregateError` when the subtree
   * produced errors. Handlers must be synchronous; a handler returning a
   * thenable is reported as an aggregated error.
   */
  publishSync<P = unknown>(topic: string, payload: P): void {
    const parent = this.currentScope();
    const node = new PublishNode(
      topic,
      true,
      parent === null ? 0 : parent.node.depth + 1,
      parent,
    );
    parent?.children.push(node);
    const snapshot = this.snapshot(topic);
    for (const record of snapshot) this.invokeSync(record, node, payload);
    node.finish();
    const errors = node.collectErrors();
    if (errors.length > 0) {
      throw new PublishAggregateError(topic, node.id, errors, node);
    }
  }

  /**
   * Asynchronous publish. Rejects with `PublishAggregateError` when the
   * subtree produced errors. Resolves only after every callback and every
   * derived publish (awaited or not) has finished cleaning up.
   */
  publish<P = unknown>(topic: string, payload: P): Promise<void> {
    const promise = this.publishAsync(topic, payload);
    // Errors are always aggregated and delivered to awaiters; this sink keeps
    // fire-and-forget publishes from raising unhandled rejections.
    promise.catch(() => {});
    return promise;
  }

  private async publishAsync<P>(topic: string, payload: P): Promise<void> {
    const parent = this.currentScopeForAsync();
    const node = new PublishNode(
      topic,
      false,
      parent === null ? 0 : parent.node.depth + 1,
      parent,
    );
    parent?.children.push(node);
    const snapshot = this.snapshot(topic);
    for (const record of snapshot) {
      await this.invokeAsync(record, node, payload);
    }
    node.finish();
    const errors = node.collectErrors();
    if (errors.length > 0) {
      throw new PublishAggregateError(topic, node.id, errors, node);
    }
  }

  /** Number of handler invocations currently in flight. */
  get inFlightCount(): number {
    return this.activeScopes.size;
  }

  /** @internal */
  trackScope(scope: InvocationScope): void {
    this.activeScopes.add(scope);
  }

  /** @internal */
  untrackScope(scope: InvocationScope): void {
    this.activeScopes.delete(scope);
  }

  /** @internal */
  removeSubscription(
    record: SubscriptionRecord,
    wait: boolean,
  ): void | Promise<void> {
    if (record.removed) return wait ? Promise.resolve() : undefined;
    record.removed = true;
    const set = this.topics.get(record.topic);
    if (set !== undefined) {
      set.delete(record.id);
      if (set.size === 0) this.topics.delete(record.topic);
    }
    if (!wait) return undefined;
    return this.waitForInflight(record);
  }

  private async waitForInflight(record: SubscriptionRecord): Promise<void> {
    const current = this.currentScope();
    for (;;) {
      const pending = [...record.inflight].filter(
        (scope) => current === null || !scope.isAncestorOrSelfOf(current),
      );
      if (pending.length === 0) return;
      if (current !== null) {
        for (const target of pending) {
          if (this.reachesThroughWaits(target, current)) {
            throw new CyclicWaitError(
              `removal of subscription #${record.id} would wait on ` +
                `invocation #${target.id}, closing a wait cycle`,
            );
          }
        }
        for (const target of pending) this.addWaitEdge(current, target);
      }
      try {
        await Promise.all(pending.map((scope) => scope.settled));
      } finally {
        if (current !== null) {
          for (const target of pending) this.removeWaitEdge(current, target);
        }
      }
    }
  }

  /** True when `to` is reachable from `from` through current wait edges. */
  private reachesThroughWaits(
    from: InvocationScope,
    to: InvocationScope,
  ): boolean {
    const visited = new Set<InvocationScope>();
    const stack: InvocationScope[] = [from];
    while (stack.length > 0) {
      const scope = stack.pop() as InvocationScope;
      if (scope === to) return true;
      if (visited.has(scope)) continue;
      visited.add(scope);
      const edges = this.waitEdges.get(scope);
      if (edges !== undefined) stack.push(...edges);
    }
    return false;
  }

  private addWaitEdge(from: InvocationScope, to: InvocationScope): void {
    let edges = this.waitEdges.get(from);
    if (edges === undefined) {
      edges = new Set();
      this.waitEdges.set(from, edges);
    }
    edges.add(to);
  }

  private removeWaitEdge(from: InvocationScope, to: InvocationScope): void {
    const edges = this.waitEdges.get(from);
    if (edges === undefined) return;
    edges.delete(to);
    if (edges.size === 0) this.waitEdges.delete(from);
  }

  private snapshot(topic: string): SubscriptionRecord[] {
    const set = this.topics.get(topic);
    return set === undefined ? [] : [...set.values()];
  }

  private currentScope(): InvocationScope | null {
    const scope = this.als.getStore();
    return scope !== undefined && scope.active ? scope : null;
  }

  /**
   * Async publishes cannot derive from a synchronous publish: a sync parent
   * cannot await async cleanup, so such a publish becomes a root.
   */
  private currentScopeForAsync(): InvocationScope | null {
    const scope = this.currentScope();
    return scope !== null && !scope.node.sync ? scope : null;
  }

  private contextOf(
    record: SubscriptionRecord,
    node: PublishNode,
  ): HandlerContext {
    return {
      publishId: node.id,
      subscriptionId: record.id,
      topic: node.topic,
      depth: node.depth,
    };
  }

  private invokeSync(
    record: SubscriptionRecord,
    node: PublishNode,
    payload: unknown,
  ): void {
    const scope = new InvocationScope(
      this,
      record,
      node,
      this.als.getStore() ?? null,
    );
    node.scopes.push(scope);
    scope.enter();
    try {
      this.als.run(scope, () => {
        try {
          const result = record.handler(payload, this.contextOf(record, node));
          if (
            result !== undefined &&
            result !== null &&
            typeof (result as Promise<void>).then === "function"
          ) {
            (result as Promise<void>).catch(() => {});
            scope.setHandlerError(
              new Error(
                `handler of subscription #${record.id} returned a Promise ` +
                  `during publishSync; use publish() for async handlers`,
              ),
            );
          }
        } catch (error) {
          scope.setHandlerError(error);
        }
      });
    } finally {
      scope.exit();
    }
  }

  private async invokeAsync(
    record: SubscriptionRecord,
    node: PublishNode,
    payload: unknown,
  ): Promise<void> {
    const scope = new InvocationScope(
      this,
      record,
      node,
      this.als.getStore() ?? null,
    );
    node.scopes.push(scope);
    scope.enter();
    try {
      await this.als.run(scope, async () => {
        try {
          await record.handler(payload, this.contextOf(record, node));
        } catch (error) {
          scope.setHandlerError(error);
        }
      });
    } finally {
      scope.exit();
    }
    // The parent publish waits for derived publishes of this invocation to
    // finish cleaning up, even ones the callback did not await. The loop
    // re-checks because a settling child may register further children.
    let pending = scope.children.filter((child) => !child.settledFlag);
    while (pending.length > 0) {
      await Promise.all(pending.map((child) => child.settled));
      pending = scope.children.filter((child) => !child.settledFlag);
    }
  }
}
