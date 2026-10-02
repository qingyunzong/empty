import { ValidationError } from './errors.js';
import { parseExpression, referencedKeys } from './expr.js';

const TYPES = new Set(['number', 'boolean', 'string']);

// A schema is an ordered list of param definitions:
// { key, type, min?, max?, interlock?, safety? }
export function compileSchema(defs) {
  if (!Array.isArray(defs) || defs.length === 0) {
    throw new ValidationError('schema: defs must be a non-empty array');
  }
  const params = new Map();
  for (const def of defs) {
    if (!def || typeof def.key !== 'string' || def.key === '') {
      throw new ValidationError('schema: every param needs a non-empty string key');
    }
    if (params.has(def.key)) {
      throw new ValidationError(`schema: duplicate key '${def.key}'`);
    }
    if (!TYPES.has(def.type)) {
      throw new ValidationError(`schema: '${def.key}' has unknown type`, { type: def.type });
    }
    if (def.type === 'number') {
      if (def.min !== undefined && typeof def.min !== 'number') {
        throw new ValidationError(`schema: '${def.key}' min must be a number`);
      }
      if (def.max !== undefined && typeof def.max !== 'number') {
        throw new ValidationError(`schema: '${def.key}' max must be a number`);
      }
      if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
        throw new ValidationError(`schema: '${def.key}' min > max`);
      }
    } else if (def.min !== undefined || def.max !== undefined) {
      throw new ValidationError(`schema: '${def.key}' min/max only valid for numbers`);
    }
    let ast = null;
    if (def.interlock !== undefined) {
      ast = parseExpression(def.interlock);
    }
    params.set(def.key, {
      key: def.key,
      type: def.type,
      min: def.min,
      max: def.max,
      interlock: def.interlock,
      ast,
      safety: def.safety === true,
    });
  }
  // Interlock references must resolve to declared keys.
  for (const p of params.values()) {
    if (p.ast) {
      for (const ref of referencedKeys(p.ast)) {
        if (!params.has(ref)) {
          throw new ValidationError(`schema: interlock of '${p.key}' references unknown key '${ref}'`);
        }
      }
    }
  }
  return { params };
}

export function checkType(def, value) {
  const ok =
    (def.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (def.type === 'boolean' && typeof value === 'boolean') ||
    (def.type === 'string' && typeof value === 'string');
  if (!ok) {
    throw new ValidationError(`param '${def.key}': expected ${def.type}`, { value });
  }
}

export function checkRange(def, value) {
  if (def.type !== 'number') return;
  if (def.min !== undefined && value < def.min) {
    throw new ValidationError(`param '${def.key}': ${value} < min ${def.min}`, { key: def.key, value, min: def.min });
  }
  if (def.max !== undefined && value > def.max) {
    throw new ValidationError(`param '${def.key}': ${value} > max ${def.max}`, { key: def.key, value, max: def.max });
  }
}
