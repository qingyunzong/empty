import { DependencyGraph } from './graph.js';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const ACTIVE = 'ACTIVE';
const REVERSED = 'REVERSED';

function requireName(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_FIELD', `field "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Payment ledger with dependency-graph-driven reversal propagation.
 *
 * Edge u -> v means settlement of u depends on settlement of v.
 * Cancelling a transaction t propagates along dependency edges: every
 * transaction reachable from t enters REVERSED. Transactions inside one
 * strongly connected component mutually depend, so the whole component is
 * reversed as a group. Restore is the symmetric operation.
 */
export class Ledger {
  #graph = new DependencyGraph();
  #state = new Map(); // tx -> ACTIVE | REVERSED
  #eventIds = new Set();
  #history = [];

  #ensureNode(tx) {
    if (!this.#graph.hasNode(tx)) {
      this.#graph.addNode(tx);
      this.#state.set(tx, ACTIVE);
    }
  }

  #requireNode(tx) {
    if (!this.#graph.hasNode(tx)) {
      throw new LedgerError('UNKNOWN_TX', `unknown transaction "${tx}"`);
    }
  }

  #requireFreshEvent(event) {
    requireName(event, 'event');
    if (this.#eventIds.has(event)) {
      throw new LedgerError('DUPLICATE_EVENT', `event "${event}" already applied`);
    }
  }

  addDep(from, to) {
    requireName(from, 'from');
    requireName(to, 'to');
    this.#ensureNode(from);
    this.#ensureNode(to);
    this.#graph.addEdge(from, to);
    return { ok: true, op: 'add-dep', from, to };
  }

  removeDep(from, to) {
    requireName(from, 'from');
    requireName(to, 'to');
    if (!this.#graph.hasEdge(from, to)) {
      throw new LedgerError('EDGE_NOT_FOUND', `no dependency ${from} -> ${to}`);
    }
    this.#graph.removeEdge(from, to);
    return { ok: true, op: 'remove-dep', from, to };
  }

  cancel(tx, event) {
    requireName(tx, 'tx');
    this.#requireNode(tx);
    this.#requireFreshEvent(event);
    if (this.#state.get(tx) === REVERSED) {
      throw new LedgerError('DUPLICATE_CANCEL', `transaction "${tx}" is already REVERSED`);
    }
    const reachable = this.#graph.reachableFrom(tx);
    const affected = reachable.filter((n) => this.#state.get(n) === ACTIVE);
    for (const n of affected) this.#state.set(n, REVERSED);
    this.#eventIds.add(event);
    this.#history.push({ op: 'cancel', tx, event, affected });
    return this.#report('cancel', tx, event, affected);
  }

  restore(tx, event) {
    requireName(tx, 'tx');
    this.#requireNode(tx);
    this.#requireFreshEvent(event);
    if (this.#state.get(tx) !== REVERSED) {
      throw new LedgerError('NOT_REVERSED', `transaction "${tx}" is not REVERSED`);
    }
    const reachable = this.#graph.reachableFrom(tx);
    const affected = reachable.filter((n) => this.#state.get(n) === REVERSED);
    for (const n of affected) this.#state.set(n, ACTIVE);
    this.#eventIds.add(event);
    this.#history.push({ op: 'restore', tx, event, affected });
    return this.#report('restore', tx, event, affected);
  }

  stateOf(tx) {
    this.#requireNode(tx);
    return this.#state.get(tx);
  }

  #report(op, tx, event, affected) {
    const condensation = this.#graph.condensation();
    const certificate = this.#graph.propagationCertificate(tx, condensation.compOf);
    const scc = {};
    for (const n of affected) scc[n] = condensation.compOf.get(n);
    return {
      ok: true,
      op,
      tx,
      event,
      affected,
      scc,
      components: condensation.components,
      componentTopoOrder: condensation.topoOrder,
      condensationEdges: condensation.condensationEdges,
      certificate,
    };
  }
}
