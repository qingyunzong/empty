import { createHash } from 'node:crypto';
import { kosaraju, condensation, bfsPath } from './graph.js';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const edgeKey = (from, to) => `${from}#${to}`;

function validateNodeId(id, name) {
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new LedgerError('invalid-id', `${name} must be an integer, got ${JSON.stringify(id)}`);
  }
  if (id < 0) {
    throw new LedgerError('negative-id', `${name} must be non-negative, got ${id}`);
  }
}

export class LedgerNetwork {
  #edges = new Map();
  #snapshots = new Map();
  #nextSnapshotId = 1;

  addEdge(from, to) {
    validateNodeId(from, 'from');
    validateNodeId(to, 'to');
    if (this.#edges.has(edgeKey(from, to))) {
      throw new LedgerError('duplicate-edge', `edge ${from} -> ${to} already exists`);
    }
    this.#edges.set(edgeKey(from, to), [from, to]);
    return { ok: true };
  }

  removeEdge(from, to) {
    validateNodeId(from, 'from');
    validateNodeId(to, 'to');
    if (!this.#edges.has(edgeKey(from, to))) {
      throw new LedgerError('missing-edge', `edge ${from} -> ${to} does not exist`);
    }
    this.#edges.delete(edgeKey(from, to));
    return { ok: true };
  }

  correctDirection(from, to) {
    validateNodeId(from, 'from');
    validateNodeId(to, 'to');
    if (!this.#edges.has(edgeKey(from, to))) {
      throw new LedgerError(
        'missing-edge',
        `cannot correct direction: edge ${from} -> ${to} does not exist`,
      );
    }
    if (from !== to && this.#edges.has(edgeKey(to, from))) {
      throw new LedgerError('duplicate-edge', `reversed edge ${to} -> ${from} already exists`);
    }
    this.#edges.delete(edgeKey(from, to));
    this.#edges.set(edgeKey(to, from), [to, from]);
    return { ok: true };
  }

  state() {
    const edges = [...this.#edges.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const nodes = [...new Set(edges.flat())].sort((a, b) => a - b);
    return { nodes, edges };
  }

  stateHash() {
    return createHash('sha256').update(JSON.stringify(this.state())).digest('hex');
  }

  snapshot() {
    const id = this.#nextSnapshotId;
    this.#nextSnapshotId += 1;
    const edges = [...this.#edges.values()].map(([from, to]) => [from, to]);
    const hash = this.stateHash();
    this.#snapshots.set(id, { edges, hash });
    return { snapshot: id, hash };
  }

  rollback(id) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || !this.#snapshots.has(id)) {
      if (typeof id === 'number' && Number.isInteger(id) && id >= this.#nextSnapshotId) {
        throw new LedgerError(
          'future-snapshot',
          `cannot rollback to future snapshot ${id}; latest is ${this.#nextSnapshotId - 1}`,
        );
      }
      throw new LedgerError('unknown-snapshot', `unknown snapshot id ${JSON.stringify(id)}`);
    }
    const snap = this.#snapshots.get(id);
    this.#edges = new Map(snap.edges.map(([from, to]) => [edgeKey(from, to), [from, to]]));
    return { ok: true, snapshot: id, hash: this.stateHash() };
  }

  query() {
    const { nodes, edges } = this.state();
    const components = kosaraju(nodes, edges);
    const { dag, topo } = condensation(nodes, edges, components);

    const forward = new Map(nodes.map((node) => [node, []]));
    const backward = new Map(nodes.map((node) => [node, []]));
    for (const [from, to] of edges) {
      forward.get(from).push(to);
      backward.get(to).push(from);
    }
    const byNumber = (a, b) => a - b;
    for (const list of forward.values()) list.sort(byNumber);
    for (const list of backward.values()) list.sort(byNumber);

    const certificates = components.map((component) => {
      const representative = component[0];
      const proofs = {};
      for (const member of component) {
        proofs[member] = {
          fromRepresentative: bfsPath(forward, representative, member),
          toRepresentative: bfsPath(backward, representative, member).reverse(),
        };
      }
      return { representative, members: component, proofs };
    });

    return {
      components,
      topoOrder: topo.map((index) => components[index]),
      componentDag: dag,
      certificates,
    };
  }
}
