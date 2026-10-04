'use strict';

const { maxFlow } = require('./maxflow');

class CreditNetworkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isNonNegativeInteger(x) {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

function isPositiveInteger(x) {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}

class CreditNetwork {
  constructor() {
    this.capacity = new Map(); // from -> Map(to -> capacity)
    this.occupied = new Map(); // from -> Map(to -> frozen amount)
    this.freezes = new Map(); // id -> { source, target, amount, released, flows }
    this.nextId = 1;
  }

  _edge(map, from, to) {
    const row = map.get(from);
    return row ? row.get(to) : undefined;
  }

  _setEdge(map, from, to, value) {
    if (!map.has(from)) map.set(from, new Map());
    map.get(from).set(to, value);
  }

  _getEdge(map, from, to) {
    return this._edge(map, from, to) || 0;
  }

  nodes() {
    const set = new Set();
    for (const [u, row] of this.capacity) {
      set.add(u);
      for (const v of row.keys()) set.add(v);
    }
    return [...set];
  }

  addEdge(from, to, capacity) {
    if (typeof from !== 'string' || typeof to !== 'string' || from === to) {
      throw new CreditNetworkError('INVALID_EDGE', 'edge endpoints must be distinct strings');
    }
    if (!isNonNegativeInteger(capacity)) {
      throw new CreditNetworkError('INVALID_CAPACITY', 'capacity must be a non-negative integer');
    }
    if (this._edge(this.capacity, from, to) !== undefined) {
      throw new CreditNetworkError('EDGE_EXISTS', `edge ${from}->${to} already exists; use set-capacity`);
    }
    this._setEdge(this.capacity, from, to, capacity);
    this._setEdge(this.occupied, from, to, 0);
    return { ok: true, from, to, capacity };
  }

  setCapacity(from, to, capacity) {
    const current = this._edge(this.capacity, from, to);
    if (current === undefined) {
      throw new CreditNetworkError('UNKNOWN_EDGE', `edge ${from}->${to} does not exist`);
    }
    if (!isNonNegativeInteger(capacity)) {
      throw new CreditNetworkError('INVALID_CAPACITY', 'capacity must be a non-negative integer');
    }
    const used = this._getEdge(this.occupied, from, to);
    if (capacity < used) {
      throw new CreditNetworkError(
        'CAPACITY_BELOW_FROZEN',
        `capacity ${capacity} is below frozen amount ${used} on ${from}->${to}`
      );
    }
    this._setEdge(this.capacity, from, to, capacity);
    return { ok: true, from, to, capacity };
  }

  _residual() {
    const residual = new Map();
    for (const [u, row] of this.capacity) {
      const out = new Map();
      for (const [v, c] of row) {
        out.set(v, c - this._getEdge(this.occupied, u, v));
      }
      residual.set(u, out);
    }
    return residual;
  }

  // Max additional amount freezable from source to target right now.
  maxFreezable(source, target) {
    return maxFlow(this._residual(), source, target).value;
  }

  freeze({ source, target, amount, id }) {
    if (typeof source !== 'string' || typeof target !== 'string') {
      throw new CreditNetworkError('INVALID_ENDPOINT', 'source and target must be strings');
    }
    if (!this.nodes().includes(source)) {
      throw new CreditNetworkError('UNKNOWN_SOURCE', `unknown source account: ${source}`);
    }
    if (!this.nodes().includes(target)) {
      throw new CreditNetworkError('UNKNOWN_TARGET', `unknown target account: ${target}`);
    }
    if (!isPositiveInteger(amount)) {
      throw new CreditNetworkError('INVALID_AMOUNT', 'amount must be a positive integer');
    }
    if (id !== undefined && (typeof id !== 'string' || id === '')) {
      throw new CreditNetworkError('INVALID_ID', 'freeze id must be a non-empty string');
    }
    if (id !== undefined && this.freezes.has(id)) {
      throw new CreditNetworkError('DUPLICATE_FREEZE_ID', `freeze id already in use: ${id}`);
    }

    const residual = this._residual();
    const { value, flow, reachable } = maxFlow(residual, source, target);

    if (value < amount) {
      const all = this.nodes();
      const cutEdges = [];
      let cutCapacity = 0;
      for (const u of reachable) {
        const row = residual.get(u);
        if (!row) continue;
        for (const [v, c] of row) {
          if (!reachable.has(v) && c > 0) {
            cutEdges.push({ from: u, to: v, capacity: c });
            cutCapacity += c;
          }
        }
      }
      cutEdges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
      return {
        ok: false,
        error: {
          code: 'INSUFFICIENT_CAPACITY',
          message: `cannot freeze ${amount}; maximum freezable is ${value}`,
        },
        maxFreezable: value,
        cut: {
          capacity: cutCapacity,
          sourceSide: [...reachable].sort(),
          customerSide: all.filter((n) => !reachable.has(n)).sort(),
          edges: cutEdges,
        },
      };
    }

    // Extract exactly `amount` units of s-t path flow (cycle-free) and occupy it.
    const flows = this._extractFlow(flow, source, target, amount);

    for (const [u, row] of flows) {
      for (const [v, f] of row) {
        if (f > 0) {
          this._setEdge(this.occupied, u, v, this._getEdge(this.occupied, u, v) + f);
        }
      }
    }

    const freezeId = id !== undefined ? id : `freeze-${this.nextId++}`;
    this.freezes.set(freezeId, { source, target, amount, released: 0, flows });

    const flowList = [];
    for (const [u, row] of flows) {
      for (const [v, f] of row) {
        if (f > 0) flowList.push({ from: u, to: v, amount: f });
      }
    }
    flowList.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
    return { ok: true, id: freezeId, source, target, amount, flows: flowList };
  }

  // Remove `x` units of s-t flow from `flows` (path-by-path, in place) and
  // return a new flow map holding exactly the extracted flow.
  _extractFlow(flows, source, target, x) {
    const extracted = new Map();
    const addFlow = (u, v, f) => {
      if (!extracted.has(u)) extracted.set(u, new Map());
      extracted.get(u).set(v, (extracted.get(u).get(v) || 0) + f);
    };
    let remaining = x;
    while (remaining > 0) {
      const prev = new Map([[source, null]]);
      const stack = [source];
      while (stack.length && !prev.has(target)) {
        const u = stack.pop();
        for (const [v, f] of flows.get(u) || []) {
          if (f > 0 && !prev.has(v)) {
            prev.set(v, u);
            stack.push(v);
          }
        }
      }
      if (!prev.has(target)) {
        throw new CreditNetworkError('FLOW_INCONSISTENT', 'internal flow decomposition error');
      }
      let bottleneck = Infinity;
      for (let v = target; v !== source; v = prev.get(v)) {
        bottleneck = Math.min(bottleneck, flows.get(prev.get(v)).get(v));
      }
      bottleneck = Math.min(bottleneck, remaining);
      for (let v = target; v !== source; v = prev.get(v)) {
        const u = prev.get(v);
        flows.get(u).set(v, flows.get(u).get(v) - bottleneck);
        addFlow(u, v, bottleneck);
      }
      remaining -= bottleneck;
    }
    return extracted;
  }

  release({ id, amount }) {
    if (typeof id !== 'string' || !this.freezes.has(id)) {
      throw new CreditNetworkError('UNKNOWN_FREEZE', `unknown freeze id: ${id}`);
    }
    const record = this.freezes.get(id);
    const remainingAmount = record.amount - record.released;
    if (remainingAmount <= 0) {
      throw new CreditNetworkError('ALREADY_RELEASED', `freeze ${id} is fully released`);
    }
    const releaseAmount = amount === undefined ? remainingAmount : amount;
    if (!isPositiveInteger(releaseAmount)) {
      throw new CreditNetworkError('INVALID_AMOUNT', 'release amount must be a positive integer');
    }
    if (releaseAmount > remainingAmount) {
      throw new CreditNetworkError(
        'OVER_RELEASE',
        `cannot release ${releaseAmount}; only ${remainingAmount} remains on freeze ${id}`
      );
    }

    // Extract exactly `releaseAmount` units of s-t flow from the record and
    // free that capacity on the affected edges.
    const releasedFlow = this._extractFlow(
      record.flows,
      record.source,
      record.target,
      releaseAmount
    );
    for (const [u, row] of releasedFlow) {
      for (const [v, f] of row) {
        if (f > 0) {
          this._setEdge(this.occupied, u, v, this._getEdge(this.occupied, u, v) - f);
        }
      }
    }
    record.released += releaseAmount;
    return {
      ok: true,
      id,
      released: releaseAmount,
      totalReleased: record.released,
      remaining: record.amount - record.released,
    };
  }

  execute(command) {
    if (command === null || typeof command !== 'object' || Array.isArray(command)) {
      throw new CreditNetworkError('INVALID_COMMAND', 'command must be a JSON object');
    }
    switch (command.cmd) {
      case 'add-edge':
        return this.addEdge(command.from, command.to, command.capacity);
      case 'set-capacity':
        return this.setCapacity(command.from, command.to, command.capacity);
      case 'freeze':
        return this.freeze(command);
      case 'release':
        return this.release(command);
      default:
        throw new CreditNetworkError(
          'UNKNOWN_COMMAND',
          `unknown command: ${JSON.stringify(command.cmd)}`
        );
    }
  }
}

module.exports = { CreditNetwork, CreditNetworkError };
