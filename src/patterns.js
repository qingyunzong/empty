import { InputError } from './errors.js';

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(literal) {
  return literal.replace(REGEX_SPECIALS, '\\$&');
}

function wildcardToRegExp(source) {
  let body = '';
  for (const ch of source) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else body += escapeRegex(ch);
  }
  return new RegExp(`^(?:${body})$`);
}

export function compilePattern(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new InputError('pattern must be an object');
  }
  const { id, type, value } = spec;
  if (typeof id !== 'string' || id.length === 0) {
    throw new InputError('pattern id must be a non-empty string');
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(`pattern ${id}: value must be a non-empty string`);
  }
  switch (type) {
    case 'substring':
      return { id, type, value, test: (text) => text === value };
    case 'wildcard': {
      const re = wildcardToRegExp(value);
      return { id, type, value, test: (text) => re.test(text) };
    }
    case 'regex': {
      let re;
      try {
        re = new RegExp(`^(?:${value})$`);
      } catch {
        throw new InputError(`pattern ${id}: invalid regex: ${value}`);
      }
      return { id, type, value, test: (text) => re.test(text) };
    }
    default:
      throw new InputError(`pattern ${id}: unknown type: ${String(type)}`);
  }
}

export function compilePatterns(specs) {
  if (!Array.isArray(specs)) {
    throw new InputError('patterns must be an array');
  }
  const seen = new Set();
  return specs.map((spec) => {
    const compiled = compilePattern(spec);
    if (seen.has(compiled.id)) {
      throw new InputError(`duplicate pattern id: ${compiled.id}`);
    }
    seen.add(compiled.id);
    return compiled;
  });
}
