export const NODE_SCHEMA = Object.freeze({
  type: Object.freeze({ kind: 'enum', values: Object.freeze(['raw', 'semi', 'finished']), required: true }),
  date: Object.freeze({ kind: 'date', required: true }),
  name: Object.freeze({ kind: 'string', required: false }),
});

export const EDGE_TYPES = Object.freeze(['derives_from']);
export const DEFAULT_EDGE_TYPE = 'derives_from';

export const LOT_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d{4}-\d{4,}$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(text) {
  if (typeof text !== 'string' || !DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

export function validateAttrs(attrs) {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return "'attrs' must be an object";
  }
  for (const [key, spec] of Object.entries(NODE_SCHEMA)) {
    const value = attrs[key];
    if (value === undefined) {
      if (spec.required) return `missing required attribute '${key}'`;
      continue;
    }
    if (spec.kind === 'enum' && !spec.values.includes(value)) {
      return `attribute '${key}' must be one of: ${spec.values.join(', ')}`;
    }
    if (spec.kind === 'date' && !isValidDate(value)) {
      return `attribute '${key}' must be a valid YYYY-MM-DD date`;
    }
    if (spec.kind === 'string' && typeof value !== 'string') {
      return `attribute '${key}' must be a string`;
    }
  }
  for (const key of Object.keys(attrs)) {
    if (!(key in NODE_SCHEMA)) return `unknown attribute '${key}'`;
  }
  return null;
}
