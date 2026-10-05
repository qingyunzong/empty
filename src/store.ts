export type NodeId = string;
export type EdgeId = string;
export type Label = string;
export type VersionId = number;

export interface Edge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly label: Label;
}

export interface Relabel {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly oldLabel: Label;
  readonly newLabel: Label;
}

export interface Delta {
  readonly added: readonly Edge[];
  readonly removed: readonly Edge[];
  readonly relabeled: readonly Relabel[];
}

export type BatchOp =
  | { readonly type: 'add'; readonly edge: Edge }
  | { readonly type: 'remove'; readonly id: EdgeId }
  | { readonly type: 'relabel'; readonly id: EdgeId; readonly label: Label };

export class StoreError extends Error {}

export type Snapshot = ReadonlyMap<EdgeId, Edge>;

function copySnapshot(s: Snapshot): Map<EdgeId, Edge> {
  return new Map(s);
}

export function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [id, e] of a) {
    const o = b.get(id);
    if (!o || o.from !== e.from || o.to !== e.to || o.label !== e.label) return false;
  }
  return true;
}

/**
 * Set-difference diff between two snapshots, keyed by edge id.
 * Same (from, to) endpoints with different ids are never merged.
 * Same id with changed endpoints is reported as remove + add, not relabel.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): Delta {
  const added: Edge[] = [];
  const removed: Edge[] = [];
  const relabeled: Relabel[] = [];
  for (const [id, e] of after) {
    const old = before.get(id);
    if (!old) {
      added.push(e);
    } else if (old.label !== e.label && old.from === e.from && old.to === e.to) {
      relabeled.push({ id, from: e.from, to: e.to, oldLabel: old.label, newLabel: e.label });
    }
  }
  for (const [id, e] of before) {
    const now = after.get(id);
    if (!now) {
      removed.push(e);
    } else if (now.from !== e.from || now.to !== e.to) {
      removed.push(e);
      added.push(now);
    }
  }
  return { added, removed, relabeled };
}

export function invertDelta(d: Delta): Delta {
  return {
    added: [...d.removed],
    removed: [...d.added],
    relabeled: d.relabeled.map((r) => ({
      id: r.id,
      from: r.from,
      to: r.to,
      oldLabel: r.newLabel,
      newLabel: r.oldLabel,
    })),
  };
}

export function applyDelta(base: Snapshot, d: Delta): Snapshot {
  const next = copySnapshot(base);
  for (const e of d.removed) next.delete(e.id);
  for (const e of d.added) next.set(e.id, e);
  for (const r of d.relabeled) {
    const cur = next.get(r.id);
    if (cur) next.set(r.id, { ...cur, label: r.newLabel });
  }
  return next;
}

/**
 * Versioned store of directed, labeled edges. Cycles and self-loops are
 * allowed; parallel edges (same endpoints, distinct ids) are kept separate.
 * Each committed batch produces a new immutable version; a batch is atomic:
 * if any op is invalid the whole batch is rejected and no version is created.
 */
export class RelationStore {
  private readonly versions = new Map<VersionId, Snapshot>();
  private currentVersion: VersionId;

  constructor() {
    const v0: Snapshot = new Map();
    this.versions.set(0, v0);
    this.currentVersion = 0;
  }

  get current(): VersionId {
    return this.currentVersion;
  }

  snapshot(version: VersionId = this.currentVersion): Snapshot {
    const s = this.versions.get(version);
    if (!s) throw new StoreError(`unknown version: ${version}`);
    return s;
  }

  commit(batch: readonly BatchOp[]): VersionId {
    const next = copySnapshot(this.snapshot());
    const staged = new Map<EdgeId, Edge>();
    for (const op of batch) {
      switch (op.type) {
        case 'add': {
          if (next.has(op.edge.id) || staged.has(op.edge.id)) {
            throw new StoreError(`add: duplicate edge id ${op.edge.id}`);
          }
          staged.set(op.edge.id, op.edge);
          break;
        }
        case 'remove': {
          const target = staged.get(op.id) ?? next.get(op.id);
          if (!target) throw new StoreError(`remove: unknown edge id ${op.id}`);
          staged.delete(op.id);
          next.delete(op.id);
          break;
        }
        case 'relabel': {
          const target = staged.get(op.id) ?? next.get(op.id);
          if (!target) throw new StoreError(`relabel: unknown edge id ${op.id}`);
          staged.set(op.id, { ...target, label: op.label });
          break;
        }
        default:
          throw new StoreError(`unknown op: ${JSON.stringify(op)}`);
      }
    }
    for (const [id, e] of staged) next.set(id, e);
    const version = this.currentVersion + 1;
    this.versions.set(version, next);
    this.currentVersion = version;
    return version;
  }

  diff(from: VersionId, to: VersionId): Delta {
    return diffSnapshots(this.snapshot(from), this.snapshot(to));
  }

  /** Apply the inverse of diff(from, to) to version `to`; must equal `from`. */
  validateInverse(from: VersionId, to: VersionId): boolean {
    const forward = this.diff(from, to);
    const restored = applyDelta(this.snapshot(to), invertDelta(forward));
    return snapshotsEqual(restored, this.snapshot(from));
  }
}
