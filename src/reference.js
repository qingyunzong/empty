// Reference implementation: after every transaction it recomputes every node
// from scratch. Used to cross-check the incremental Engine in tests.
import {
  BuildError,
  applyOps,
  topoOrder,
  computeNode,
  projectionOf,
  diffProjection,
  errorsOf,
  certificatesFor,
} from './engine.js';

const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

export class ReferenceEngine {
  constructor() {
    this.nodes = new Map();
    this.status = new Map();
    this.history = [];
    this.lastTxId = null;
  }

  #fullStatus() {
    const { order } = topoOrder(this.nodes);
    const status = new Map();
    for (const { id } of order) {
      status.set(id, computeNode(id, this.nodes, (target) => status.get(target)));
    }
    return status;
  }

  transact({ id, ops } = {}) {
    if (!Array.isArray(ops) || ops.length === 0) {
      return fail('E_TX_OPS', 'transaction requires a non-empty ops array');
    }
    const txId = id ?? `tx-${this.history.length + 1}`;
    if (this.history.some((entry) => entry.txId === txId)) {
      return fail('E_TX_ID', `duplicate transaction id: ${txId}`);
    }
    let nextNodes;
    try {
      nextNodes = applyOps(this.nodes, ops);
    } catch (error) {
      if (error instanceof BuildError) return fail(error.code, error.message, error.details ?? {});
      throw error;
    }
    const { cyclic } = topoOrder(nextNodes);
    if (cyclic.length > 0) {
      return fail('E_CYCLE', `dependency cycle detected involving: ${cyclic.join(', ')}`, { nodes: cyclic });
    }
    this.history.push({ txId, nodes: structuredClone(this.nodes), status: structuredClone(this.status) });
    this.nodes = nextNodes;
    this.lastTxId = txId;
    if (this.nodes.size === 0) {
      this.status = new Map();
      return fail('E_EMPTY', 'nothing to build: the graph has no nodes');
    }
    const prevProjection = projectionOf(this.status);
    this.status = this.#fullStatus();
    const projection = projectionOf(this.status);
    return {
      ok: true,
      txId,
      diff: diffProjection(prevProjection, projection),
      errors: errorsOf(this.status),
      blocked: projection.blocked,
      hashes: projection.hashes,
      certificates: certificatesFor(this.nodes, this.status, txId),
    };
  }

  rollback(txId) {
    if (typeof txId !== 'string') return fail('E_TX_NOT_FOUND', 'rollback requires a transaction id string');
    const index = this.history.findIndex((entry) => entry.txId === txId);
    if (index === -1) return fail('E_TX_NOT_FOUND', `unknown transaction id: ${txId}`);
    const discarded = this.history.slice(index).map((entry) => entry.txId);
    const snapshot = this.history[index];
    const prevProjection = projectionOf(this.status);
    this.nodes = structuredClone(snapshot.nodes);
    this.status = structuredClone(snapshot.status);
    this.history.length = index;
    this.lastTxId = index > 0 ? this.history[index - 1].txId : null;
    const projection = projectionOf(this.status);
    return {
      ok: true,
      rolledBack: txId,
      discarded,
      diff: diffProjection(prevProjection, projection),
      hashes: projection.hashes,
      blocked: projection.blocked,
    };
  }

  state() {
    const projection = projectionOf(this.status);
    return {
      ok: true,
      hashes: projection.hashes,
      blocked: projection.blocked,
      errors: errorsOf(this.status),
      certificates: certificatesFor(this.nodes, this.status, this.lastTxId),
    };
  }
}
