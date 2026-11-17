import { SLOT_COUNT } from "./crc16.js";
import { InvalidRedirectError, SlotNotAssignedError } from "./errors.js";
import type {
  ClusterNode,
  Endpoint,
  SlotMigration,
  SlotPhase,
  SlotRange,
  SlotRoute,
  TopologySnapshot,
} from "./types.js";

interface CacheEntry {
  readonly slot: number;
  readonly owner: string;
  readonly node: ClusterNode;
  readonly phase: SlotPhase;
  readonly source?: string;
  readonly target?: string;
  /**
   * Revision of the latest local MOVED update. It prevents a topology refresh
   * that started before the MOVED from overwriting the newer information.
   */
  readonly localRevision: number;
}

export interface ApplyTopologyOptions {
  /**
   * Only replace entries whose `localRevision` is at most this value. Callers
   * pass the cache revision captured when the topology fetch started.
   */
  readonly ifLocalRevisionAtMost?: number;
}

function nodeId(endpoint: Endpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

function validateSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new RangeError(`Hash slot must be an integer in [0, ${SLOT_COUNT - 1}], received ${slot}`);
  }
}

function validateMigration(migration: SlotMigration): void {
  validateSlot(migration.slot);
  if (!migration.from || !migration.to || migration.from === migration.to) {
    throw new TypeError(
      `Invalid migration for slot ${migration.slot}: from=${migration.from} to=${migration.to}`,
    );
  }
}

/**
 * Slot -> node routing cache. It is intentionally independent of any Redis
 * client so it can be embedded and tested with a synthetic topology.
 */
export class RouteCache {
  readonly #slots: Array<CacheEntry | undefined> = new Array(SLOT_COUNT);
  #nodes = new Map<string, ClusterNode>();
  #revision = 0;
  #epoch = Number.NEGATIVE_INFINITY;

  constructor(snapshot?: TopologySnapshot) {
    if (snapshot) {
      this.applyTopology(snapshot);
    }
  }

  get revision(): number {
    return this.#revision;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get size(): number {
    let count = 0;
    for (const entry of this.#slots) {
      if (entry) {
        count += 1;
      }
    }
    return count;
  }

  get nodes(): readonly ClusterNode[] {
    return [...this.#nodes.values()];
  }

  getNode(id: string): ClusterNode | undefined {
    return this.#nodes.get(id);
  }

  findNode(endpoint: Endpoint): ClusterNode | undefined {
    for (const node of this.#nodes.values()) {
      if (node.host === endpoint.host && node.port === endpoint.port) {
        return node;
      }
    }
    return undefined;
  }

  get(slot: number): SlotRoute | undefined {
    validateSlot(slot);
    const entry = this.#slots[slot];
    if (!entry) {
      return undefined;
    }
    return {
      slot,
      owner: entry.owner,
      node: entry.node,
      phase: entry.phase,
      source: entry.source,
      target: entry.target,
    };
  }

  require(slot: number): SlotRoute {
    const route = this.get(slot);
    if (!route) {
      throw new SlotNotAssignedError(slot);
    }
    return route;
  }

  /**
   * Applies a complete topology snapshot. Slot ranges are applied first and
   * migrations then mark an owner/peer pair. Slots not covered by the snapshot
   * are cleared.
   */
  applyTopology(snapshot: TopologySnapshot, options: ApplyTopologyOptions = {}): void {
    if (snapshot.epoch !== undefined) {
      if (snapshot.epoch < this.#epoch) {
        return;
      }
    }

    const ifAtMost = options.ifLocalRevisionAtMost ?? Number.POSITIVE_INFINITY;
    const nodes = new Map<string, ClusterNode>();

    for (const [id, endpoint] of Object.entries(snapshot.nodes)) {
      if (!id || !endpoint || typeof endpoint.host !== "string" || !Number.isInteger(endpoint.port)) {
        throw new TypeError(`Invalid topology node ${JSON.stringify(id)}`);
      }
      nodes.set(id, { id, host: endpoint.host, port: endpoint.port });
    }

    const assignments = new Map<number, {
      slot: number;
      owner: string;
      phase: SlotPhase;
      source?: string;
      target?: string;
    }>();

    for (const range of snapshot.slots) {
      this.#validateRange(range, nodes);
      for (let slot = range.start; slot <= range.end; slot += 1) {
        if (assignments.has(slot)) {
          throw new TypeError(`Topology contains overlapping ranges at slot ${slot}`);
        }
        assignments.set(slot, { slot, owner: range.owner, phase: "stable" });
      }
    }

    const migrations = snapshot.migrations ?? [];
    for (const migration of migrations) {
      validateMigration(migration);
      if (!nodes.has(migration.from) || !nodes.has(migration.to)) {
        throw new TypeError(
          `Migration for slot ${migration.slot} references an unknown node ` +
            `(${migration.from} -> ${migration.to})`,
        );
      }
      assignments.set(migration.slot, {
        slot: migration.slot,
        owner: migration.from,
        phase: migration.state ?? "migrating",
        source: migration.from,
        target: migration.to,
      });
    }

    const next: Array<CacheEntry | undefined> = new Array(SLOT_COUNT);
    for (const assignment of assignments.values()) {
      validateSlot(assignment.slot);
      const existing = this.#slots[assignment.slot];
      if (existing && existing.localRevision > ifAtMost) {
        next[assignment.slot] = existing;
        continue;
      }

      const node = nodes.get(assignment.owner);
      if (!node) {
        throw new TypeError(`Unknown owner ${assignment.owner} for slot ${assignment.slot}`);
      }
      next[assignment.slot] = {
        slot: assignment.slot,
        owner: assignment.owner,
        node,
        phase: assignment.phase,
        source: assignment.source,
        target: assignment.target,
        localRevision: existing?.localRevision ?? 0,
      };
    }

    // Preserve locally learned MOVED routes that were newer than the fetch.
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const existing = this.#slots[slot];
      if (!next[slot] && existing && existing.localRevision > ifAtMost) {
        next[slot] = existing;
      }
    }

    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      this.#slots[slot] = next[slot];
    }

    // Local MOVED targets are kept even when they are absent from the fetched
    // snapshot, because a pending redirect may still reference one of them.
    for (const node of this.#nodes.values()) {
      if (!nodes.has(node.id)) {
        nodes.set(node.id, node);
      }
    }
    this.#nodes = nodes;
    this.#revision += 1;
    if (snapshot.epoch !== undefined) {
      this.#epoch = snapshot.epoch;
    }
  }

  /**
   * Applies a MOVED redirect. This is the authoritative, persistent update for
   * the slot and clears any migrating/importing state.
   */
  applyMoved(slot: number, endpoint: Endpoint, ownerId = nodeId(endpoint)): SlotRoute {
    validateSlot(slot);
    if (typeof endpoint.host !== "string" || !Number.isInteger(endpoint.port)) {
      throw new InvalidRedirectError("MOVED", `bad target ${JSON.stringify(endpoint)}`);
    }

    const node: ClusterNode = { id: ownerId, host: endpoint.host, port: endpoint.port };
    this.#nodes.set(ownerId, node);
    this.#revision += 1;

    const entry: CacheEntry = {
      slot,
      owner: ownerId,
      node,
      phase: "stable",
      localRevision: this.#revision,
    };
    this.#slots[slot] = entry;
    return { slot, owner: ownerId, node, phase: "stable" };
  }

  /**
   * Replaces the endpoints of known nodes without touching slot ownership.
   * Useful when a cluster node's address changes but its node id is stable.
   */
  updateNode(id: string, endpoint: Endpoint): void {
    const node: ClusterNode = { id, host: endpoint.host, port: endpoint.port };
    this.#nodes.set(id, node);
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const entry = this.#slots[slot];
      if (entry?.owner === id) {
        this.#slots[slot] = { ...entry, node };
      }
    }
    this.#revision += 1;
  }

  #validateRange(range: SlotRange, nodes: ReadonlyMap<string, ClusterNode>): void {
    validateSlot(range.start);
    validateSlot(range.end);
    if (range.start > range.end) {
      throw new TypeError(`Invalid slot range ${range.start}-${range.end}`);
    }
    if (!nodes.has(range.owner)) {
      throw new TypeError(`Unknown owner ${range.owner} for slot range ${range.start}-${range.end}`);
    }
  }
}
