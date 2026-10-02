import { TemplateError, ErrorCode } from './errors.js';

export const filters = Object.freeze({
  upper: { types: ['string'], fn: (value) => value.toUpperCase() },
  lower: { types: ['string'], fn: (value) => value.toLowerCase() },
  trim: { types: ['string'], fn: (value) => value.trim() },
  length: { types: ['string', 'array'], fn: (value) => value.length },
  join: { types: ['array'], fn: (value, sep = ',') => value.join(sep) },
});

export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function applyFilter(name, value, args) {
  const filter = filters[name];
  if (!filter) {
    throw new TemplateError(ErrorCode.UNKNOWN_FILTER, `unknown filter "${name}"`);
  }
  const actual = typeOf(value);
  if (!filter.types.includes(actual)) {
    throw new TemplateError(
      ErrorCode.FILTER_TYPE,
      `filter "${name}" does not support type "${actual}" (expects ${filter.types.join(' or ')})`,
    );
  }
  return filter.fn(value, ...args);
}
