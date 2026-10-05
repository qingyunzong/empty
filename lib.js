import { createHash } from 'node:crypto';

export const EXIT_DOMAIN_ERROR = 11;

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.exitCode = EXIT_DOMAIN_ERROR;
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const edgeKey = (from, to) => `${from}\u0001${to}`;

/**
 * RecallGraph: event DAG compiled to a forward automaton (adjacency) with
 * reverse links maintained synchronously. The affected cone of bad nodes is
 * maintained incrementally via support counts:
 *   affected(n)  <=>  bad(n) OR support(n) > 0
 *   support(n)   =    number of in-edges from currently affected parents
 * Insert/delete of an edge only diffuses through the impacted cone.
 */
export class RecallGraph {
  constructor() {
    this.nodes = new Set();
    this.adj = new Map(); // from -> Set(to)        (forward automaton)
    this.rev = new Map(); // to   -> Set(from)      (reverse traversal)
    this.edgeVer = new Map(); // edgeKey -> current version
    this.verFloor = new Map(); // edgeKey -> highest version ever seen (survives delete)
    this.bad = new Set();
    this.support = new Map(); // node -> number of affected parents
    this.affected = new Set();
  }

  _ensureNode(node) {
    if (!this.nodes.has(node)) {
      this.nodes.add(node);
      this.adj.set(node, new Set());
      this.rev.set(node, new Set());
    }
  }

  hasEdge(from, to) {
    return this.edgeVer.has(edgeKey(from, to));
  }

  reachable(src, dst) {
    if (src === dst) return true;
    const seen = new Set([src]);
    const stack = [src];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const next of this.adj.get(cur) ?? []) {
        if (next === dst) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  /** One more affected-parent in-edge for `node`; cascade activations. */
  _raise(node) {
    const stack = [node];
    while (stack.length > 0) {
      const cur = stack.pop();
      const count = (this.support.get(cur) ?? 0) + 1;
      this.support.set(cur, count);
      if (count === 1 && !this.affected.has(cur)) {
        this.affected.add(cur);
        for (const child of this.adj.get(cur)) stack.push(child);
      }
    }
  }

  /** One fewer affected-parent in-edge for `node`; cascade deactivations. */
  _lower(node) {
    const stack = [node];
    while (stack.length > 0) {
      const cur = stack.pop();
      const count = (this.support.get(cur) ?? 0) - 1;
      if (count < 0) throw new Error(`support underflow at ${cur}`);
      this.support.set(cur, count);
      if (count === 0 && !this.bad.has(cur) && this.affected.has(cur)) {
        this.affected.delete(cur);
        for (const child of this.adj.get(cur)) stack.push(child);
      }
    }
  }

  addEdge(from, to, ver) {
    if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') {
      throw new DomainError('BAD_INPUT', `edge endpoints must be non-empty strings`);
    }
    if (!Number.isInteger(ver) || ver < 0) {
      throw new DomainError('BAD_INPUT', `edge version must be a non-negative integer`);
    }
    const key = edgeKey(from, to);
    const floor = this.verFloor.get(key);
    if (floor !== undefined && ver < floor) {
      throw new DomainError(
        'VERSION_REGRESSION',
        `edge ${from}->${to} version ${ver} regresses below ${floor}`,
      );
    }
    if (this.hasEdge(from, to)) {
      // Re-insertion only bumps the version; structure and cone are unchanged.
      this.edgeVer.set(key, ver);
      this.verFloor.set(key, ver);
      return;
    }
    if (from === to || this.reachable(to, from)) {
      throw new DomainError('CYCLE', `edge ${from}->${to} would close a cycle`);
    }
    this._ensureNode(from);
    this._ensureNode(to);
    this.adj.get(from).add(to);
    this.rev.get(to).add(from);
    this.edgeVer.set(key, ver);
    this.verFloor.set(key, ver);
    if (this.affected.has(from)) this._raise(to);
  }

  delEdge(from, to) {
    const key = edgeKey(from, to);
    if (!this.hasEdge(from, to)) {
      throw new DomainError('EDGE_NOT_FOUND', `delEdge on missing edge ${from}->${to}`);
    }
    this.adj.get(from).delete(to);
    this.rev.get(to).delete(from);
    this.edgeVer.delete(key);
    if (this.affected.has(from)) this._lower(to);
  }

  markBad(node) {
    this._ensureNode(node);
    if (this.bad.has(node)) return;
    this.bad.add(node);
    if (!this.affected.has(node)) {
      this.affected.add(node);
      for (const child of this.adj.get(node)) this._raise(child);
    }
  }

  affectedList() {
    return [...this.affected].sort();
  }

  get coneSize() {
    return this.affected.size;
  }

  stateHash() {
    const edges = [...this.edgeVer.entries()]
      .map(([key, ver]) => {
        const [from, to] = key.split('\u0001');
        return [from, to, ver];
      })
      .sort()
      .map(([from, to, ver]) => `${from}->${to}@${ver}`);
    const bad = [...this.bad].sort();
    return sha256(JSON.stringify({ edges, bad }));
  }

  queryHash(node) {
    return sha256(`query\n${node}\n${this.stateHash()}`);
  }

  /** Shortest evidence path from any bad node to `node` (deterministic). */
  evidencePath(node) {
    if (this.bad.has(node)) return [node];
    const prev = new Map();
    const queue = [...this.bad].sort();
    const seen = new Set(queue);
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const next of [...this.adj.get(cur)].sort()) {
        if (seen.has(next)) continue;
        seen.add(next);
        prev.set(next, cur);
        if (next === node) {
          const path = [node];
          let walk = cur;
          while (walk !== undefined) {
            path.unshift(walk);
            walk = prev.get(walk);
          }
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  }

  query(node) {
    if (!this.nodes.has(node)) {
      throw new DomainError('UNKNOWN_NODE', `query on unknown node ${node}`);
    }
    let cert = null;
    if (this.affected.has(node)) {
      const path = this.evidencePath(node);
      const edges = [];
      for (let i = 0; i + 1 < path.length; i += 1) {
        edges.push({
          from: path[i],
          to: path[i + 1],
          ver: this.edgeVer.get(edgeKey(path[i], path[i + 1])),
        });
      }
      cert = {
        node,
        path,
        edges,
        stateHash: this.stateHash(),
        queryHash: this.queryHash(node),
      };
    }
    return {
      type: 'result',
      query: node,
      affected: this.affectedList(),
      coneSize: this.coneSize,
      cert,
    };
  }
}

/** Apply one JSONL event to a graph. Returns the query result or null. */
export function applyEvent(graph, event) {
  if (event.edge !== undefined) {
    const { from, to, ver } = event.edge ?? {};
    graph.addEdge(from, to, ver);
    return null;
  }
  if (event.delEdge !== undefined) {
    const { from, to } = event.delEdge ?? {};
    graph.delEdge(from, to);
    return null;
  }
  if (event.markBad !== undefined) {
    const node = typeof event.markBad === 'string' ? event.markBad : event.markBad?.node;
    graph.markBad(node);
    return null;
  }
  if (event.query !== undefined) {
    const node = typeof event.query === 'string' ? event.query : event.query?.node;
    return graph.query(node);
  }
  throw new DomainError('BAD_INPUT', `unrecognized event: ${JSON.stringify(event)}`);
}

/** Verify a certificate by replaying the event log offline. */
export function verifyCertificate(events, cert) {
  if (!cert || typeof cert.node !== 'string' || !Array.isArray(cert.path)) return false;
  const graph = new RecallGraph();
  for (const event of events) {
    const isQuery = event.query !== undefined;
    const node = isQuery
      ? (typeof event.query === 'string' ? event.query : event.query?.node)
      : null;
    if (isQuery && node === cert.node && graph.stateHash() === cert.stateHash) {
      return checkCertificate(graph, cert);
    }
    if (!isQuery) applyEvent(graph, event);
  }
  // The certificate may anchor to the state at the end of the log.
  return graph.stateHash() === cert.stateHash && checkCertificate(graph, cert);
}

function checkCertificate(graph, cert) {
  if (cert.queryHash !== graph.queryHash(cert.node)) return false;
  const { path } = cert;
  if (path.length === 0 || path[path.length - 1] !== cert.node) return false;
  if (!graph.bad.has(path[0])) return false;
  if (!Array.isArray(cert.edges) || cert.edges.length !== path.length - 1) return false;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const rec = cert.edges[i];
    if (!rec || rec.from !== path[i] || rec.to !== path[i + 1]) return false;
    if (graph.edgeVer.get(edgeKey(path[i], path[i + 1])) !== rec.ver) return false;
  }
  return graph.affected.has(cert.node);
}
