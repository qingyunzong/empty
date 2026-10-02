import { FormulaError } from './errors.js';

const BINARY_BP = {
  '<': 5, '<=': 5, '>': 5, '>=': 5, '==': 5, '!=': 5,
  '+': 10, '-': 10,
  '*': 20, '/': 20,
  '^': 40,
};
const UNARY_MINUS_BP = 30;

function lex(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i])) i++;
      if (source[i] === '.') { i++; while (i < source.length && /[0-9]/.test(source[i])) i++; }
      if (source[i] === 'e' || source[i] === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j++;
        if (/[0-9]/.test(source[j] ?? '')) { i = j; while (i < source.length && /[0-9]/.test(source[i])) i++; }
      }
      const text = source.slice(start, i);
      tokens.push({ type: 'num', value: Number(text), start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      tokens.push({ type: 'ident', value: source.slice(start, i), start, end: i });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) {
      tokens.push({ type: 'op', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ('+-*/^()<>='.includes(ch)) {
      tokens.push({ type: 'op', value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new FormulaError('PARSE_TOKEN', `unexpected character "${ch}" at offset ${i}`, {
      position: { start: i, end: i + 1 },
    });
  }
  tokens.push({ type: 'eof', value: null, start: source.length, end: source.length });
  return tokens;
}

export function parse(source) {
  const tokens = lex(source);
  let pos = 0;
  const openParens = [];

  const peek = () => tokens[pos];

  function expectClose(openToken) {
    const t = peek();
    if (t.type === 'op' && t.value === ')') { pos++; return t; }
    throw new FormulaError(
      'PARSE_PAREN',
      `missing ")" for "(" at offset ${openToken.start}`,
      { position: { start: openToken.start, end: openToken.end } },
    );
  }

  function parsePrefix() {
    const t = tokens[pos++];
    if (t.type === 'num') return { type: 'num', value: t.value, start: t.start, end: t.end };
    if (t.type === 'ident') {
      const next = peek();
      if (next.type === 'op' && next.value === '(') {
        pos++;
        openParens.push(next);
        const arg = parseExpr(0);
        const close = expectClose(next);
        openParens.pop();
        return { type: 'call', fn: t.value, arg, start: t.start, end: close.end };
      }
      return { type: 'var', name: t.value, start: t.start, end: t.end };
    }
    if (t.type === 'op' && t.value === '(') {
      openParens.push(t);
      const inner = parseExpr(0);
      expectClose(t);
      openParens.pop();
      return inner;
    }
    if (t.type === 'op' && t.value === '-') {
      const arg = parseExpr(UNARY_MINUS_BP);
      return { type: 'neg', arg, start: t.start, end: arg.end };
    }
    if (t.type === 'op' && t.value === ')') {
      throw new FormulaError('PARSE_PAREN', `unmatched ")" at offset ${t.start}`, {
        position: { start: t.start, end: t.end },
      });
    }
    if (t.type === 'eof') {
      if (openParens.length > 0) {
        const open = openParens[openParens.length - 1];
        throw new FormulaError(
          'PARSE_PAREN',
          `missing ")" for "(" at offset ${open.start}`,
          { position: { start: open.start, end: open.end } },
        );
      }
      throw new FormulaError('PARSE_EOF', 'unexpected end of expression', {
        position: { start: t.start, end: t.end },
      });
    }
    throw new FormulaError('PARSE_TOKEN', `unexpected token "${t.value}" at offset ${t.start}`, {
      position: { start: t.start, end: t.end },
    });
  }

  function parseExpr(minBp) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.type !== 'op' || !(t.value in BINARY_BP)) break;
      const bp = BINARY_BP[t.value];
      if (bp < minBp) break;
      pos++;
      const rbp = t.value === '^' ? bp : bp + 1;
      const right = parseExpr(rbp);
      left = { type: 'bin', op: t.value, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  let ast = parseExpr(0);
  let rest = peek();
  if (rest.type === 'op' && rest.value === '=') {
    if (ast.type !== 'var') {
      throw new FormulaError('PARSE_TOKEN', 'left side of "=" must be a variable', {
        position: { start: rest.start, end: rest.end },
      });
    }
    pos++;
    const right = parseExpr(0);
    ast = { type: 'assign', target: ast, right, start: ast.start, end: right.end };
    rest = peek();
  }
  if (rest.type !== 'eof') {
    if (rest.type === 'op' && rest.value === ')') {
      throw new FormulaError('PARSE_PAREN', `unmatched ")" at offset ${rest.start}`, {
        position: { start: rest.start, end: rest.end },
      });
    }
    throw new FormulaError('PARSE_TOKEN', `unexpected token "${rest.value}" at offset ${rest.start}`, {
      position: { start: rest.start, end: rest.end },
    });
  }
  return ast;
}
