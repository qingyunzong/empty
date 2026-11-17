export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

export interface ClusterNode extends Endpoint {
  readonly id: string;
}

export interface SlotRange {
  readonly start: number;
  readonly end: number;
  /** Node id from the topology's `nodes` map. */
  readonly owner: string;
}

export type MigrationPhase = "migrating" | "importing";

export interface SlotMigration {
  readonly slot: number;
  readonly from: string;
  readonly to: string;
  /** Defaults to `migrating` when omitted. */
  readonly state?: MigrationPhase;
}

export interface TopologySnapshot {
  /**
   * Monotonically increasing topology epoch. A snapshot with an older epoch
   * than the cache is ignored. Optional for ad-hoc/static topologies.
   */
  readonly epoch?: number;
  readonly nodes: Readonly<Record<string, Endpoint>>;
  readonly slots: readonly SlotRange[];
  readonly migrations?: readonly SlotMigration[];
}

export interface TopologyProvider {
  load(): TopologySnapshot | Promise<TopologySnapshot>;
}

export type SlotPhase = "stable" | "migrating" | "importing";

export interface SlotRoute {
  readonly slot: number;
  /** Node currently serving the slot. During migration this is the source. */
  readonly owner: string;
  readonly node: ClusterNode;
  readonly phase: SlotPhase;
  readonly source?: string;
  readonly target?: string;
}

export type RedisArgument = string | number;

export interface RoutableCommand {
  readonly name: string;
  readonly args?: readonly RedisArgument[];
  /**
   * Explicit key list. Useful for extension commands or for callers that
   * already know the key positions. When supplied, command metadata is not
   * consulted.
   */
  readonly keys?: readonly string[];
  /** Overrides the command catalog's idempotency classification. */
  readonly idempotent?: boolean;
}

export interface WireCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly key: string | null;
  readonly idempotent: boolean;
}

export interface TransportContext {
  /**
   * When true the transport must send `ASKING` and the command on the same
   * connection, directly before the command.
   */
  readonly asking: boolean;
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

export interface TransportBatchEntry {
  readonly command: WireCommand;
  readonly asking: boolean;
}

export type TransportBatchItem =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/**
 * The only outbound dependency of the router. Implementations may use ioredis,
 * node-redis, a TCP pool, or an in-memory simulator.
 */
export interface ClusterTransport {
  execute(node: ClusterNode, command: WireCommand, context: TransportContext): Promise<unknown>;

  /**
   * Optional native pipeline. Results must be in input order. On a thrown
   * transport error the router assumes the whole batch has unknown delivery,
   * which is the only safe assumption without per-command information.
   */
  executeBatch?(
    node: ClusterNode,
    entries: readonly TransportBatchEntry[],
    context: Omit<TransportContext, "asking">,
  ): Promise<readonly TransportBatchItem[]>;
}

export interface RouteAttempt {
  readonly node: string;
  readonly attempt: number;
  readonly asking: boolean;
  readonly outcome:
    | "reply"
    | "moved"
    | "ask"
    | "try-again"
    | "not-sent"
    | "indeterminate"
    | "error";
}

export interface ExecutionResult<T = unknown> {
  readonly value: T;
  readonly slot: number | null;
  readonly node: ClusterNode;
  readonly attempts: readonly RouteAttempt[];
}

export interface PipelineItemResult<T = unknown> {
  /** Position in the caller-provided pipeline. */
  readonly index: number;
  readonly command: RoutableCommand;
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: Error;
  readonly slot: number | null;
  readonly node?: ClusterNode;
  readonly attempts: readonly RouteAttempt[];
}

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
}
