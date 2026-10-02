import { err, E_CYCLE, E_SOURCE_GONE, E_DUP, E_INPUT } from './errors.js';

export const VALID = 'valid';
export const DEGRADED = 'degraded';
export const UNKNOWN = 'unknown';
export const REMOVED = 'removed';

const EVENT_TYPES = new Set(['add_fact', 'add_rule', 'remove_fact', 'revoke_source', 'restore_source']);

export class EvidenceGraph {
  constructor() {
    this.facts = new Map();    // id -> { id, source, value, data, removed }
    this.rules = new Map();    // id -> { id, op, premises, threshold }
    this.sources = new Map();  // id -> { id, revoked }
  }

  static eventTypes() {
    return [...EVENT_TYPES];
  }

  toState() {
    return {
      facts: [...this.facts.values()].map((f) => ({ ...f })),
      rules: [...this.rules.values()].map((r) => ({ ...r, premises: [...r.premises] })),
      sources: [...this.sources.values()].map((s) => ({ ...s })),
    };
  }

  static fromState(state) {
    const g = new EvidenceGraph();
    for (const f of state.facts || []) g.facts.set(f.id, { ...f });
    for (const r of state.rules || []) g.rules.set(r.id, { ...r, premises: [...r.premises] });
    for (const s of state.sources || []) g.sources.set(s.id, { ...s });
    return g;
  }

  has(id) {
    return this.facts.has(id) || this.rules.has(id);
  }

  // Pure validation, no mutation. Throws EvidenceError on invalid events.
  check(event) {
    const { type, payload } = event;
    if (!EVENT_TYPES.has(type)) throw err(E_INPUT, `unknown event type: ${type}`);
    switch (type) {
      case 'add_fact': {
        const { id, source, value } = payload;
        requireId(id, 'fact');
        requireId(source, 'source');
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
          throw err(E_INPUT, `fact ${id}: value must be a finite number`);
        }
        if (this.has(id)) throw err(E_DUP, `node ${id} already exists`);
        break;
      }
      case 'add_rule': {
        const { id, op, premises, threshold } = payload;
        requireId(id, 'rule');
        if (op !== 'count' && op !== 'sum') throw err(E_INPUT, `rule ${id}: op must be "count" or "sum"`);
        if (!Array.isArray(premises) || premises.some((p) => typeof p !== 'string' || p.length === 0)) {
          throw err(E_INPUT, `rule ${id}: premises must be an array of node ids`);
        }
        if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold))) {
          throw err(E_INPUT, `rule ${id}: threshold must be a finite number`);
        }
        if (this.has(id)) throw err(E_DUP, `node ${id} already exists`);
        const unique = [...new Set(premises)];
        for (const p of unique) {
          if (this.dependsOn(p, id)) {
            throw err(E_CYCLE, `rule ${id} would create a dependency cycle via premise ${p}`);
          }
        }
        break;
      }
      case 'remove_fact': {
        requireId(payload.id, 'fact');
        const fact = this.facts.get(payload.id);
        if (!fact || fact.removed) throw err(E_SOURCE_GONE, `fact ${payload.id} not found`);
        break;
      }
      case 'revoke_source':
      case 'restore_source': {
        requireId(payload.source, 'source');
        if (!this.sources.has(payload.source)) {
          throw err(E_SOURCE_GONE, `source ${payload.source} not found`);
        }
        break;
      }
    }
  }

  // Does node `nodeId` transitively depend on `targetId` through rule premises?
  dependsOn(nodeId, targetId, seen = new Set()) {
    if (nodeId === targetId) return true;
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    const rule = this.rules.get(nodeId);
    if (!rule) return false;
    return rule.premises.some((p) => this.dependsOn(p, targetId, seen));
  }

  // Mutation only; call check() first. Replay-safe.
  apply(event) {
    const { type, payload } = event;
    switch (type) {
      case 'add_fact': {
        if (!this.sources.has(payload.source)) {
          this.sources.set(payload.source, { id: payload.source, revoked: false });
        }
        this.facts.set(payload.id, {
          id: payload.id,
          source: payload.source,
          value: payload.value === undefined ? 1 : payload.value,
          data: payload.data === undefined ? null : payload.data,
          removed: false,
        });
        break;
      }
      case 'add_rule': {
        const premises = [...new Set(payload.premises)];
        const threshold = payload.threshold === undefined
          ? (payload.op === 'count' ? premises.length : 1)
          : payload.threshold;
        this.rules.set(payload.id, { id: payload.id, op: payload.op, premises, threshold });
        break;
      }
      case 'remove_fact': {
        this.facts.get(payload.id).removed = true;
        break;
      }
      case 'revoke_source': {
        this.sources.get(payload.source).revoked = true;
        break;
      }
      case 'restore_source': {
        this.sources.get(payload.source).revoked = false;
        break;
      }
    }
  }

  // Three-valued evaluation. `unknown` is undecided, never unsatisfiable.
  evaluate(id, memo = new Map(), stack = new Set()) {
    if (memo.has(id)) return memo.get(id);
    let result;
    const fact = this.facts.get(id);
    if (fact) {
      if (fact.removed) {
        result = { id, kind: 'fact', state: REMOVED, support: 0 };
      } else {
        const source = this.sources.get(fact.source);
        const revoked = !source || source.revoked;
        result = { id, kind: 'fact', state: revoked ? DEGRADED : VALID, support: revoked ? 0 : fact.value };
      }
    } else {
      const rule = this.rules.get(id);
      if (!rule) {
        result = { id, kind: 'missing', state: UNKNOWN, support: 0 };
      } else {
        if (stack.has(id)) throw err(E_CYCLE, `dependency cycle detected at rule ${id}`);
        stack.add(id);
        const premises = rule.premises.map((p) => this.evaluate(p, memo, stack));
        stack.delete(id);
        const validPremises = premises.filter((p) => p.state === VALID);
        const support = rule.op === 'count'
          ? validPremises.length
          : validPremises.reduce((acc, p) => acc + p.support, 0);
        let state;
        if (support >= rule.threshold) state = VALID;
        else if (premises.some((p) => p.state === UNKNOWN)) state = UNKNOWN;
        else state = DEGRADED;
        result = { id, kind: 'rule', state, support, op: rule.op, threshold: rule.threshold };
      }
    }
    memo.set(id, result);
    return result;
  }

  status(id) {
    if (!this.has(id)) throw err(E_SOURCE_GONE, `node ${id} not found`);
    return this.evaluate(id);
  }

  // Materialized view of every node; used for the persisted index and tests.
  materialize() {
    const memo = new Map();
    const out = {};
    for (const id of [...this.facts.keys(), ...this.rules.keys()].sort()) {
      const r = this.evaluate(id, memo);
      out[id] = { state: r.state, support: r.support };
    }
    return out;
  }
}

function requireId(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw err(E_INPUT, `${what} id must be a non-empty string`);
  }
}
