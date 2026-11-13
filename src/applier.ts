import {
  buildNode,
  collectIds,
  payloadIds,
  referencedIds,
  toPayload,
  type DomNode,
  type NodeId,
  type NodePayload,
  type SnapshotEvent,
} from "./model.ts";
import { hashDom } from "./hash.ts";

export type ApplyStatus =
  | "applied" // mutation applied immediately
  | "deferred" // target node unknown; buffered to wait for it
  | "stale"; // target was deleted (or payload id clashes); event dropped

export interface ApplierOptions {
  /** Max events held in the waiting area; oldest are dropped beyond this. */
  maxPendingEvents?: number;
  /** Max remembered deleted node ids used to invalidate stale events. */
  maxTombstones?: number;
  /** Max retained version -> hash entries. */
  maxVersionHistory?: number;
}

export interface ApplierStats {
  version: number;
  nodeCount: number;
  pendingCount: number;
  droppedPending: number;
  staleEvents: number;
  tombstoneCount: number;
}

const DEFAULT_MAX_PENDING = 1024;
const DEFAULT_MAX_TOMBSTONES = 4096;
const DEFAULT_MAX_VERSION_HISTORY = 4096;

/**
 * Applies a stream of incremental DOM events onto an in-memory tree.
 *
 * - Events referencing unknown nodes wait in a bounded FIFO queue and are
 *   re-evaluated (in order) after every applied mutation.
 * - Removing a subtree tombstones its ids: later events targeting those ids
 *   are rejected as stale, and queued events for them are purged.
 * - Every applied mutation bumps the version and records a deterministic
 *   hash, verifiable against a full snapshot of the same version.
 */
export class DomSnapshotApplier {
  #root: DomNode | null = null;
  #nodes = new Map<NodeId, DomNode>();
  #pending: SnapshotEvent[] = [];
  #tombstones = new Set<NodeId>();
  #version = 0;
  #hashes = new Map<number, string>();
  #droppedPending = 0;
  #staleEvents = 0;

  readonly #maxPending: number;
  readonly #maxTombstones: number;
  readonly #maxVersionHistory: number;

  constructor(options: ApplierOptions = {}) {
    this.#maxPending = options.maxPendingEvents ?? DEFAULT_MAX_PENDING;
    this.#maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
    this.#maxVersionHistory = options.maxVersionHistory ?? DEFAULT_MAX_VERSION_HISTORY;
  }

  get version(): number {
    return this.#version;
  }

  get root(): DomNode | null {
    return this.#root;
  }

  /** Replace all state with a full snapshot; resets version to 0. */
  loadFullSnapshot(root: NodePayload): string {
    this.#root = buildNode(root);
    this.#nodes.clear();
    this.#register(this.#root);
    this.#pending = [];
    this.#tombstones.clear();
    this.#hashes.clear();
    this.#version = -1;
    return this.#commit();
  }

  apply(event: SnapshotEvent): ApplyStatus {
    const status = this.#classify(event);
    if (status === "stale") {
      this.#staleEvents++;
      return "stale";
    }
    if (status === "deferred") {
      this.#enqueue(event);
      return "deferred";
    }
    this.#applyNow(event);
    this.#drain();
    return "applied";
  }

  /** Deterministic hash of the current tree (empty tree hashes as ""). */
  currentHash(): string {
    return this.#root ? hashDom(this.#root) : fnvEmpty;
  }

  hashAtVersion(version: number): string | undefined {
    return this.#hashes.get(version);
  }

  /**
   * Compare a full snapshot payload against the tree at `version`
   * (defaults to the current version).
   */
  verifyAgainstSnapshot(snapshot: NodePayload, version: number = this.#version): boolean {
    const expected = this.#hashes.get(version);
    if (expected === undefined) return false;
    return hashDom(buildNode(snapshot)) === expected;
  }

  /** Current tree as a plain payload, or null when empty. */
  toPayload(): NodePayload | null {
    return this.#root ? toPayload(this.#root) : null;
  }

  stats(): ApplierStats {
    return {
      version: this.#version,
      nodeCount: this.#nodes.size,
      pendingCount: this.#pending.length,
      droppedPending: this.#droppedPending,
      staleEvents: this.#staleEvents,
      tombstoneCount: this.#tombstones.size,
    };
  }

  #classify(event: SnapshotEvent): ApplyStatus {
    const refs = referencedIds(event);
    if (refs.some((id) => this.#tombstones.has(id))) return "stale";
    if (refs.some((id) => !this.#nodes.has(id))) return "deferred";
    if (event.type === "insert" && payloadIds(event.node).some((id) => this.#nodes.has(id))) {
      return "stale"; // payload id already lives in the tree
    }
    if (event.type === "shadowRoot" && payloadIds(event.root).some((id) => this.#nodes.has(id))) {
      return "stale";
    }
    return "applied";
  }

  #enqueue(event: SnapshotEvent): void {
    while (this.#pending.length >= this.#maxPending) {
      this.#pending.shift();
      this.#droppedPending++;
    }
    this.#pending.push(event);
  }

  #drain(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.#pending.length; ) {
        const event = this.#pending[i];
        const status = this.#classify(event);
        if (status === "deferred") {
          i++;
          continue;
        }
        this.#pending.splice(i, 1);
        if (status === "stale") {
          this.#staleEvents++;
        } else {
          this.#applyNow(event);
        }
        progress = true;
      }
    }
  }

  #applyNow(event: SnapshotEvent): void {
    switch (event.type) {
      case "insert": {
        const parent = this.#nodes.get(event.parentId)!;
        const node = buildNode(event.node, parent);
        const index = Math.max(0, Math.min(event.index ?? parent.children.length, parent.children.length));
        parent.children.splice(index, 0, node);
        this.#register(node);
        break;
      }
      case "remove": {
        this.#removeSubtree(this.#nodes.get(event.nodeId)!);
        break;
      }
      case "attribute": {
        const node = this.#nodes.get(event.nodeId)!;
        if (event.value === null) node.attributes.delete(event.name);
        else node.attributes.set(event.name, event.value);
        break;
      }
      case "text": {
        this.#nodes.get(event.nodeId)!.text = event.text;
        break;
      }
      case "shadowRoot": {
        const host = this.#nodes.get(event.hostId)!;
        if (host.shadowRoot) this.#removeSubtree(host.shadowRoot);
        const root = buildNode(event.root, host);
        host.shadowRoot = root;
        this.#register(root);
        break;
      }
    }
    this.#commit();
  }

  #removeSubtree(node: DomNode): void {
    if (node.parent) {
      if (node.parent.shadowRoot === node) {
        node.parent.shadowRoot = null;
      } else {
        const siblings = node.parent.children;
        const at = siblings.indexOf(node);
        if (at >= 0) siblings.splice(at, 1);
      }
      node.parent = null;
    }
    if (node === this.#root) this.#root = null;
    const removed = new Set(collectIds(node));
    for (const id of removed) {
      this.#nodes.delete(id);
      this.#addTombstone(id);
    }
    // Deleting a parent tree invalidates queued events that were waiting
    // on any node inside it.
    if (this.#pending.length > 0) {
      const kept = this.#pending.filter((event) => {
        const dead = referencedIds(event).some((id) => removed.has(id));
        if (dead) this.#staleEvents++;
        return !dead;
      });
      this.#pending = kept;
    }
  }

  #register(node: DomNode): void {
    this.#nodes.set(node.id, node);
    this.#tombstones.delete(node.id); // id reuse revives it
    for (const child of node.children) this.#register(child);
    if (node.shadowRoot) this.#register(node.shadowRoot);
  }

  #addTombstone(id: NodeId): void {
    this.#tombstones.delete(id);
    while (this.#tombstones.size >= this.#maxTombstones) {
      const oldest = this.#tombstones.values().next().value!;
      this.#tombstones.delete(oldest);
    }
    this.#tombstones.add(id);
  }

  #commit(): string {
    this.#version++;
    const hash = this.#root ? hashDom(this.#root) : fnvEmpty;
    while (this.#hashes.size >= this.#maxVersionHistory) {
      const oldest = this.#hashes.keys().next().value!;
      this.#hashes.delete(oldest);
    }
    this.#hashes.set(this.#version, hash);
    return hash;
  }
}

const fnvEmpty = "cbf29ce484222325"; // FNV-1a 64 offset basis: hash of ""
