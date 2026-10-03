// Core replicated-state library for the observatory station network.
// Single-process simulation: one Cluster owns membership epochs, per-node
// logs/vectors and a link matrix used to model network partitions.

export class ReplicaError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ReplicaError';
    this.code = code;
  }
}

export const NOT_MEMBER = 'NOT_MEMBER';
export const EPOCH_MISMATCH = 'EPOCH_MISMATCH';
export const QUORUM_FAIL = 'QUORUM_FAIL';

function compareEntries(a, b) {
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  return a.seq - b.seq;
}

// a happens-before b iff a.vector <= b.vector componentwise and != somewhere.
export function happensBefore(va, vb) {
  let strict = false;
  const keys = new Set([...Object.keys(va), ...Object.keys(vb)]);
  for (const k of keys) {
    const av = va[k] ?? 0;
    const bv = vb[k] ?? 0;
    if (av > bv) return false;
    if (av < bv) strict = true;
  }
  return strict;
}

// Deterministic topological sort: causal order first, concurrent entries
// ordered by (origin, seq). Same entry set always yields the same order.
export function causalSort(entries) {
  const remaining = new Set(entries);
  const placed = [];
  while (remaining.size > 0) {
    let best = null;
    for (const e of remaining) {
      let ready = true;
      for (const other of remaining) {
        if (other !== e && happensBefore(other.vector, e.vector)) {
          ready = false;
          break;
        }
      }
      if (ready && (best === null || compareEntries(e, best) < 0)) best = e;
    }
    remaining.delete(best);
    placed.push(best);
  }
  return placed;
}

// Visible value of a key = value of the causally-last entry for that key.
export function visibleValue(entries) {
  if (entries.length === 0) return undefined;
  const sorted = causalSort(entries);
  return sorted[sorted.length - 1].value;
}

export class Cluster {
  constructor() {
    this.epoch = 0;
    this.members = new Map(); // id -> {id, status, joinedEpoch, leftEpoch}
    this.nodes = new Map();   // id -> {id, vector:Map, log:[], seq} (kept after tombstone for audit)
    this.links = new Map();   // sorted "a\0b" -> boolean (default true)
    this.history = [];        // membership events, auditable
  }

  static linkKey(a, b) {
    return [a, b].sort().join('\0');
  }

  setConnected(a, b, on) {
    this.links.set(Cluster.linkKey(a, b), Boolean(on));
  }

  isConnected(a, b) {
    if (a === b) return true;
    return this.links.get(Cluster.linkKey(a, b)) !== false;
  }

  heal() {
    this.links.clear();
  }

  // Cut links across groups, connect within each group.
  partition(groups) {
    const groupOf = new Map();
    groups.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
    const ids = [...this.members.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        this.setConnected(ids[i], ids[j], groupOf.get(ids[i]) === groupOf.get(ids[j]));
      }
    }
  }

  activeIds() {
    return [...this.members.values()]
      .filter((m) => m.status === 'active')
      .map((m) => m.id)
      .sort();
  }

  quorum() {
    return Math.floor(this.activeIds().length / 2) + 1;
  }

  nodeState(id) {
    let st = this.nodes.get(id);
    if (!st) {
      st = { id, vector: new Map(), log: [], pending: [], seq: 0 };
      this.nodes.set(id, st);
    }
    return st;
  }

  join(id) {
    const m = this.members.get(id);
    if (m && m.status === 'active') {
      return { epoch: this.epoch, idempotent: true, members: this.activeIds() };
    }
    this.epoch += 1;
    this.members.set(id, { id, status: 'active', joinedEpoch: this.epoch, leftEpoch: null });
    this.nodeState(id);
    this.history.push({ epoch: this.epoch, action: 'join', node: id });
    return { epoch: this.epoch, idempotent: false, members: this.activeIds() };
  }

  leave(id) {
    const m = this.members.get(id);
    if (!m || m.status !== 'active') {
      throw new ReplicaError(NOT_MEMBER, `${id} is not an active member`);
    }
    this.epoch += 1;
    m.status = 'tombstone';
    m.leftEpoch = this.epoch;
    this.history.push({ epoch: this.epoch, action: 'leave', node: id });
    return { epoch: this.epoch, members: this.activeIds() };
  }

  requireActive(id) {
    const m = this.members.get(id);
    if (!m || m.status !== 'active') {
      throw new ReplicaError(NOT_MEMBER, `${id} is not an active member`);
    }
  }

  requireEpoch(epoch) {
    if (epoch !== this.epoch) {
      throw new ReplicaError(EPOCH_MISMATCH, `command epoch ${epoch}, current epoch ${this.epoch}`);
    }
  }

  reachableActive(from) {
    return this.activeIds().filter((id) => this.isConnected(from, id));
  }

  // Causal delivery per origin: entries apply only in contiguous seq order.
  // Out-of-order arrivals wait in `pending` until repair fills the gap,
  // so a node's vector always means "contiguously holds up to".
  applyEntry(st, entry) {
    const cur = st.vector.get(entry.origin) ?? 0;
    if (entry.seq <= cur) return false;
    if (entry.seq > cur + 1) {
      if (!st.pending.some((e) => e.origin === entry.origin && e.seq === entry.seq)) {
        st.pending.push({ ...entry, vector: { ...entry.vector } });
      }
      return false;
    }
    st.log.push({ ...entry, vector: { ...entry.vector } });
    st.vector.set(entry.origin, entry.seq);
    // Drain any buffered successors for this origin.
    for (;;) {
      const next = st.vector.get(entry.origin) + 1;
      const idx = st.pending.findIndex(
        (e) => e.origin === entry.origin && e.seq === next
      );
      if (idx < 0) break;
      const [e] = st.pending.splice(idx, 1);
      st.log.push(e);
      st.vector.set(e.origin, e.seq);
    }
    return true;
  }

  write({ node, key, value, epoch }) {
    this.requireActive(node);
    this.requireEpoch(epoch);
    // Confirm quorum reachability before applying anything: a failed write
    // leaves no trace, so uncommitted values can never become visible later.
    const signers = this.reachableActive(node);
    const need = this.quorum();
    if (signers.length < need) {
      throw new ReplicaError(QUORUM_FAIL, `acks ${signers.length} < quorum ${need}`);
    }
    const st = this.nodeState(node);
    st.seq += 1;
    const vector = Object.fromEntries(st.vector);
    vector[node] = st.seq;
    const entry = { origin: node, seq: st.seq, key, value, epoch, vector };
    for (const id of signers) this.applyEntry(this.nodeState(id), entry);
    return { epoch: this.epoch, signers, acks: signers.length, quorum: need, vector };
  }

  read({ node, key, epoch }) {
    this.requireActive(node);
    this.requireEpoch(epoch);
    const signers = this.reachableActive(node);
    const need = this.quorum();
    if (signers.length < need) {
      throw new ReplicaError(QUORUM_FAIL, `signers ${signers.length} < quorum ${need}`);
    }
    const merged = {};
    const seen = new Set();
    const entries = [];
    for (const id of signers) {
      const st = this.nodeState(id);
      for (const [o, c] of st.vector) merged[o] = Math.max(merged[o] ?? 0, c);
      for (const e of st.log) {
        if (e.key !== key) continue;
        const dedup = `${e.origin}:${e.seq}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        entries.push(e);
      }
    }
    const value = visibleValue(entries);
    return {
      epoch: this.epoch,
      key,
      value: value === undefined ? null : value,
      found: value !== undefined,
      certificate: { epoch: this.epoch, signers, vector: merged },
    };
  }

  // Anti-entropy: push per-origin seq gaps to connected peers until fixpoint.
  // Only appends missing entries; never reorders or rewrites confirmed history.
  repair() {
    let transferred = 0;
    let rounds = 0;
    let changed = true;
    while (changed && rounds < 1000) {
      changed = false;
      rounds += 1;
      for (const a of this.activeIds()) {
        for (const b of this.activeIds()) {
          if (a === b || !this.isConnected(a, b)) continue;
          const sa = this.nodeState(a);
          const sb = this.nodeState(b);
          const missing = sa.log
            .filter((e) => e.seq > (sb.vector.get(e.origin) ?? 0))
            .sort(compareEntries);
          for (const e of missing) {
            this.applyEntry(sb, e);
            transferred += 1;
            changed = true;
          }
        }
      }
    }
    return { transferred, rounds };
  }

  status() {
    return {
      epoch: this.epoch,
      quorum: this.quorum(),
      members: [...this.members.values()].map((m) => ({ ...m })),
      vectors: Object.fromEntries(
        [...this.nodes.values()].map((n) => [n.id, Object.fromEntries(n.vector)])
      ),
      history: this.history.map((h) => ({ ...h })),
    };
  }
}
