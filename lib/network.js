'use strict';

const {
  connectedComponents,
  tarjanBridges,
  shortestPath,
} = require('./algorithms');

class NetError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'NetError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requireString(value, field, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new NetError(code, `field "${field}" must be a non-empty string`, { field });
  }
  return value;
}

class PaymentNetwork {
  constructor() {
    this.nodes = new Set();
    this.edges = new Map(); // id -> { id, a, b, bandwidth, open }
  }

  addEdge({ id, a, b, bandwidth }) {
    requireString(id, 'id');
    requireString(a, 'a');
    requireString(b, 'b');
    if (a === b) {
      throw new NetError('SELF_LOOP', `self-loop edge "${id}" on node "${a}" is not allowed`, { id, node: a });
    }
    if (this.edges.has(id)) {
      throw new NetError('DUPLICATE_EDGE', `edge "${id}" already exists`, { id });
    }
    if (typeof bandwidth !== 'number' || !Number.isFinite(bandwidth) || bandwidth <= 0) {
      throw new NetError('INVALID_BANDWIDTH', `edge "${id}" bandwidth must be a positive finite number`, { id, bandwidth });
    }
    const edge = { id, a, b, bandwidth, open: true };
    this.edges.set(id, edge);
    this.nodes.add(a);
    this.nodes.add(b);
    return { id, a, b, bandwidth, open: true };
  }

  getEdge(id) {
    requireString(id, 'id');
    const edge = this.edges.get(id);
    if (!edge) throw new NetError('UNKNOWN_EDGE', `edge "${id}" does not exist`, { id });
    return edge;
  }

  closeEdge({ id }) {
    const edge = this.getEdge(id);
    if (!edge.open) {
      throw new NetError('EDGE_ALREADY_CLOSED', `edge "${id}" is already closed`, { id });
    }
    edge.open = false;
    return {
      id,
      open: false,
      splitsGraph: this.allEdgeBridgeIds().includes(id),
      bridges: this.bridgeInfo(),
      components: this.openComponents(),
    };
  }

  openEdge({ id }) {
    const edge = this.getEdge(id);
    if (edge.open) {
      throw new NetError('EDGE_ALREADY_OPEN', `edge "${id}" is already open`, { id });
    }
    edge.open = true;
    return {
      id,
      open: true,
      bridges: this.bridgeInfo(),
      components: this.openComponents(),
    };
  }

  openEdges() {
    return [...this.edges.values()].filter((edge) => edge.open);
  }

  nodeList() {
    return [...this.nodes];
  }

  openComponents() {
    return connectedComponents(this.nodeList(), this.openEdges());
  }

  bridgeInfo() {
    const open = this.openEdges();
    const byId = new Map(open.map((edge) => [edge.id, edge]));
    return tarjanBridges(this.nodeList(), open).map((id) => {
      const edge = byId.get(id);
      return { id: edge.id, a: edge.a, b: edge.b };
    });
  }

  allEdgeBridgeIds() {
    return tarjanBridges(this.nodeList(), [...this.edges.values()]);
  }

  // Bridge certificate: all bridges of the open-edge graph, the connected
  // components, and every edge under maintenance that is a bridge of the
  // full graph (i.e. closing it split the network).
  bridgeCertificate() {
    const allBridges = new Set(this.allEdgeBridgeIds());
    const maintenanceEdges = [...this.edges.values()]
      .filter((edge) => !edge.open)
      .map((edge) => ({
        id: edge.id,
        a: edge.a,
        b: edge.b,
        splitsGraph: allBridges.has(edge.id),
      }));
    return {
      bridges: this.bridgeInfo(),
      components: this.openComponents(),
      maintenanceEdges,
    };
  }

  // Atomic batch cancellation: every payment must be routable over open
  // edges, otherwise the whole batch fails and nothing is cancelled.
  cancelBatch({ batchId, payments }) {
    requireString(batchId, 'batchId');
    if (!Array.isArray(payments) || payments.length === 0) {
      throw new NetError('EMPTY_BATCH', `batch "${batchId}" contains no payments`, { batchId });
    }
    const seen = new Set();
    for (const payment of payments) {
      if (payment === null || typeof payment !== 'object') {
        throw new NetError('INVALID_PAYMENT', 'payment must be an object', { payment });
      }
      requireString(payment.id, 'id', 'INVALID_PAYMENT');
      requireString(payment.from, 'from', 'INVALID_PAYMENT');
      requireString(payment.to, 'to', 'INVALID_PAYMENT');
      if (seen.has(payment.id)) {
        throw new NetError('DUPLICATE_PAYMENT', `duplicate payment id "${payment.id}" in batch "${batchId}"`, { batchId, id: payment.id });
      }
      seen.add(payment.id);
      for (const endpoint of [payment.from, payment.to]) {
        if (!this.nodes.has(endpoint)) {
          throw new NetError('UNKNOWN_NODE', `node "${endpoint}" does not exist`, { batchId, node: endpoint });
        }
      }
    }

    const open = this.openEdges();
    const nodes = this.nodeList();
    const results = [];
    for (const payment of payments) {
      const path = shortestPath(nodes, open, payment.from, payment.to);
      if (path === null) {
        const error = new NetError(
          'DISCONNECTED',
          `payment "${payment.id}": "${payment.from}" and "${payment.to}" are not connected through open edges`,
          { batchId, payment: payment.id, from: payment.from, to: payment.to },
        );
        error.bridgeCertificate = this.bridgeCertificate();
        throw error;
      }
      results.push({ id: payment.id, from: payment.from, to: payment.to, path });
    }

    return {
      batchId,
      cancelled: results.length,
      payments: results,
      bridges: this.bridgeInfo(),
      components: this.openComponents(),
    };
  }

  snapshot() {
    return {
      nodes: this.nodeList(),
      edges: [...this.edges.values()].map((edge) => ({ ...edge })),
    };
  }
}

module.exports = { PaymentNetwork, NetError };
