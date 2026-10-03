import { createHash } from 'node:crypto';
import { kosarajuScc } from './scc.js';

export class TrustGraphError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrustGraphError';
    this.code = code;
  }
}

function assertNodeId(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TrustGraphError('INVALID_ID', `${field} must be an integer, got ${JSON.stringify(value)}`);
  }
  if (value < 0) {
    throw new TrustGraphError('NEGATIVE_ID', `${field} must be non-negative, got ${value}`);
  }
}

const edgeKey = (from, to) => `${from}->${to}`;
const parseKey = (key) => key.split('->').map(Number);

function bfsPath(start, target, adjacency, allowed) {
  if (start === target) return [start];
  const prev = new Map([[start, null]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    for (const next of adjacency.get(node) ?? []) {
      if (!allowed.has(next) || prev.has(next)) continue;
      prev.set(next, node);
      if (next === target) {
        const path = [target];
        let cursor = node;
        while (cursor !== null) {
          path.push(cursor);
          cursor = prev.get(cursor);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

export class TrustGraph {
  #edges = new Set();
  #events = [];
  #snapshots = new Map();
  #nextSnapshotId = 1;

  addEdge(from, to) {
    assertNodeId(from, 'from');
    assertNodeId(to, 'to');
    const key = edgeKey(from, to);
    if (this.#edges.has(key)) {
      throw new TrustGraphError('DUPLICATE_EDGE', `edge ${key} already exists`);
    }
    this.#edges.add(key);
    this.#events.push({ type: 'add-edge', from, to });
    return this.stateHash();
  }

  removeEdge(from, to) {
    assertNodeId(from, 'from');
    assertNodeId(to, 'to');
    const key = edgeKey(from, to);
    if (!this.#edges.has(key)) {
      throw new TrustGraphError('EDGE_NOT_FOUND', `edge ${key} does not exist`);
    }
    this.#edges.delete(key);
    this.#events.push({ type: 'remove-edge', from, to });
    return this.stateHash();
  }

  correctDirection(from, to) {
    assertNodeId(from, 'from');
    assertNodeId(to, 'to');
    const key = edgeKey(from, to);
    if (!this.#edges.has(key)) {
      throw new TrustGraphError('EDGE_NOT_FOUND', `edge ${key} does not exist`);
    }
    const reversed = edgeKey(to, from);
    if (this.#edges.has(reversed)) {
      throw new TrustGraphError('DUPLICATE_EDGE', `reversed edge ${reversed} already exists`);
    }
    this.#edges.delete(key);
    this.#edges.add(reversed);
    this.#events.push({ type: 'correct-direction', from, to });
    return this.stateHash();
  }

  snapshot() {
    const snapshotId = this.#nextSnapshotId;
    this.#nextSnapshotId += 1;
    const hash = this.stateHash();
    this.#snapshots.set(snapshotId, { eventLength: this.#events.length, hash });
    return { snapshotId, hash };
  }

  rollback(snapshotId) {
    assertNodeId(snapshotId, 'snapshot');
    if (snapshotId >= this.#nextSnapshotId) {
      throw new TrustGraphError('FUTURE_SNAPSHOT', `snapshot ${snapshotId} has not been issued yet`);
    }
    const record = this.#snapshots.get(snapshotId);
    if (!record) {
      throw new TrustGraphError('UNKNOWN_SNAPSHOT', `snapshot ${snapshotId} is unknown or was invalidated`);
    }
    // Truncate-only: events discarded by an earlier rollback can never be
    // resurrected, because a snapshot only ever replays the surviving prefix.
    this.#events.length = record.eventLength;
    for (const id of [...this.#snapshots.keys()]) {
      if (id > snapshotId) this.#snapshots.delete(id);
    }
    this.#rebuild();
    const hash = this.stateHash();
    if (hash !== record.hash) {
      throw new TrustGraphError('SNAPSHOT_CORRUPT', `snapshot ${snapshotId} hash mismatch after replay`);
    }
    return { snapshotId, hash };
  }

  #rebuild() {
    const events = [...this.#events];
    this.#edges = new Set();
    this.#events = [];
    for (const event of events) {
      if (event.type === 'add-edge') this.addEdge(event.from, event.to);
      else if (event.type === 'remove-edge') this.removeEdge(event.from, event.to);
      else if (event.type === 'correct-direction') this.correctDirection(event.from, event.to);
    }
  }

  nodes() {
    const set = new Set();
    for (const key of this.#edges) {
      const [from, to] = parseKey(key);
      set.add(from);
      set.add(to);
    }
    return [...set].sort((a, b) => a - b);
  }

  edges() {
    return [...this.#edges].map(parseKey).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  stateHash() {
    const canonical = JSON.stringify({ nodes: this.nodes(), edges: this.edges() });
    return createHash('sha256').update(canonical).digest('hex');
  }

  query() {
    const nodes = this.nodes();
    const edges = this.edges();
    const components = kosarajuScc(nodes, edges);
    components.sort((a, b) => a[0] - b[0]);

    const sccOf = new Map();
    components.forEach((members, id) => {
      for (const member of members) sccOf.set(member, id);
    });

    const dag = components.map(() => new Set());
    const indegree = components.map(() => 0);
    for (const [from, to] of edges) {
      const a = sccOf.get(from);
      const b = sccOf.get(to);
      if (a !== b && !dag[a].has(b)) {
        dag[a].add(b);
        indegree[b] += 1;
      }
    }

    // Kahn's algorithm; ties broken by smallest representative (min member).
    const ready = [];
    indegree.forEach((deg, id) => {
      if (deg === 0) ready.push(id);
    });
    ready.sort((a, b) => components[a][0] - components[b][0]);
    const topologicalOrder = [];
    while (ready.length > 0) {
      const id = ready.shift();
      topologicalOrder.push(id);
      for (const next of [...dag[id]].sort((a, b) => components[a][0] - components[b][0])) {
        indegree[next] -= 1;
        if (indegree[next] === 0) {
          let pos = ready.findIndex((x) => components[x][0] > components[next][0]);
          if (pos === -1) pos = ready.length;
          ready.splice(pos, 0, next);
        }
      }
    }

    const adjacency = new Map(nodes.map((node) => [node, []]));
    for (const [from, to] of edges) adjacency.get(from).push(to);
    for (const list of adjacency.values()) list.sort((a, b) => a - b);

    const sccs = components.map((members, id) => ({
      id,
      representative: members[0],
      members,
    }));
    const certificates = components.map((members, id) =>
      buildCertificate(id, members, adjacency),
    );

    return { sccs, topologicalOrder, certificates };
  }
}

function buildCertificate(sccId, members, adjacency) {
  const representative = members[0];
  const allowed = new Set(members);
  const forward = {};
  const backward = {};
  for (const member of members) {
    if (member === representative) continue;
    forward[String(member)] = bfsPath(representative, member, adjacency, allowed);
    backward[String(member)] = bfsPath(member, representative, adjacency, allowed);
  }
  const digest = createHash('sha256').update(JSON.stringify(members)).digest('hex');
  return { sccId, representative, members, forward, backward, digest };
}

export function verifySccCertificate(edges, certificate) {
  const edgeSet = new Set(edges.map(([from, to]) => edgeKey(from, to)));
  const { representative, members, forward, backward, digest } = certificate;
  if (!Array.isArray(members) || members.length === 0) return false;
  const sorted = [...members].sort((a, b) => a - b);
  if (JSON.stringify(sorted) !== JSON.stringify(members)) return false;
  if (new Set(members).size !== members.length) return false;
  if (representative !== members[0]) return false;
  const expectedDigest = createHash('sha256').update(JSON.stringify(members)).digest('hex');
  if (digest !== expectedDigest) return false;
  const allowed = new Set(members);
  const checkPath = (path, from, to) => {
    if (!Array.isArray(path) || path.length === 0) return false;
    if (path[0] !== from || path[path.length - 1] !== to) return false;
    for (let i = 0; i < path.length; i += 1) {
      if (!allowed.has(path[i])) return false;
      if (i > 0 && !edgeSet.has(edgeKey(path[i - 1], path[i]))) return false;
    }
    return true;
  };
  for (const member of members) {
    if (member === representative) continue;
    if (!checkPath(forward[String(member)], representative, member)) return false;
    if (!checkPath(backward[String(member)], member, representative)) return false;
  }
  return true;
}
