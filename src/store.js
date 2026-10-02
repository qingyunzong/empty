import { ValidationError } from './errors.js';
import { evaluate } from './expr.js';
import { checkType, checkRange } from './schema.js';
import { vvBump } from './vvector.js';

// In-memory param store with change capture (set/lock/unlock) and validation.
export class ParamStore {
  constructor(schema, nodeId) {
    this.schema = schema;
    this.nodeId = nodeId;
    // key -> { value, locked, vv }
    this.state = new Map();
    for (const [key, def] of schema.params) {
      this.state.set(key, { value: defaultValue(def), locked: false, vv: {} });
    }
    this.deltas = []; // captured changes
    this.seq = 0;
  }

  get(key) {
    const e = this.state.get(key);
    if (!e) throw new ValidationError(`unknown param '${key}'`);
    return e.value;
  }

  isLocked(key) {
    const e = this.state.get(key);
    if (!e) throw new ValidationError(`unknown param '${key}'`);
    return e.locked;
  }

  env() {
    const out = {};
    for (const [k, e] of this.state) out[k] = e.value;
    return out;
  }

  // Validate a hypothetical full-state env against every interlock.
  validateInterlocks(env) {
    for (const [key, def] of this.schema.params) {
      if (def.ast) {
        const ok = evaluate(def.ast, env);
        if (ok !== true) {
          throw new ValidationError(`interlock violated for '${key}': ${def.interlock}`, {
            key, interlock: def.interlock, env,
          });
        }
      }
    }
  }

  validateValue(def, value) {
    checkType(def, value);
    checkRange(def, value);
  }

  capture(op, key, value, vv) {
    this.seq += 1;
    const entry = { seq: this.seq, node: this.nodeId, op, key, vv: { ...vv } };
    if (op === 'set') entry.value = value;
    this.deltas.push(entry);
    return entry;
  }

  set(key, value) {
    const def = this.schema.params.get(key);
    if (!def) throw new ValidationError(`unknown param '${key}'`);
    const entry = this.state.get(key);
    if (entry.locked) {
      throw new ValidationError(`param '${key}' is locked`, { key });
    }
    this.validateValue(def, value);
    const env = { ...this.env(), [key]: value };
    this.validateInterlocks(env);
    entry.value = value;
    entry.vv = vvBump(entry.vv, this.nodeId);
    return this.capture('set', key, value, entry.vv);
  }

  lock(key) {
    const def = this.schema.params.get(key);
    if (!def) throw new ValidationError(`unknown param '${key}'`);
    const entry = this.state.get(key);
    if (entry.locked) throw new ValidationError(`param '${key}' already locked`, { key });
    entry.locked = true;
    entry.vv = vvBump(entry.vv, this.nodeId);
    return this.capture('lock', key, undefined, entry.vv);
  }

  unlock(key) {
    const def = this.schema.params.get(key);
    if (!def) throw new ValidationError(`unknown param '${key}'`);
    const entry = this.state.get(key);
    if (!entry.locked) throw new ValidationError(`param '${key}' is not locked`, { key });
    entry.locked = false;
    entry.vv = vvBump(entry.vv, this.nodeId);
    return this.capture('unlock', key, undefined, entry.vv);
  }

  // Apply a captured delta without re-validating (used by replay/merge).
  applyDelta(d) {
    const entry = this.state.get(d.key);
    if (!entry) throw new ValidationError(`unknown param '${d.key}'`);
    if (d.op === 'set') entry.value = d.value;
    else if (d.op === 'lock') entry.locked = true;
    else if (d.op === 'unlock') entry.locked = false;
    else throw new ValidationError(`unknown op '${d.op}'`);
    entry.vv = { ...d.vv };
    this.seq = Math.max(this.seq, d.seq || 0);
  }

  snapshot() {
    const params = {};
    for (const [k, e] of this.state) {
      params[k] = { value: e.value, locked: e.locked, vv: { ...e.vv } };
    }
    return { nodeId: this.nodeId, seq: this.seq, params };
  }

  static fromSnapshot(schema, snap) {
    const store = new ParamStore(schema, snap.nodeId);
    for (const [k, v] of Object.entries(snap.params || {})) {
      if (!store.state.has(k)) continue;
      store.state.set(k, { value: v.value, locked: !!v.locked, vv: { ...(v.vv || {}) } });
    }
    store.seq = snap.seq || 0;
    return store;
  }
}

export function defaultValue(def) {
  if (def.type === 'number') return def.min !== undefined ? def.min : 0;
  if (def.type === 'boolean') return false;
  return '';
}
