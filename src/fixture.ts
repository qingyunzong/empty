/**
 * Fixture graph library.
 *
 * - Immutable baselines: every commit produces a frozen snapshot (node table).
 * - Fork: cheap, snapshots are immutable so a branch simply references a base snapshot.
 * - Branch writes never pollute the baseline: materialize() returns fresh objects and
 *   commit() builds a brand-new node table; existing snapshots are never mutated.
 * - Aliases: shared references inside a graph stay shared (one node, one stable ID).
 * - Cycles: handled by stable IDs; a cycle is just a node referencing an existing ID.
 * - Merge: three-way merge over node tables; same field changed to different values
 *   on both sides is reported as a conflict, never silently resolved.
 */

export type Primitive = string | number | boolean | null;
export type NodeId = number;

export interface Ref {
  readonly $ref: NodeId;
}

export type Value = Primitive | Ref;

export interface RecordNode {
  readonly kind: "record";
  readonly fields: Readonly<Record<string, Value>>;
}

export interface ArrayNode {
  readonly kind: "array";
  readonly items: readonly Value[];
}

export type Node = RecordNode | ArrayNode;

export interface Snapshot {
  readonly id: number;
  readonly root: NodeId;
  readonly nodes: ReadonlyMap<NodeId, Node>;
}

export interface Conflict {
  readonly nodeId: NodeId;
  readonly field: string | null;
  readonly kind:
    | "field-value" // same field, different values on both sides
    | "node-type" // node kind changed differently
    | "delete-modify" // deleted on one side, modified on the other
    | "add-add"; // node added on both sides with different content
  readonly base: unknown;
  readonly ours: unknown;
  readonly theirs: unknown;
}

export type MergeResult =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly conflicts: readonly Conflict[] };

function isRef(value: Value): value is Ref {
  return typeof value === "object" && value !== null;
}

function valueEqual(a: Value | undefined, b: Value | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (isRef(a) || isRef(b)) {
    return isRef(a) && isRef(b) && a.$ref === b.$ref;
  }
  return a === b;
}

function nodeEqual(a: Node, b: Node): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "array" && b.kind === "array") {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, i) => valueEqual(item, b.items[i]));
  }
  const ra = a as RecordNode;
  const rb = b as RecordNode;
  const ka = Object.keys(ra.fields);
  const kb = Object.keys(rb.fields);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => valueEqual(ra.fields[k], rb.fields[k]));
}

export class FixtureLibrary {
  private nextNodeId = 1;
  private nextSnapshotId = 1;
  // Object identity -> stable node ID. Materialized objects are registered here so
  // re-committing a mutated checkout keeps IDs stable (this is what makes cycles
  // and three-way merge work across snapshots).
  private readonly identity = new WeakMap<object, NodeId>();

  /** Commit a plain JS object graph into a new immutable snapshot. */
  commit(root: unknown): Snapshot {
    if (typeof root !== "object" || root === null) {
      throw new TypeError("commit root must be an object or array");
    }
    const nodes = new Map<NodeId, Node>();
    const local = new Map<object, NodeId>();

    const visit = (value: unknown): Value => {
      if (value === null) return null;
      const t = typeof value;
      if (t === "string" || t === "number" || t === "boolean") {
        return value as Primitive;
      }
      if (t !== "object") {
        throw new TypeError(`unsupported value type in graph: ${t}`);
      }
      const obj = value as Record<string, unknown>;
      const seen = local.get(obj);
      if (seen !== undefined) return { $ref: seen };

      let id = this.identity.get(obj);
      if (id === undefined) {
        id = this.nextNodeId++;
        this.identity.set(obj, id);
      }
      local.set(obj, id);

      if (Array.isArray(obj)) {
        const items = (obj as unknown[]).map(visit);
        nodes.set(id, Object.freeze({ kind: "array", items: Object.freeze(items) }));
      } else {
        const fields: Record<string, Value> = {};
        for (const key of Object.keys(obj)) {
          fields[key] = visit(obj[key]);
        }
        nodes.set(id, Object.freeze({ kind: "record", fields: Object.freeze(fields) }));
      }
      return { $ref: id };
    };

    const rootValue = visit(root);
    const snapshot: Snapshot = {
      id: this.nextSnapshotId++,
      root: (rootValue as Ref).$ref,
      nodes,
    };
    return Object.freeze(snapshot);
  }

  /** Rebuild a plain JS graph from a snapshot, preserving aliases and cycles. */
  materialize<T = unknown>(snapshot: Snapshot): T {
    const memo = new Map<NodeId, unknown>();

    const build = (id: NodeId): unknown => {
      if (memo.has(id)) return memo.get(id);
      const node = snapshot.nodes.get(id);
      if (node === undefined) {
        throw new Error(`dangling reference to node #${id} in snapshot ${snapshot.id}`);
      }
      if (node.kind === "array") {
        const arr: unknown[] = [];
        memo.set(id, arr);
        this.identity.set(arr, id);
        for (const item of node.items) {
          arr.push(isRef(item) ? build(item.$ref) : item);
        }
        return arr;
      }
      const obj: Record<string, unknown> = {};
      memo.set(id, obj);
      this.identity.set(obj, id);
      for (const [key, value] of Object.entries(node.fields)) {
        obj[key] = isRef(value) ? build(value.$ref) : value;
      }
      return obj;
    };

    return build(snapshot.root) as T;
  }

  /** Fork a branch from a snapshot. Cheap: snapshots are immutable and shared. */
  fork(base: Snapshot): Branch {
    return new Branch(this, base);
  }

  /** Three-way merge of snapshots derived from a common base. */
  merge(base: Snapshot, ours: Snapshot, theirs: Snapshot): MergeResult {
    const conflicts: Conflict[] = [];
    const merged = new Map<NodeId, Node>();
    const ids = new Set<NodeId>([
      ...base.nodes.keys(),
      ...ours.nodes.keys(),
      ...theirs.nodes.keys(),
    ]);

    for (const id of [...ids].sort((a, b) => a - b)) {
      const node = this.mergeNode(
        id,
        base.nodes.get(id),
        ours.nodes.get(id),
        theirs.nodes.get(id),
        conflicts,
      );
      if (node !== undefined) merged.set(id, node);
    }

    if (conflicts.length > 0) {
      return { ok: false, conflicts: Object.freeze(conflicts) };
    }
    const snapshot: Snapshot = {
      id: this.nextSnapshotId++,
      root: ours.root,
      nodes: merged,
    };
    return { ok: true, snapshot: Object.freeze(snapshot) };
  }

  private mergeNode(
    id: NodeId,
    base: Node | undefined,
    ours: Node | undefined,
    theirs: Node | undefined,
    conflicts: Conflict[],
  ): Node | undefined {
    // Added after base.
    if (base === undefined) {
      if (ours !== undefined && theirs !== undefined) {
        if (nodeEqual(ours, theirs)) return ours;
        conflicts.push({
          nodeId: id,
          field: null,
          kind: "add-add",
          base: undefined,
          ours,
          theirs,
        });
        return ours;
      }
      return ours !== undefined ? ours : theirs;
    }

    // Deleted on one or both sides.
    if (ours === undefined || theirs === undefined) {
      if (ours === undefined && theirs === undefined) return undefined;
      const survivor = ours !== undefined ? ours : theirs;
      if (nodeEqual(base, survivor as Node)) return undefined; // untouched on the other side
      conflicts.push({
        nodeId: id,
        field: null,
        kind: "delete-modify",
        base,
        ours,
        theirs,
      });
      return survivor;
    }

    // Present on all three sides.
    if (nodeEqual(ours, theirs)) return ours;
    if (nodeEqual(base, ours)) return theirs;
    if (nodeEqual(base, theirs)) return ours;

    if (ours.kind !== theirs.kind || base.kind !== ours.kind) {
      conflicts.push({
        nodeId: id,
        field: null,
        kind: "node-type",
        base,
        ours,
        theirs,
      });
      return ours;
    }

    if (ours.kind === "array") {
      conflicts.push({
        nodeId: id,
        field: null,
        kind: "field-value",
        base: (base as ArrayNode).items,
        ours: (ours as ArrayNode).items,
        theirs: (theirs as ArrayNode).items,
      });
      return ours;
    }

    // Record: field-level three-way merge.
    const bf = (base as RecordNode).fields;
    const of = (ours as RecordNode).fields;
    const tf = (theirs as RecordNode).fields;
    const keys = new Set([...Object.keys(bf), ...Object.keys(of), ...Object.keys(tf)]);
    const fields: Record<string, Value> = {};
    for (const key of [...keys].sort()) {
      const bv = bf[key];
      const ov = of[key];
      const tv = tf[key];
      if (valueEqual(ov, tv)) {
        if (ov !== undefined) fields[key] = ov;
        continue;
      }
      if (valueEqual(bv, ov)) {
        if (tv !== undefined) fields[key] = tv;
        continue;
      }
      if (valueEqual(bv, tv)) {
        if (ov !== undefined) fields[key] = ov;
        continue;
      }
      conflicts.push({
        nodeId: id,
        field: key,
        kind: "field-value",
        base: bv,
        ours: ov,
        theirs: tv,
      });
      if (ov !== undefined) fields[key] = ov;
    }
    return Object.freeze({ kind: "record", fields: Object.freeze(fields) });
  }
}

export class Branch {
  constructor(
    private readonly lib: FixtureLibrary,
    readonly base: Snapshot,
  ) {}

  /** Materialize a fresh, mutable checkout of this branch's base snapshot. */
  checkout<T = unknown>(): T {
    return this.lib.materialize<T>(this.base);
  }

  /** Commit a (possibly mutated) checkout as a new snapshot on this branch. */
  commit(graph: unknown): Snapshot {
    return this.lib.commit(graph);
  }

  /** Merge another branch tip into a tip of this branch, three-way against base. */
  merge(ours: Snapshot, theirs: Snapshot): MergeResult {
    return this.lib.merge(this.base, ours, theirs);
  }
}
