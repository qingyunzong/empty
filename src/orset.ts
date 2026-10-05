/**
 * OR-Set (observed-remove set) CRDT for offline-first replicas.
 *
 * Semantics:
 * - Every `add` is stamped with a unique tag `(replicaId, seq)`.
 * - `remove` only tombstones the tags observed locally at that moment;
 *   concurrent/unseen adds survive ("add-wins" against old removes).
 * - Merge is a union of live entries and tombstones (minus tombstoned tags),
 *   so it is associative, commutative and idempotent.
 * - Every mutation is an op carrying `(replicaId, seq)`. Applying ops is
 *   idempotent (duplicates are dropped) and order-tolerant (out-of-order
 *   ops per replica are buffered until the gap fills).
 * - Compaction drops tombstones only when confirmation vectors from ALL
 *   known replicas cover the remove op that created them.
 */

export type ReplicaId = string;

/** A logical clock reference: uniquely identifies an op (and thus an add tag). */
export interface OpRef {
  replica: ReplicaId;
  seq: number;
}

export interface AddOp<T> {
  kind: 'add';
  replica: ReplicaId;
  seq: number;
  value: T;
  /** Unique tag of this add: the op's own ref. */
  tag: OpRef;
}

export interface RemoveOp<T> {
  kind: 'remove';
  replica: ReplicaId;
  seq: number;
  value: T;
  /** Tags observed (and therefore removed) by this remove. */
  tags: OpRef[];
}

export type Op<T> = AddOp<T> | RemoveOp<T>;

/** Version vector: highest contiguous seq applied per replica. */
export type VersionVector = Record<ReplicaId, number>;

interface Tombstone {
  tag: OpRef;
  /** Remove ops that tombstoned this tag (unioned across merges). */
  removers: OpRef[];
}

/** Serializable snapshot of a replica's full state. */
export interface ORSetState<T> {
  replicaId: ReplicaId;
  vv: VersionVector;
  live: Array<{ value: T; tags: OpRef[] }>;
  tombstones: Array<{ value: T; entries: Tombstone[] }>;
  pending: Array<Op<T>>;
}

const refKey = (r: OpRef): string => `${r.replica}#${r.seq}`;

const defaultKeyOf = <T>(value: T): string => JSON.stringify(value);

export class ORSet<T> {
  readonly replicaId: ReplicaId;
  private readonly keyOf: (value: T) => string;

  private localSeq = 0;
  /** valueKey -> live value + its add tags. */
  private live = new Map<string, { value: T; tags: Map<string, OpRef> }>();
  /** valueKey -> tombstoned tags. */
  private tombstones = new Map<string, { value: T; entries: Map<string, Tombstone> }>();
  /** Highest contiguous seq applied per replica. */
  private vv = new Map<ReplicaId, number>();
  /** Out-of-order ops waiting for gaps, per replica. */
  private pending = new Map<ReplicaId, Map<number, Op<T>>>();

  constructor(replicaId: ReplicaId, keyOf: (value: T) => string = defaultKeyOf) {
    this.replicaId = replicaId;
    this.keyOf = keyOf;
  }

  // ---------------------------------------------------------------- queries

  has(value: T): boolean {
    const entry = this.live.get(this.keyOf(value));
    return entry !== undefined && entry.tags.size > 0;
  }

  values(): T[] {
    const out: T[] = [];
    for (const entry of this.live.values()) {
      if (entry.tags.size > 0) out.push(entry.value);
    }
    return out;
  }

  get size(): number {
    return this.values().length;
  }

  /** Number of retained tombstones (observability for compaction). */
  get tombstoneCount(): number {
    let n = 0;
    for (const t of this.tombstones.values()) n += t.entries.size;
    return n;
  }

  /** This replica's version vector (its confirmation of what it has applied). */
  versionVector(): VersionVector {
    const out: VersionVector = {};
    for (const [replica, seq] of this.vv) out[replica] = seq;
    return out;
  }

  /** Replicas this node knows about (self included). */
  knownReplicas(): ReplicaId[] {
    const ids = new Set<ReplicaId>(this.vv.keys());
    ids.add(this.replicaId);
    return [...ids].sort();
  }

  // ------------------------------------------------------------- local ops

  /** Add a value; returns the op to broadcast to peers. */
  add(value: T): AddOp<T> {
    const op: AddOp<T> = {
      kind: 'add',
      replica: this.replicaId,
      seq: ++this.localSeq,
      value,
      tag: { replica: this.replicaId, seq: this.localSeq },
    };
    this.applyEffect(op);
    this.vv.set(this.replicaId, op.seq);
    return op;
  }

  /**
   * Remove a value; tombstones only the tags observed right now.
   * Returns the op to broadcast to peers.
   */
  remove(value: T): RemoveOp<T> {
    const entry = this.live.get(this.keyOf(value));
    const tags = entry ? [...entry.tags.values()] : [];
    const op: RemoveOp<T> = {
      kind: 'remove',
      replica: this.replicaId,
      seq: ++this.localSeq,
      value,
      tags,
    };
    this.applyEffect(op);
    this.vv.set(this.replicaId, op.seq);
    return op;
  }

  // ----------------------------------------------------------- remote ops

  /**
   * Apply an op received from the network (ops from self are also accepted).
   * Idempotent: duplicates are ignored. Out-of-order ops per origin replica
   * are buffered and flushed once the gap fills. Returns true if the op (or
   * buffered successors) advanced the state.
   */
  apply(op: Op<T>): boolean {
    const seen = this.vv.get(op.replica) ?? 0;
    if (op.seq <= seen) return false; // duplicate
    if (op.seq > seen + 1) {
      let queue = this.pending.get(op.replica);
      if (!queue) {
        queue = new Map();
        this.pending.set(op.replica, queue);
      }
      if (!queue.has(op.seq)) queue.set(op.seq, op);
      return false;
    }
    this.applyEffect(op);
    this.vv.set(op.replica, op.seq);
    // Drain contiguous buffered ops.
    const queue = this.pending.get(op.replica);
    if (queue) {
      let next = op.seq + 1;
      let buffered = queue.get(next);
      while (buffered) {
        queue.delete(next);
        this.applyEffect(buffered);
        this.vv.set(buffered.replica, next);
        next += 1;
        buffered = queue.get(next);
      }
      if (queue.size === 0) this.pending.delete(op.replica);
    }
    return true;
  }

  private applyEffect(op: Op<T>): void {
    const key = this.keyOf(op.value);
    if (op.kind === 'add') {
      const tomb = this.tombstones.get(key);
      if (tomb?.entries.has(refKey(op.tag))) return; // remove arrived first
      let entry = this.live.get(key);
      if (!entry) {
        entry = { value: op.value, tags: new Map() };
        this.live.set(key, entry);
      }
      entry.tags.set(refKey(op.tag), op.tag);
    } else {
      if (op.tags.length === 0) return;
      const remover: OpRef = { replica: op.replica, seq: op.seq };
      let tomb = this.tombstones.get(key);
      if (!tomb) {
        tomb = { value: op.value, entries: new Map() };
        this.tombstones.set(key, tomb);
      }
      const entry = this.live.get(key);
      for (const tag of op.tags) {
        const k = refKey(tag);
        const existing = tomb.entries.get(k);
        if (existing) {
          if (!existing.removers.some((r) => refKey(r) === refKey(remover))) {
            existing.removers.push(remover);
          }
        } else {
          tomb.entries.set(k, { tag, removers: [remover] });
        }
        entry?.tags.delete(k);
      }
    }
  }

  // ----------------------------------------------------------------- merge

  /**
   * Union-merge another replica's state (or live ORSet) into this one.
   * Associative, commutative, idempotent: safe for gossip in any order,
   * any number of times.
   */
  merge(other: ORSet<T> | ORSetState<T>): void {
    const state = other instanceof ORSet ? other.toState() : other;
    // 1. Union tombstones.
    for (const { value, entries } of state.tombstones) {
      const key = this.keyOf(value);
      let tomb = this.tombstones.get(key);
      if (!tomb) {
        tomb = { value, entries: new Map() };
        this.tombstones.set(key, tomb);
      }
      for (const t of entries) {
        const k = refKey(t.tag);
        const existing = tomb.entries.get(k);
        if (!existing) {
          tomb.entries.set(k, { tag: t.tag, removers: [...t.removers] });
        } else {
          for (const r of t.removers) {
            if (!existing.removers.some((x) => refKey(x) === refKey(r))) {
              existing.removers.push(r);
            }
          }
        }
      }
    }
    // 2. Union live entries, dropping anything tombstoned on either side.
    for (const { value, tags } of state.live) {
      const key = this.keyOf(value);
      const tomb = this.tombstones.get(key);
      let entry = this.live.get(key);
      for (const tag of tags) {
        const k = refKey(tag);
        if (tomb?.entries.has(k)) continue;
        if (!entry) {
          entry = { value, tags: new Map() };
          this.live.set(key, entry);
        }
        entry.tags.set(k, tag);
      }
    }
    for (const [key, entry] of this.live) {
      const tomb = this.tombstones.get(key);
      if (!tomb) continue;
      for (const k of [...entry.tags.keys()]) {
        if (tomb.entries.has(k)) entry.tags.delete(k);
      }
    }
    // 3. Version vectors: component-wise max.
    for (const [replica, seq] of Object.entries(state.vv)) {
      const cur = this.vv.get(replica) ?? 0;
      if (seq > cur) this.vv.set(replica, seq);
    }
    this.localSeq = Math.max(this.localSeq, this.vv.get(this.replicaId) ?? 0);
    // 4. Absorb the peer's out-of-order buffer (may fill our gaps).
    for (const op of state.pending) this.apply(op);
  }

  // ------------------------------------------------------------ compaction

  /**
   * Drop tombstones that every known replica has confirmed applying.
   *
   * `acks` must map every known replica id to its version vector
   * (self is taken from the local clock automatically). Throws if any
   * known replica's confirmation is missing: without unanimous
   * confirmation, compaction is refused.
   *
   * A tombstone is dropped when the component-wise meet of all
   * confirmation vectors covers at least one remove op that created it —
   * meaning every replica has applied that remove and no replica can
   * still hold the tag live.
   */
  compact(acks: Record<ReplicaId, VersionVector>): number {
    const known = this.knownReplicas();
    const missing = known.filter((id) => id !== this.replicaId && !(id in acks));
    if (missing.length > 0) {
      throw new Error(
        `compaction refused: missing confirmation vector from replica(s): ${missing.join(', ')}`,
      );
    }
    const meet = new Map<ReplicaId, number>();
    const vectors: VersionVector[] = [this.versionVector()];
    for (const id of known) {
      if (id !== this.replicaId) vectors.push(acks[id]!);
    }
    for (const vector of vectors) {
      for (const [replica, seq] of Object.entries(vector)) {
        const cur = meet.get(replica);
        if (cur === undefined || seq < cur) meet.set(replica, seq);
      }
    }
    const covered = (ref: OpRef): boolean => (meet.get(ref.replica) ?? 0) >= ref.seq;

    let dropped = 0;
    for (const [key, tomb] of this.tombstones) {
      for (const [tagK, t] of [...tomb.entries]) {
        if (t.removers.some(covered)) {
          tomb.entries.delete(tagK);
          dropped += 1;
        }
      }
      if (tomb.entries.size === 0) this.tombstones.delete(key);
    }
    return dropped;
  }

  // --------------------------------------------------------- serialization

  toState(): ORSetState<T> {
    const live: ORSetState<T>['live'] = [];
    for (const entry of this.live.values()) {
      if (entry.tags.size > 0) live.push({ value: entry.value, tags: [...entry.tags.values()] });
    }
    const tombstones: ORSetState<T>['tombstones'] = [];
    for (const tomb of this.tombstones.values()) {
      tombstones.push({
        value: tomb.value,
        entries: [...tomb.entries.values()].map((t) => ({
          tag: t.tag,
          removers: [...t.removers],
        })),
      });
    }
    const pending: Op<T>[] = [];
    for (const queue of this.pending.values()) pending.push(...queue.values());
    return {
      replicaId: this.replicaId,
      vv: this.versionVector(),
      live,
      tombstones,
      pending,
    };
  }

  static fromState<T>(state: ORSetState<T>, keyOf?: (value: T) => string): ORSet<T> {
    const set = new ORSet<T>(state.replicaId, keyOf);
    set.merge(state);
    set.localSeq = set.vv.get(state.replicaId) ?? 0;
    return set;
  }

  toJSON(): ORSetState<T> {
    return this.toState();
  }
}
