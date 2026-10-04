import { SyncError } from './errors.js';
import { parseExpression, evaluate, unevaluable, identifiers } from './interlock.js';

const TYPES = new Set(['number', 'boolean', 'string']);

export class ParamRegistry {
  constructor(defs) {
    if (!Array.isArray(defs) || defs.length === 0) {
      throw new SyncError('VALIDATION', 'registry requires a non-empty defs array');
    }
    this.defs = new Map();
    for (const d of defs) {
      if (!d || typeof d.key !== 'string' || d.key === '') {
        throw new SyncError('VALIDATION', 'param def requires a key');
      }
      if (this.defs.has(d.key)) throw new SyncError('VALIDATION', `duplicate param: ${d.key}`);
      const type = d.type ?? 'number';
      if (!TYPES.has(type)) throw new SyncError('VALIDATION', `bad type for ${d.key}: ${type}`);
      if (type === 'number' && d.min !== undefined && d.max !== undefined && d.min > d.max) {
        throw new SyncError('VALIDATION', `min>max for ${d.key}`);
      }
      let ast = null;
      if (d.interlock !== undefined && d.interlock !== null) {
        ast = parseExpression(d.interlock);
      }
      this.defs.set(d.key, {
        key: d.key,
        type,
        min: d.min,
        max: d.max,
        safetyCritical: Boolean(d.safetyCritical),
        interlock: ast,
        interlockSrc: d.interlock ?? null,
      });
    }
    // Every identifier referenced by an interlock must be a known param.
    for (const def of this.defs.values()) {
      if (!def.interlock) continue;
      for (const name of identifiers(def.interlock)) {
        if (!this.defs.has(name)) {
          throw new SyncError('VALIDATION', `interlock of ${def.key} references unknown param ${name}`);
        }
      }
    }
  }

  get(key) {
    return this.defs.get(key);
  }

  validateValue(key, value) {
    const def = this.defs.get(key);
    if (!def) throw new SyncError('VALIDATION', `unknown param: ${key}`);
    if (typeof value !== def.type) {
      throw new SyncError('VALIDATION', `type mismatch for ${key}: want ${def.type}, got ${typeof value}`);
    }
    if (def.type === 'number') {
      if (!Number.isFinite(value)) throw new SyncError('VALIDATION', `non-finite value for ${key}`);
      if (def.min !== undefined && value < def.min) {
        throw new SyncError('VALIDATION', `out of range: ${key}=${value} < min ${def.min}`);
      }
      if (def.max !== undefined && value > def.max) {
        throw new SyncError('VALIDATION', `out of range: ${key}=${value} > max ${def.max}`);
      }
    }
  }

  // Validate every interlock whose referenced params are all present.
  validateState(values) {
    for (const def of this.defs.values()) {
      if (!def.interlock) continue;
      if (unevaluable(def.interlock, values)) continue;
      if (!evaluate(def.interlock, values)) {
        throw new SyncError('VALIDATION', `interlock violated: ${def.key}: ${def.interlockSrc}`);
      }
    }
  }

  // Keys whose current value is dangerous: out of range, wrong type, or
  // participating in a violated interlock. Used by safe-set enforcement.
  dangerousKeys(values) {
    const bad = new Set();
    for (const [key, value] of Object.entries(values)) {
      try {
        this.validateValue(key, value);
      } catch {
        bad.add(key);
      }
    }
    for (const def of this.defs.values()) {
      if (!def.interlock || unevaluable(def.interlock, values)) continue;
      let ok = false;
      try { ok = evaluate(def.interlock, values); } catch { ok = false; }
      if (!ok) {
        bad.add(def.key);
        for (const name of identifiers(def.interlock)) bad.add(name);
      }
    }
    return bad;
  }
}
