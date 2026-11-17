import { CommandCatalog, prepareCommand, type PreparedCommand } from "./commands.js";
import { keySlot } from "./crc16.js";
import {
  IndeterminateExecutionError,
  InvalidRedirectError,
  RetryExhaustedError,
  RedisRouterError,
  SlotNotAssignedError,
  TooManyRedirectsError,
  TransportError,
  isRedisReplyError,
  isTransportError,
  notSentError,
  unknownDeliveryError,
} from "./errors.js";
import { RouteCache } from "./route-cache.js";
import type {
  ClusterNode,
  ClusterTransport,
  Endpoint,
  ExecuteOptions,
  ExecutionResult,
  PipelineItemResult,
  RouteAttempt,
  RoutableCommand,
  SlotRoute,
  TopologyProvider,
  TopologySnapshot,
  TransportBatchItem,
  TransportBatchEntry,
} from "./types.js";

type MutableAttempt = { -readonly [K in keyof RouteAttempt]: RouteAttempt[K] };

interface PendingCommand {
  readonly index: number;
  readonly prepared: PreparedCommand;
  route: SlotRoute;
  asking: boolean;
  redirects: number;
  safeRetries: number;
  tryAgainRetries: number;
  readonly attempts: MutableAttempt[];
  retry: boolean;
  done: boolean;
}

interface ParsedRedirect {
  readonly kind: "MOVED" | "ASK";
  readonly slot: number;
  readonly endpoint: Endpoint;
}

export interface SlotRouterOptions {
  readonly transport: ClusterTransport;
  readonly topology?: TopologySnapshot | TopologyProvider;
  readonly commands?: CommandCatalog;
  /** Maximum MOVED/ASK hops for one command. Defaults to 8. */
  readonly maxRedirects?: number;
  /** Additional attempts after a provably-not-sent transport failure. Defaults to 2. */
  readonly maxTransportRetries?: number;
  /** Attempts after TRYAGAIN/CLUSTERDOWN, which guarantee no execution. Defaults to 3. */
  readonly maxTryAgainRetries?: number;
  /** Node id used for commands without keys. Defaults to the first known node. */
  readonly keylessNode?: string;
}

function endpointId(endpoint: Endpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

function parseEndpoint(value: string, redirect: string): Endpoint {
  let host: string;
  let portText: string;

  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0 || value[close + 1] !== ":") {
      throw new InvalidRedirectError(redirect, `bad endpoint ${JSON.stringify(value)}`);
    }
    host = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) {
      throw new InvalidRedirectError(redirect, `bad endpoint ${JSON.stringify(value)}`);
    }
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }

  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new InvalidRedirectError(redirect, `bad endpoint ${JSON.stringify(value)}`);
  }
  return { host, port };
}

function parseRedirect(error: unknown): ParsedRedirect | null {
  let reply: string | undefined;
  if (isRedisReplyError(error)) {
    reply = error.reply;
  } else if (error instanceof Error) {
    reply = error.message;
  }
  if (!reply) {
    return null;
  }

  const match = /^(MOVED|ASK)\s+(\d+)\s+(\S+)\s*$/.exec(reply);
  if (!match) {
    return null;
  }

  const kind = match[1] as "MOVED" | "ASK";
  const slot = Number(match[2]);
  if (!Number.isInteger(slot) || slot < 0 || slot >= 16384) {
    throw new InvalidRedirectError(kind, `invalid slot ${match[2]}`);
  }
  return { kind, slot, endpoint: parseEndpoint(match[3]!, kind) };
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isProvider(value: TopologySnapshot | TopologyProvider): value is TopologyProvider {
  return typeof (value as TopologyProvider).load === "function";
}

/**
 * Embeddable Redis Cluster slot router.
 *
 * Routing rules:
 * - Stable, migrating and importing slots are served by their current owner.
 * - MOVED permanently updates the slot cache.
 * - ASK is a one-shot hop; the cache is left untouched and the transport is
 *   asked to send `ASKING` before the command.
 * - No command is retried after an unknown-delivery transport error.
 */
export class SlotRouter {
  readonly cache: RouteCache;
  readonly #transport: ClusterTransport;
  readonly #catalog: CommandCatalog;
  readonly #topology?: TopologyProvider;
  readonly #maxRedirects: number;
  readonly #maxTransportRetries: number;
  readonly #maxTryAgainRetries: number;
  readonly #keylessNode?: string;
  #refresh: Promise<void> | null = null;

  constructor(options: SlotRouterOptions) {
    if (!options?.transport || typeof options.transport.execute !== "function") {
      throw new TypeError("SlotRouter requires a transport with an execute() method");
    }
    this.#transport = options.transport;
    this.#catalog = options.commands ?? new CommandCatalog();
    this.#maxRedirects = options.maxRedirects ?? 8;
    this.#maxTransportRetries = options.maxTransportRetries ?? 2;
    this.#maxTryAgainRetries = options.maxTryAgainRetries ?? 3;
    this.#keylessNode = options.keylessNode;

    if (options.topology && isProvider(options.topology)) {
      this.#topology = options.topology;
      this.cache = new RouteCache();
    } else {
      this.cache = new RouteCache(options.topology);
    }
  }

  get slotCount(): number {
    return this.cache.size;
  }

  slotFor(key: string): number {
    return keySlot(key);
  }

  getRoute(slot: number): SlotRoute | undefined {
    return this.cache.get(slot);
  }

  routeFor(key: string): SlotRoute | undefined {
    return this.cache.get(keySlot(key));
  }

  async routeCommand(command: RoutableCommand): Promise<SlotRoute> {
    return this.#resolveRoute(prepareCommand(command, this.#catalog));
  }

  /**
   * Replaces the routing table directly. Useful when an external topology
   * watcher already produced a snapshot.
   */
  applyTopology(snapshot: TopologySnapshot): void {
    this.cache.applyTopology(snapshot);
  }

  /**
   * Refreshes from the injected topology provider. Concurrent calls share one
   * in-flight request. A MOVED learned after the fetch began wins over the
   * older snapshot.
   */
  async refreshTopology(): Promise<void> {
    if (!this.#topology) {
      return;
    }
    if (this.#refresh) {
      return this.#refresh;
    }

    const startRevision = this.cache.revision;
    this.#refresh = (async () => {
      const snapshot = await this.#topology!.load();
      this.cache.applyTopology(snapshot, { ifLocalRevisionAtMost: startRevision });
    })();

    try {
      await this.#refresh;
    } finally {
      this.#refresh = null;
    }
  }

  async execute(command: RoutableCommand, options: ExecuteOptions = {}): Promise<unknown> {
    return (await this.executeWithTrace(command, options)).value;
  }

  async executeWithTrace<T = unknown>(
    command: RoutableCommand,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult<T>> {
    const prepared = prepareCommand(command, this.#catalog);
    let route = await this.#resolveRoute(prepared);
    let asking = false;
    let redirects = 0;
    let safeRetries = 0;
    let tryAgainRetries = 0;
    let attempt = 0;
    const attempts: MutableAttempt[] = [];

    for (;;) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Command aborted");
      }

      attempt += 1;
      const record: MutableAttempt = {
        node: route.node.id,
        attempt,
        asking,
        outcome: "error",
      };
      attempts.push(record);

      try {
        const value = await this.#transport.execute(route.node, prepared.wire, {
          asking,
          attempt,
          signal: options.signal,
        });
        record.outcome = "reply";
        return { value: value as T, slot: prepared.slot, node: route.node, attempts };
      } catch (error) {
        if (abortError(error)) {
          record.outcome = "error";
          throw error;
        }

        const redirect = parseRedirect(error);
        if (redirect) {
          record.outcome = redirect.kind === "MOVED" ? "moved" : "ask";
          this.#validateRedirect(prepared, redirect);
          redirects += 1;
          if (redirects > this.#maxRedirects) {
            throw new TooManyRedirectsError(redirects);
          }
          if (redirect.kind === "MOVED") {
            route = this.#applyMoved(prepared, redirect);
            asking = false;
          } else {
            route = this.#routeToEndpoint(redirect.endpoint);
            asking = true;
          }
          continue;
        }

        if (isRedisReplyError(error) && (error.code === "TRYAGAIN" || error.code === "CLUSTERDOWN")) {
          record.outcome = "try-again";
          tryAgainRetries += 1;
          if (tryAgainRetries > this.#maxTryAgainRetries) {
            throw new RetryExhaustedError(prepared.name, attempt, error);
          }
          await this.refreshTopology();
          route = await this.#resolveRoute(prepared);
          asking = false;
          continue;
        }

        if (isTransportError(error)) {
          if (error.delivery === "not-sent") {
            record.outcome = "not-sent";
            safeRetries += 1;
            if (safeRetries > this.#maxTransportRetries) {
              throw new RetryExhaustedError(prepared.name, attempt, error);
            }
            route = await this.#resolveRoute(prepared);
            asking = false;
            continue;
          }

          record.outcome = "indeterminate";
          throw new IndeterminateExecutionError(prepared.name, route.node, error);
        }

        if (isRedisReplyError(error)) {
          record.outcome = "error";
          throw error;
        }

        record.outcome = "indeterminate";
        throw new IndeterminateExecutionError(prepared.name, route.node, error);
      }
    }
  }

  /**
   * Executes a pipeline and returns exactly one result per input item, in input
   * order. Command groups destined for different nodes run concurrently;
   * commands for one node are submitted in caller order.
   *
   * A cross-slot command is rejected during validation, before any I/O.
   */
  async executePipeline<T = unknown>(
    commands: readonly RoutableCommand[],
    options: ExecuteOptions = {},
  ): Promise<Array<PipelineItemResult<T>>> {
    if (!Array.isArray(commands)) {
      throw new TypeError("executePipeline expects an array of commands");
    }

    const results: Array<PipelineItemResult<T>> = new Array(commands.length);
    const pending: PendingCommand[] = [];
    const preparedCommands: Array<PreparedCommand | undefined> = new Array(commands.length);

    // Validate and reject all multi-key cross-slot commands before the first
    // network operation. Other pipeline items remain independent.
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      try {
        preparedCommands[index] = prepareCommand(command, this.#catalog);
      } catch (error) {
        results[index] = {
          index,
          command,
          ok: false,
          error: asError(error),
          slot: null,
          attempts: [],
        };
      }
    }

    for (let index = 0; index < preparedCommands.length; index += 1) {
      const prepared = preparedCommands[index];
      if (!prepared) {
        continue;
      }
      try {
        const route = await this.#resolveRoute(prepared);
        pending.push({
          index,
          prepared,
          route,
          asking: false,
          redirects: 0,
          safeRetries: 0,
          tryAgainRetries: 0,
          attempts: [],
          retry: false,
          done: false,
        });
      } catch (error) {
        results[index] = {
          index,
          command: commands[index]!,
          ok: false,
          error: asError(error),
          slot: prepared.slot,
          attempts: [],
        };
      }
    }

    let queue = pending;
    while (queue.length > 0) {
      if (options.signal?.aborted) {
        const reason = asError(options.signal.reason ?? new Error("Pipeline aborted"));
        for (const item of queue) {
          this.#finishError(results, item, reason);
        }
        break;
      }

      const groups = new Map<string, PendingCommand[]>();
      for (const item of queue) {
        const key = `${item.route.node.id}\u0000${item.asking ? "ask" : "normal"}`;
        const group = groups.get(key);
        if (group) {
          group.push(item);
        } else {
          groups.set(key, [item]);
        }
      }

      await Promise.all(
        [...groups.values()].map((group) => this.#dispatchGroup(group, options, results)),
      );

      queue = queue.filter((item) => !item.done && item.retry);
      for (const item of queue) {
        item.retry = false;
      }
    }

    for (let index = 0; index < results.length; index += 1) {
      if (!results[index]) {
        results[index] = {
          index,
          command: commands[index],
          ok: false,
          error: new RedisRouterError("TRANSPORT_FAILED", `Pipeline item ${index} was not completed`),
          slot: null,
          attempts: [],
        };
      }
    }

    return results;
  }

  async #dispatchGroup(
    group: PendingCommand[],
    options: ExecuteOptions,
    results: Array<PipelineItemResult<unknown>>,
  ): Promise<void> {
    const node = group[0]!.route.node;

    if (this.#transport.executeBatch) {
      const entries: TransportBatchEntry[] = group.map((item) => ({
        command: item.prepared.wire,
        asking: item.asking,
      }));
      const attempt = Math.max(...group.map((item) => item.attempts.length + 1));

      for (const item of group) {
        item.attempts.push({
          node: item.route.node.id,
          attempt: item.attempts.length + 1,
          asking: item.asking,
          outcome: "error",
        });
      }

      let replies: readonly TransportBatchItem[];
      try {
        replies = await this.#transport.executeBatch(node, entries, {
          attempt,
          signal: options.signal,
        });
      } catch (error) {
        if (abortError(error)) {
          const reason = asError(error);
          for (const item of group) {
            this.#finishError(results, item, reason);
          }
          return;
        }

        if (isTransportError(error) && error.delivery === "not-sent") {
          for (const item of group) {
            item.attempts[item.attempts.length - 1]!.outcome = "not-sent";
          }
          for (const item of group) {
            await this.#handleNotSent(item, error, results);
          }
          return;
        }

        for (const item of group) {
          item.attempts[item.attempts.length - 1]!.outcome = "indeterminate";
          this.#finishError(
            results,
            item,
            new IndeterminateExecutionError(item.prepared.name, node, error),
          );
        }
        return;
      }

      if (replies.length !== group.length) {
        const error = new Error(
          `Transport batch returned ${replies.length} results for ${group.length} commands`,
        );
        for (const item of group) {
          item.attempts[item.attempts.length - 1]!.outcome = "indeterminate";
          this.#finishError(
            results,
            item,
            new IndeterminateExecutionError(item.prepared.name, node, error),
          );
        }
        return;
      }

      for (let index = 0; index < group.length; index += 1) {
        const item = group[index]!;
        const reply = replies[index]!;
        if (reply.ok) {
          item.attempts[item.attempts.length - 1]!.outcome = "reply";
          this.#finishSuccess(results, item, reply.value);
        } else {
          await this.#handleFailure(item, reply.error, results);
        }
      }
      return;
    }

    for (const item of group) {
      if (item.done) {
        continue;
      }
      item.attempts.push({
        node: item.route.node.id,
        attempt: item.attempts.length + 1,
        asking: item.asking,
        outcome: "error",
      });
      try {
        const value = await this.#transport.execute(item.route.node, item.prepared.wire, {
          asking: item.asking,
          attempt: item.attempts.length,
          signal: options.signal,
        });
        item.attempts[item.attempts.length - 1]!.outcome = "reply";
        this.#finishSuccess(results, item, value);
      } catch (error) {
        if (abortError(error)) {
          this.#finishError(results, item, asError(error));
        } else {
          await this.#handleFailure(item, error, results);
        }
      }
    }
  }

  async #handleFailure(
    item: PendingCommand,
    error: unknown,
    results: Array<PipelineItemResult<unknown>>,
  ): Promise<void> {
    const record = item.attempts[item.attempts.length - 1]!;

    let redirect: ParsedRedirect | null;
    try {
      redirect = parseRedirect(error);
    } catch (invalid) {
      record.outcome = "error";
      this.#finishError(results, item, asError(invalid));
      return;
    }
    if (redirect) {
      record.outcome = redirect.kind === "MOVED" ? "moved" : "ask";
      try {
        this.#validateRedirect(item.prepared, redirect);
      } catch (invalid) {
        this.#finishError(results, item, asError(invalid));
        return;
      }

      item.redirects += 1;
      if (item.redirects > this.#maxRedirects) {
        this.#finishError(results, item, new TooManyRedirectsError(item.redirects));
        return;
      }

      if (redirect.kind === "MOVED") {
        item.route = this.#applyMoved(item.prepared, redirect);
        item.asking = false;
      } else {
        item.route = this.#routeToEndpoint(redirect.endpoint);
        item.asking = true;
      }
      item.retry = true;
      return;
    }

    if (isRedisReplyError(error) && (error.code === "TRYAGAIN" || error.code === "CLUSTERDOWN")) {
      record.outcome = "try-again";
      item.tryAgainRetries += 1;
      if (item.tryAgainRetries > this.#maxTryAgainRetries) {
        this.#finishError(
          results,
          item,
          new RetryExhaustedError(item.prepared.name, item.attempts.length, error),
        );
        return;
      }
      await this.refreshTopology();
      try {
        item.route = await this.#resolveRoute(item.prepared);
      } catch (routeError) {
        this.#finishError(results, item, asError(routeError));
        return;
      }
      item.asking = false;
      item.retry = true;
      return;
    }

    if (isTransportError(error)) {
      if (error.delivery === "not-sent") {
        record.outcome = "not-sent";
        await this.#handleNotSent(item, error, results);
        return;
      }
      record.outcome = "indeterminate";
      this.#finishError(
        results,
        item,
        new IndeterminateExecutionError(item.prepared.name, item.route.node, error),
      );
      return;
    }

    record.outcome = isRedisReplyError(error) ? "error" : "indeterminate";
    if (isRedisReplyError(error)) {
      this.#finishError(results, item, error);
    } else {
      this.#finishError(
        results,
        item,
        new IndeterminateExecutionError(item.prepared.name, item.route.node, error),
      );
    }
  }

  async #handleNotSent(
    item: PendingCommand,
    error: TransportError,
    results: Array<PipelineItemResult<unknown>>,
  ): Promise<void> {
    item.safeRetries += 1;
    if (item.safeRetries > this.#maxTransportRetries) {
      this.#finishError(
        results,
        item,
        new RetryExhaustedError(item.prepared.name, item.attempts.length, error),
      );
      return;
    }
    try {
      item.route = await this.#resolveRoute(item.prepared);
    } catch (routeError) {
      this.#finishError(results, item, asError(routeError));
      return;
    }
    item.asking = false;
    item.retry = true;
  }

  #finishSuccess(
    results: Array<PipelineItemResult<unknown>>,
    item: PendingCommand,
    value: unknown,
  ): void {
    item.done = true;
    results[item.index] = {
      index: item.index,
      command: item.prepared.command,
      ok: true,
      value,
      slot: item.prepared.slot,
      node: item.route.node,
      attempts: item.attempts,
    };
  }

  #finishError(
    results: Array<PipelineItemResult<unknown>>,
    item: PendingCommand,
    error: Error,
  ): void {
    item.done = true;
    results[item.index] = {
      index: item.index,
      command: item.prepared.command,
      ok: false,
      error,
      slot: item.prepared.slot,
      node: item.route.node,
      attempts: item.attempts,
    };
  }

  async #resolveRoute(prepared: PreparedCommand): Promise<SlotRoute> {
    if (prepared.slot === null) {
      const missingKeylessNode =
        this.#keylessNode !== undefined && !this.cache.getNode(this.#keylessNode);
      if (this.#topology && (this.cache.nodes.length === 0 || missingKeylessNode)) {
        await this.refreshTopology();
      }
      return this.#keylessRoute();
    }

    let route = this.cache.get(prepared.slot);
    if (!route && this.#topology) {
      await this.refreshTopology();
      route = this.cache.get(prepared.slot);
    }
    if (!route) {
      throw new SlotNotAssignedError(prepared.slot);
    }
    return route;
  }

  #keylessRoute(): SlotRoute {
    const node = this.#keylessNode
      ? this.cache.getNode(this.#keylessNode)
      : this.cache.nodes[0];
    if (!node) {
      throw new RedisRouterError("NO_NODES", "Cannot route a keyless command: topology has no nodes");
    }
    return { slot: -1, owner: node.id, node, phase: "stable" };
  }

  #validateRedirect(prepared: PreparedCommand, redirect: ParsedRedirect): void {
    if (prepared.slot !== null && redirect.slot !== prepared.slot) {
      throw new InvalidRedirectError(
        redirect.kind,
        `redirect slot ${redirect.slot} does not match command slot ${prepared.slot}`,
      );
    }
  }

  #applyMoved(prepared: PreparedCommand, redirect: ParsedRedirect): SlotRoute {
    const slot = prepared.slot ?? redirect.slot;
    const existing = this.cache.findNode(redirect.endpoint);
    return this.cache.applyMoved(slot, redirect.endpoint, existing?.id ?? endpointId(redirect.endpoint));
  }

  #routeToEndpoint(endpoint: Endpoint): SlotRoute {
    const existing = this.cache.findNode(endpoint);
    const node: ClusterNode =
      existing ?? { id: endpointId(endpoint), host: endpoint.host, port: endpoint.port };
    return { slot: -1, owner: node.id, node, phase: "stable" };
  }
}

export function createSlotRouter(options: SlotRouterOptions): SlotRouter {
  return new SlotRouter(options);
}

export { notSentError, unknownDeliveryError };
