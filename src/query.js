import { tokenize } from './tokenize.js';
import { IndexError, E_TOKEN, E_SPAN } from './errors.js';

const NEAR_RE = /^\s*(\S+)\s+NEAR\/(\S+)\s+(\S+)\s*$/;
const MAX_SPAN = 1024;

// Query forms:
//   "泵 气蚀"          phrase (quotes optional for multi-term input)
//   泵                 single term
//   原因码 NEAR/4 处理码  proximity: at most k words between the two terms
export function parseQuery(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new IndexError(E_TOKEN, 'empty query');
  }
  const near = NEAR_RE.exec(input);
  if (near) {
    const k = Number(near[2]);
    if (!Number.isInteger(k) || k < 0 || k > MAX_SPAN) {
      throw new IndexError(E_SPAN, `invalid span limit: ${near[2]}`);
    }
    return { type: 'near', a: singleTerm(near[1]), b: singleTerm(near[3]), k };
  }
  if (/NEAR\//i.test(input)) {
    throw new IndexError(E_SPAN, `malformed NEAR query: ${input}`);
  }
  let text = input.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  const { tokens } = tokenize(text);
  if (tokens.length === 0) {
    throw new IndexError(E_TOKEN, 'query contains no searchable term');
  }
  if (tokens.length === 1) return { type: 'term', term: tokens[0] };
  return { type: 'phrase', tokens };
}

function singleTerm(raw) {
  const { tokens } = tokenize(raw);
  if (tokens.length !== 1) {
    throw new IndexError(E_TOKEN, `expected a single term, got: ${raw}`);
  }
  return tokens[0];
}
