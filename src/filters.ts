import { TemplateError, type SourcePosition } from './errors.js';

export type FilterFn = (value: unknown, args: readonly unknown[]) => unknown;

function expectText(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new Error(`filter "${name}" expects a string, number or boolean, got ${value === null ? 'null' : typeof value}`);
}

function expectArray(value: unknown, name: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`filter "${name}" expects an array, got ${value === null ? 'null' : typeof value}`);
}

export const builtinFilters: Readonly<Record<string, FilterFn>> = Object.freeze({
  upper: (value) => expectText(value, 'upper').toUpperCase(),
  lower: (value) => expectText(value, 'lower').toLowerCase(),
  trim: (value) => expectText(value, 'trim').trim(),
  length: (value) => {
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    throw new Error(`filter "length" expects a string or array, got ${value === null ? 'null' : typeof value}`);
  },
  join: (value, args) => {
    const sep = args.length === 0 ? ',' : expectText(args[0], 'join');
    return expectArray(value, 'join').map((item) => (item === null || item === undefined ? '' : expectText(item, 'join'))).join(sep);
  },
  default: (value, args) => (value === null || value === undefined || value === '' ? (args[0] ?? '') : value),
});

export function resolveFilter(
  name: string,
  custom: Readonly<Record<string, FilterFn>> | undefined,
  pos: SourcePosition,
): FilterFn {
  const fn = (custom && Object.prototype.hasOwnProperty.call(custom, name) ? custom[name] : undefined) ??
    (Object.prototype.hasOwnProperty.call(builtinFilters, name) ? builtinFilters[name] : undefined);
  if (typeof fn !== 'function') {
    throw new TemplateError('UNKNOWN_FILTER', `unknown filter "${name}"`, pos);
  }
  return fn;
}
